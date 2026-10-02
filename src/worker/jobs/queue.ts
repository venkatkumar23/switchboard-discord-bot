// Durable outbox on D1. A job is claimed with a lease (so the waitUntil path and the cron
// runner can never execute it concurrently), retried with exponential backoff, and
// dead-lettered after max_attempts so a human can see it and press "retry".
import type { JobType } from "../../shared/types";
import type { JobRow } from "../db/rows";

export const MAX_ATTEMPTS: Record<JobType, number> = {
  triage: 5,
  reply: 5, // the interaction token dies after 15 minutes anyway
  post: 6,
  mirror: 8, // ~1 hour of backoff: rides out a real Slack/Discord incident
  enrich: 5,
};

/** Longer than any single handler can run (waitUntil is capped at 30 s after the response). */
export const LEASE_MS = 60_000;

const BASE_DELAY_MS = 30_000;
const MAX_DELAY_MS = 30 * 60_000;

/** 30s, 1m, 2m, 4m … capped at 30m, with ±20% jitter so retries don't stampede. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const delay = Math.min(BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1), MAX_DELAY_MS);
  return Math.round(delay * (0.8 + random() * 0.4));
}

export interface NewJob {
  id: string;
  type: JobType;
  guildId: string | null;
  reportId?: number | null;
  interactionId?: string | null;
  payload?: Record<string, unknown>;
  runAfter?: number;
}

/** Idempotent: re-enqueueing an existing job id is a no-op. */
export function enqueueStatement(db: D1Database, job: NewJob, now: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO jobs (id, guild_id, report_id, interaction_id, type, payload, status, attempts, max_attempts,
                         run_after, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .bind(
      job.id,
      job.guildId,
      job.reportId ?? null,
      job.interactionId ?? null,
      job.type,
      JSON.stringify(job.payload ?? {}),
      MAX_ATTEMPTS[job.type],
      job.runAfter ?? now,
      now,
      now,
    );
}

const CLAIMABLE = `attempts < max_attempts AND (
  (status IN ('pending', 'retrying') AND run_after <= ?1) OR
  (status = 'running' AND locked_until < ?1)
)`;

/** Atomically takes the lease on a due job. Returns null if it's not due or someone else holds it. */
export function claimJob(db: D1Database, id: string, now: number): Promise<JobRow | null> {
  return db
    .prepare(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_until = ?2, updated_at = ?1
       WHERE id = ?3 AND ${CLAIMABLE}
       RETURNING *`,
    )
    .bind(now, now + LEASE_MS, id)
    .first<JobRow>();
}

export async function dueJobIds(db: D1Database, now: number, limit: number): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT id FROM jobs WHERE ${CLAIMABLE} ORDER BY run_after LIMIT ?2`)
    .bind(now, limit)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

export function succeededStatement(db: D1Database, job: JobRow, now: number): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE jobs SET status = 'succeeded', locked_until = NULL, last_error = NULL, updated_at = ?, finished_at = ?
       WHERE id = ? AND status = 'running'`,
    )
    .bind(now, now, job.id);
}

export function retryStatement(db: D1Database, job: JobRow, error: string, runAfter: number, now: number) {
  return db
    .prepare(
      `UPDATE jobs SET status = 'retrying', run_after = ?, locked_until = NULL, last_error = ?, updated_at = ?
       WHERE id = ? AND status = 'running'`,
    )
    .bind(runAfter, error, now, job.id);
}

export function deadStatement(db: D1Database, job: JobRow, error: string, now: number) {
  return db
    .prepare(
      `UPDATE jobs SET status = 'dead', locked_until = NULL, last_error = ?, updated_at = ?, finished_at = ?
       WHERE id = ? AND status = 'running'`,
    )
    .bind(error, now, now, job.id);
}

/** A run that crashed on its final attempt can't be reclaimed; surface it as dead instead. */
export function sweepExhaustedStatement(db: D1Database, now: number): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE jobs SET status = 'dead', locked_until = NULL, finished_at = ?1, updated_at = ?1,
              last_error = COALESCE(last_error, 'worker stopped during the final attempt')
       WHERE status = 'running' AND locked_until < ?1 AND attempts >= max_attempts`,
    )
    .bind(now);
}

/** Manual retry from the dashboard: give a dead job a few more attempts, due now. */
export function requeueStatement(db: D1Database, jobId: string, guildId: string, now: number): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE jobs SET status = 'retrying', run_after = ?1, locked_until = NULL, updated_at = ?1,
              max_attempts = MAX(max_attempts, attempts + 3), finished_at = NULL
       WHERE id = ?2 AND guild_id = ?3 AND status IN ('dead', 'retrying')
       RETURNING *`,
    )
    .bind(now, jobId, guildId);
}
