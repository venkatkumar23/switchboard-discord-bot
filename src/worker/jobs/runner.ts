import type { JobType } from "../../shared/types";
import type { JobRow } from "../db/rows";
import { eventStatement, type NewEvent } from "../db/queries";
import type { Env } from "../env";
import { PermanentError, RetryableError, errorMessage } from "../lib/errors";
import { log, redactString } from "../lib/log";
import {
  backoffMs,
  claimJob,
  deadStatement,
  dueJobIds,
  enqueueStatement,
  retryStatement,
  succeededStatement,
  sweepExhaustedStatement,
  type NewJob,
} from "./queue";

export interface JobContext {
  env: Env;
  now: () => number;
  /** Public origin of the dashboard, for links in mirrored messages. */
  appUrl: string | null;
}

export interface JobResult {
  /** Committed atomically together with marking the job succeeded. */
  statements?: D1PreparedStatement[];
  events?: Omit<NewEvent, "guildId" | "jobId">[];
  enqueue?: NewJob[];
}

export type JobHandler = (ctx: JobContext, job: JobRow) => Promise<JobResult | void>;

export const JOB_LABELS: Record<JobType, string> = {
  triage: "Triage",
  reply: "Reply to reporter",
  post: "Post to report channel",
  mirror: "Mirror notification",
  enrich: "AI triage retry",
};

/** Called when a job is dead-lettered, to keep the user-facing flow moving. */
export type DeadLetterHook = (ctx: JobContext, job: JobRow) => NewJob[];

export interface Registry {
  handlers: Record<JobType, JobHandler>;
  onDead?: Partial<Record<JobType, DeadLetterHook>>;
}

/**
 * Caps how many jobs one Worker invocation runs (follow-ups included). D1 allows 50 queries
 * per invocation on the free plan and a job costs ~3, so the cron tick stops well short.
 */
export class Budget {
  constructor(public remaining: number) {}
  take(): boolean {
    if (this.remaining <= 0) return false;
    this.remaining--;
    return true;
  }
}

function humanDelay(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 90 ? `${s}s` : `${Math.round(s / 60)}m`;
}

export async function runJob(ctx: JobContext, registry: Registry, id: string, budget: Budget): Promise<void> {
  if (!budget.take()) return; // still durable: the cron tick will pick it up
  const db = ctx.env.DB;
  const job = await claimJob(db, id, ctx.now());
  if (!job) return;

  const label = `${JOB_LABELS[job.type]}${job.report_id ? ` for report #${job.report_id}` : ""}`;
  const started = Date.now();
  let followUps: NewJob[] = [];
  try {
    const result = (await registry.handlers[job.type](ctx, job)) ?? {};
    followUps = result.enqueue ?? [];
    const now = ctx.now();
    await db.batch([
      ...(result.statements ?? []),
      ...(result.events ?? []).map((e) => eventStatement(db, { ...e, guildId: job.guild_id, jobId: job.id }, now)),
      succeededStatement(db, job, now),
      ...followUps.map((j) => enqueueStatement(db, j, now)),
    ]);
    log.info("job.succeeded", { jobId: job.id, type: job.type, attempt: job.attempts, ms: Date.now() - started });
  } catch (err) {
    await recordFailure(ctx, registry, job, err, label);
    return;
  }
  if (followUps.length) await runJobs(ctx, registry, followUps.map((j) => j.id), budget);
}

async function recordFailure(ctx: JobContext, registry: Registry, job: JobRow, err: unknown, label: string) {
  const db = ctx.env.DB;
  const now = ctx.now();
  const message = redactString(errorMessage(err)).slice(0, 500);
  const permanent = err instanceof PermanentError;
  const exhausted = job.attempts >= job.max_attempts;

  try {
    if (!permanent && !exhausted) {
      const requested = err instanceof RetryableError ? (err.retryAfterMs ?? 0) : 0;
      const delay = Math.max(backoffMs(job.attempts), requested);
      await db.batch([
        retryStatement(db, job, message, now + delay, now),
        eventStatement(
          db,
          {
            guildId: job.guild_id,
            kind: "job",
            name: `${job.type}.retrying`,
            level: "warn",
            message: `${label} failed (attempt ${job.attempts}/${job.max_attempts}): ${message} — retrying in ${humanDelay(delay)}`,
            reportId: job.report_id,
            jobId: job.id,
            data: { attempt: job.attempts, retryInMs: delay },
          },
          now,
        ),
      ]);
      log.warn("job.retrying", { jobId: job.id, type: job.type, attempt: job.attempts, error: message, delay });
      return;
    }

    const followUps = registry.onDead?.[job.type]?.(ctx, job) ?? [];
    await db.batch([
      deadStatement(db, job, message, now),
      eventStatement(
        db,
        {
          guildId: job.guild_id,
          kind: "job",
          name: `${job.type}.dead`,
          level: "error",
          message: `${label} gave up after ${job.attempts} attempt(s): ${message}`,
          reportId: job.report_id,
          jobId: job.id,
          data: { attempts: job.attempts, permanent },
        },
        now,
      ),
      ...followUps.map((j) => enqueueStatement(db, j, now)),
    ]);
    log.error("job.dead", { jobId: job.id, type: job.type, attempts: job.attempts, error: message });
  } catch (dbErr) {
    // The lease will expire and the cron runner will retry the job: nothing is lost.
    log.error("job.failure_not_recorded", { jobId: job.id, error: errorMessage(dbErr), original: message });
  }
}

export async function runJobs(ctx: JobContext, registry: Registry, ids: string[], budget: Budget): Promise<void> {
  await Promise.allSettled(ids.map((id) => runJob(ctx, registry, id, budget)));
}

/** Cron entry point: dead-letter crashed final attempts, then run whatever is due. */
export async function runDueJobs(ctx: JobContext, registry: Registry, maxJobs = 10): Promise<number> {
  const db = ctx.env.DB;
  const now = ctx.now();
  await sweepExhaustedStatement(db, now).run();
  const ids = await dueJobIds(db, now, maxJobs);
  if (ids.length) await runJobs(ctx, registry, ids, new Budget(maxJobs));
  return ids.length;
}
