// Small, reusable D1 statements. Anything that must happen atomically is returned as a
// prepared statement so callers can put it in a db.batch() (= one SQL transaction).
import {
  DEFAULT_COMMAND_SETTINGS,
  type CommandName,
  type CommandSettings,
  type EventKind,
  type EventLevel,
  type FaultName,
  type Faults,
  type Priority,
} from "../../shared/types";
import { redact, redactString } from "../lib/log";
import type { CommandConfigRow, GuildRow, ReportRow, RuleRow } from "./rows";
import { parseJson } from "./rows";

// ── Events (the dashboard's activity log) ───────────────────────────
export interface NewEvent {
  guildId: string | null;
  kind: EventKind;
  name: string;
  level?: EventLevel;
  message: string;
  interactionId?: string | null;
  reportId?: number | null;
  jobId?: string | null;
  data?: Record<string, unknown>;
}

export function eventStatement(db: D1Database, e: NewEvent, now: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO events (guild_id, interaction_id, report_id, job_id, kind, name, level, message, data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      e.guildId,
      e.interactionId ?? null,
      e.reportId ?? null,
      e.jobId ?? null,
      e.kind,
      e.name,
      e.level ?? "info",
      redactString(e.message).slice(0, 500),
      e.data ? JSON.stringify(redact(e.data)) : null,
      now,
    );
}

// ── Guilds ───────────────────────────────────────────────────────────
export function ensureGuildStatement(db: D1Database, guildId: string, now: number): D1PreparedStatement {
  return db
    .prepare("INSERT INTO guilds (id, created_at, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING")
    .bind(guildId, now, now);
}

export function getGuild(db: D1Database, guildId: string): Promise<GuildRow | null> {
  return db.prepare("SELECT * FROM guilds WHERE id = ?").bind(guildId).first<GuildRow>();
}

export function parseFaults(raw: string | null | undefined): Faults {
  return parseJson<Faults>(raw, {});
}

export function isFaultActive(faults: Faults, name: FaultName, now: number): boolean {
  const until = faults[name];
  return typeof until === "number" && until > now;
}

export const DEFAULT_RULES: { name: string; keywords: string[]; priority: Priority; mentionRole: boolean }[] = [
  {
    name: "Security incident",
    keywords: ["hacked", "hack", "phishing", "scam", "compromised", "token leak", "raid", "malware", "doxxed"],
    priority: "critical",
    mentionRole: true,
  },
  {
    name: "Outage",
    keywords: ["down", "outage", "not working", "broken", "crash", "crashed", "500", "can't log in", "cannot log in"],
    priority: "high",
    mentionRole: true,
  },
  {
    name: "Minor",
    keywords: ["typo", "cosmetic", "suggestion", "feature request", "nitpick"],
    priority: "low",
    mentionRole: false,
  },
];

/** Seeds a sensible starting rule set for a newly seen server. */
export function defaultRuleStatements(db: D1Database, guildId: string, now: number): D1PreparedStatement[] {
  return DEFAULT_RULES.map((r, position) =>
    db
      .prepare(
        `INSERT INTO rules (guild_id, name, keywords, priority, mention_role, enabled, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .bind(guildId, r.name, JSON.stringify(r.keywords), r.priority, r.mentionRole ? 1 : 0, position, now, now),
  );
}

// ── Command settings ────────────────────────────────────────────────
export function commandConfigStatement(db: D1Database, guildId: string, command: CommandName): D1PreparedStatement {
  return db.prepare("SELECT * FROM command_configs WHERE guild_id = ? AND command = ?").bind(guildId, command);
}

export function toCommandSettings(row: CommandConfigRow | null | undefined, command: CommandName): CommandSettings {
  if (!row) return { ...DEFAULT_COMMAND_SETTINGS[command] };
  return {
    enabled: row.enabled === 1,
    ephemeral: row.ephemeral === 1,
    postToChannel: row.post_to_channel === 1,
    mirror: row.mirror === 1,
    cooldownSeconds: row.cooldown_seconds,
  };
}

// ── Rules / reports ─────────────────────────────────────────────────
export function rulesStatement(db: D1Database, guildId: string): D1PreparedStatement {
  return db.prepare("SELECT * FROM rules WHERE guild_id = ? ORDER BY position, id").bind(guildId);
}

export function toRule(row: RuleRow) {
  return {
    id: row.id,
    name: row.name,
    keywords: parseJson<string[]>(row.keywords, []),
    priority: row.priority,
    mentionRole: row.mention_role === 1,
    enabled: row.enabled === 1,
    position: row.position,
  };
}

export function getReport(db: D1Database, reportId: number, guildId?: string): Promise<ReportRow | null> {
  return guildId
    ? db.prepare("SELECT * FROM reports WHERE id = ? AND guild_id = ?").bind(reportId, guildId).first<ReportRow>()
    : db.prepare("SELECT * FROM reports WHERE id = ?").bind(reportId).first<ReportRow>();
}

// ── Security counters ───────────────────────────────────────────────
const HOUR_MS = 3_600_000;

export function recordSecurity(db: D1Database, reason: string, now: number): Promise<unknown> {
  const bucket = now - (now % HOUR_MS);
  return db
    .prepare(
      `INSERT INTO security_counters (bucket, reason, count, last_seen) VALUES (?, ?, 1, ?)
       ON CONFLICT(bucket, reason) DO UPDATE SET count = count + 1, last_seen = excluded.last_seen`,
    )
    .bind(bucket, reason, now)
    .run()
    .catch(() => undefined); // metrics must never break request handling
}
