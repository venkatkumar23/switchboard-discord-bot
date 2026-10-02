import type { Env } from "./env";
import { registry } from "./jobs/handlers";
import { runDueJobs } from "./jobs/runner";
import { errorMessage } from "./lib/errors";
import { log } from "./lib/log";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const RETENTION = 30 * DAY;

/** Every minute: re-drive due/retrying jobs, then housekeeping. */
export async function runScheduled(env: Env, scheduledTime: number): Promise<void> {
  try {
    const ran = await runDueJobs({ env, now: Date.now, appUrl: env.APP_URL || null }, registry);
    if (ran) log.info("cron.jobs", { ran });
  } catch (err) {
    log.error("cron.jobs_failed", { error: errorMessage(err) });
  }

  const db = env.DB;
  const now = Date.now();
  try {
    // Interaction tokens are credentials for 15 minutes; don't keep them past that.
    await db.prepare("UPDATE interactions SET token = NULL WHERE token IS NOT NULL AND created_at < ?").bind(now - 16 * MINUTE).run();

    if (new Date(scheduledTime).getUTCMinutes() === 0) {
      await db.batch([
        db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
        db.prepare("DELETE FROM oauth_states WHERE expires_at < ?").bind(now),
        db.prepare("DELETE FROM login_throttle WHERE window_start < ?").bind(now - DAY),
        db.prepare("DELETE FROM events WHERE created_at < ?").bind(now - RETENTION),
        db.prepare("DELETE FROM security_counters WHERE bucket < ?").bind(now - RETENTION),
        db.prepare("DELETE FROM jobs WHERE status = 'succeeded' AND finished_at < ?").bind(now - RETENTION),
      ]);
    }
  } catch (err) {
    log.error("cron.housekeeping_failed", { error: errorMessage(err) });
  }
}
