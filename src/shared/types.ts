// Types and constants shared by the Worker and the dashboard.
// Nothing in here may ever carry a secret: it is bundled into client-side code.

export const PRIORITIES = ["low", "normal", "high", "critical"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PRIORITY_RANK: Record<Priority, number> = { low: 0, normal: 1, high: 2, critical: 3 };

export const REPORT_STATUSES = ["open", "acknowledged", "resolved"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const COMMAND_NAMES = ["report", "status"] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];

export const JOB_TYPES = ["triage", "reply", "post", "mirror", "enrich"] as const;
export type JobType = (typeof JOB_TYPES)[number];
export type JobStatus = "pending" | "running" | "retrying" | "succeeded" | "dead";

export const AI_CATEGORIES = ["bug", "outage", "security", "abuse", "question", "feedback", "other"] as const;
export type AiCategory = (typeof AI_CATEGORIES)[number];
export type AiStatus = "pending" | "done" | "failed" | "skipped";

export type EventKind = "command" | "action" | "job" | "config" | "security";
export type EventLevel = "info" | "warn" | "error";

export interface CommandSettings {
  enabled: boolean;
  /** Reply only visible to the person who ran the command. */
  ephemeral: boolean;
  /** /report only: post the report (with buttons) to the server's report channel. */
  postToChannel: boolean;
  /** Mirror a notification to the server's Slack/Discord webhook. */
  mirror: boolean;
  /** Per-user cooldown between uses; 0 disables it. */
  cooldownSeconds: number;
}

export interface CommandConfigDTO extends CommandSettings {
  command: CommandName;
  description: string;
}

export const DEFAULT_COMMAND_SETTINGS: Record<CommandName, CommandSettings> = {
  report: { enabled: true, ephemeral: true, postToChannel: true, mirror: true, cooldownSeconds: 10 },
  status: { enabled: true, ephemeral: true, postToChannel: false, mirror: false, cooldownSeconds: 0 },
};

export const FAULT_NAMES = ["mirrorDown", "aiDown", "aiSlow"] as const;
export type FaultName = (typeof FAULT_NAMES)[number];
/** Each fault is active until the stored epoch-ms timestamp. */
export type Faults = Partial<Record<FaultName, number>>;

export interface GuildSummaryDTO {
  id: string;
  name: string;
  iconUrl: string | null;
}

export interface MeDTO {
  email: string;
  guilds: GuildSummaryDTO[];
}

export interface GuildSettingsDTO extends GuildSummaryDTO {
  postChannelId: string | null;
  alertRoleId: string | null;
  mirror: { configured: boolean; kind: "slack" | "discord" | null; hint: string | null };
  moderatorsOnly: boolean;
  aiEnabled: boolean;
  /** Whether the server has an AI key configured at all. */
  aiAvailable: boolean;
  faults: Faults;
  connectedAt: number | null;
}

export interface ChannelDTO {
  id: string;
  name: string;
  category: string | null;
}

export interface RoleDTO {
  id: string;
  name: string;
  color: number;
  mentionable: boolean;
}

export interface RuleDTO {
  id: number;
  name: string;
  keywords: string[];
  priority: Priority;
  mentionRole: boolean;
  enabled: boolean;
  position: number;
}

export interface RuleTestResultDTO {
  matched: { ruleId: number; ruleName: string; keyword: string } | null;
  priority: Priority;
  mentionRole: boolean;
}

export interface EventDTO {
  id: number;
  kind: EventKind;
  name: string;
  level: EventLevel;
  message: string;
  reportId: number | null;
  interactionId: string | null;
  jobId: string | null;
  data: Record<string, unknown> | null;
  createdAt: number;
}

export interface JobDTO {
  id: string;
  type: JobType;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  runAfter: number;
  lastError: string | null;
  reportId: number | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

export interface ReportDTO {
  id: number;
  status: ReportStatus;
  priority: Priority | null;
  prioritySource: "rule" | "ai" | "default" | null;
  ruleName: string | null;
  matchedKeyword: string | null;
  title: string | null;
  body: string;
  userId: string;
  userName: string;
  ai: {
    status: AiStatus;
    summary: string | null;
    category: string | null;
    severity: Priority | null;
    tags: string[];
    error: string | null;
  };
  postedMessageUrl: string | null;
  ackedBy: string | null;
  ackedAt: number | null;
  resolvedBy: string | null;
  resolvedAt: number | null;
  createdAt: number;
  updatedAt: number;
  /** Latest status of each pipeline step (absent = not applicable). */
  steps: Partial<Record<JobType, JobStatus>>;
}

export interface ReportDetailDTO {
  report: ReportDTO;
  jobs: JobDTO[];
  events: EventDTO[];
}

export interface StatsDTO {
  commands24h: number;
  reports24h: number;
  openReports: number;
  openByPriority: Record<Priority, number>;
  jobs: { pending: number; retrying: number; dead: number; succeeded24h: number };
  duplicates24h: number;
}

export interface SecurityCounterDTO {
  reason: string;
  count: number;
  lastSeen: number;
}

export interface HealthDTO {
  ok: boolean;
  db: "ok" | "error";
  time: number;
}
