-- Switchboard schema. All timestamps are epoch milliseconds.

-- ── Dashboard accounts ───────────────────────────────────────────────
CREATE TABLE admins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,                    -- pbkdf2_sha256$<iterations>$<salt>$<hash>
  created_at    INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,                   -- SHA-256 of the cookie value; raw token is never stored
  admin_id    INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX sessions_by_expiry ON sessions(expires_at);

CREATE TABLE login_throttle (
  key           TEXT PRIMARY KEY,                 -- client IP
  failures      INTEGER NOT NULL,
  window_start  INTEGER NOT NULL
);

-- CSRF state for the "Connect a server" OAuth flow.
CREATE TABLE oauth_states (
  state_hash  TEXT PRIMARY KEY,
  admin_id    INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL
);

-- ── Tenants: one row per Discord server ──────────────────────────────
CREATE TABLE guilds (
  id               TEXT PRIMARY KEY,              -- Discord guild id
  name             TEXT NOT NULL DEFAULT '',
  icon             TEXT,
  post_channel_id  TEXT,                          -- where reports are posted (with buttons)
  alert_role_id    TEXT,                          -- pinged for rules that ask for it / critical reports
  mirror_url_enc   TEXT,                          -- AES-GCM ciphertext of the Slack/Discord webhook URL
  mirror_kind      TEXT CHECK (mirror_kind IN ('slack', 'discord')),
  mirror_hint      TEXT,                          -- masked form, safe to show in the dashboard
  moderators_only  INTEGER NOT NULL DEFAULT 1,    -- report buttons require Manage Messages
  ai_enabled       INTEGER NOT NULL DEFAULT 1,
  faults           TEXT NOT NULL DEFAULT '{}',    -- fault-injection switches (each with an expiry)
  connected_at     INTEGER,                       -- set once an admin connects it via OAuth
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE admin_guilds (
  admin_id    INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  guild_id    TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (admin_id, guild_id)
);
CREATE INDEX admin_guilds_by_guild ON admin_guilds(guild_id);

-- Per-server command behaviour. Missing rows mean "use the defaults".
CREATE TABLE command_configs (
  guild_id          TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  command           TEXT NOT NULL,
  enabled           INTEGER NOT NULL,
  ephemeral         INTEGER NOT NULL,
  post_to_channel   INTEGER NOT NULL,
  mirror            INTEGER NOT NULL,
  cooldown_seconds  INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (guild_id, command)
);

-- Keyword → priority rules applied to every /report.
CREATE TABLE rules (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id      TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  keywords      TEXT NOT NULL,                    -- JSON array of lowercase words/phrases
  priority      TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'critical')),
  mention_role  INTEGER NOT NULL DEFAULT 0,
  enabled       INTEGER NOT NULL DEFAULT 1,
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX rules_by_guild ON rules(guild_id, position);

-- ── What happened ────────────────────────────────────────────────────
-- Every accepted interaction. The primary key is Discord's interaction id: inserting it is
-- the dedup gate, so a redelivered/replayed interaction can never trigger work twice.
CREATE TABLE interactions (
  id          TEXT PRIMARY KEY,
  guild_id    TEXT,
  channel_id  TEXT,
  user_id     TEXT,
  user_name   TEXT,
  type        INTEGER NOT NULL,
  name        TEXT NOT NULL,                      -- report | status | button:ack | ...
  input       TEXT,                               -- JSON of the user's input
  token       TEXT,                               -- interaction token; wiped by cron once expired (15 min)
  response    TEXT,                               -- initial response, replayed for duplicate deliveries
  outcome     TEXT,                               -- deferred | replied | modal | updated | rejected:<why> | error
  created_at  INTEGER NOT NULL
);
CREATE INDEX interactions_by_guild ON interactions(guild_id, created_at);
CREATE INDEX interactions_by_user ON interactions(guild_id, user_id, name, created_at);
CREATE INDEX interactions_with_token ON interactions(created_at) WHERE token IS NOT NULL;

CREATE TABLE reports (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id           TEXT NOT NULL,
  interaction_id     TEXT NOT NULL UNIQUE REFERENCES interactions(id),
  source_channel_id  TEXT,
  user_id            TEXT NOT NULL,
  user_name          TEXT NOT NULL,
  title              TEXT,
  body               TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  priority           TEXT CHECK (priority IN ('low', 'normal', 'high', 'critical')),  -- NULL until triaged
  priority_source    TEXT,                        -- rule | ai | default
  rule_id            INTEGER,
  rule_name          TEXT,
  matched_keyword    TEXT,
  mention_role       INTEGER NOT NULL DEFAULT 0,
  ai_status          TEXT NOT NULL DEFAULT 'pending' CHECK (ai_status IN ('pending', 'done', 'failed', 'skipped')),
  ai_summary         TEXT,
  ai_category        TEXT,
  ai_severity        TEXT,
  ai_tags            TEXT,                        -- JSON array
  ai_error           TEXT,
  posted_channel_id  TEXT,
  posted_message_id  TEXT,
  acked_by           TEXT,
  acked_at           INTEGER,
  resolved_by        TEXT,
  resolved_at        INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX reports_by_guild ON reports(guild_id, id);
CREATE INDEX reports_by_status ON reports(guild_id, status);

-- Durable outbox. Every side effect (reply edit, channel post, mirror, AI) is a job that is
-- retried with exponential backoff until it succeeds or is dead-lettered.
CREATE TABLE jobs (
  id              TEXT PRIMARY KEY,               -- deterministic (e.g. 'post:42') so enqueueing is idempotent
  guild_id        TEXT,
  report_id       INTEGER,
  interaction_id  TEXT,
  type            TEXT NOT NULL,
  payload         TEXT NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'retrying', 'succeeded', 'dead')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL,
  run_after       INTEGER NOT NULL,
  locked_until    INTEGER,                        -- lease: a crashed run becomes claimable again
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  finished_at     INTEGER
);
CREATE INDEX jobs_due ON jobs(status, run_after);
CREATE INDEX jobs_by_guild ON jobs(guild_id, updated_at);
CREATE INDEX jobs_by_report ON jobs(report_id);

-- Append-only activity log behind the dashboard's live view.
CREATE TABLE events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id        TEXT,
  interaction_id  TEXT,
  report_id       INTEGER,
  job_id          TEXT,
  kind            TEXT NOT NULL,                  -- command | action | job | config | security
  name            TEXT NOT NULL,                  -- machine-readable, e.g. mirror.failed
  level           TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  message         TEXT NOT NULL,                  -- human-readable line
  data            TEXT,                           -- JSON details (never secrets)
  created_at      INTEGER NOT NULL
);
CREATE INDEX events_by_guild ON events(guild_id, id);
CREATE INDEX events_by_report ON events(report_id);

-- Requests rejected at the edge (bad signature, replay, malformed) and ignored duplicates,
-- aggregated per hour so a flood of junk costs one row per reason per hour.
CREATE TABLE security_counters (
  bucket     INTEGER NOT NULL,
  reason     TEXT NOT NULL,
  count      INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  PRIMARY KEY (bucket, reason)
);
