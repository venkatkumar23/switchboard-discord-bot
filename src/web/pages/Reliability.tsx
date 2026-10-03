import { useState } from "react";
import { FAULT_NAMES, type FaultName, type GuildSettingsDTO, type GuildSummaryDTO, type JobDTO, type SecurityCounterDTO } from "../../shared/types";
import { Card, Empty, JobBadge, PageHeader, Toggle, useToast } from "../components/ui";
import { api, guildPath } from "../lib/api";
import { absoluteTime, countdown, JOB_TYPE_LABEL, nextAttempt, relativeTime, SECURITY_REASONS } from "../lib/format";
import { useNow, usePolling } from "../lib/hooks";
import { Link } from "../lib/router";

const FAULTS: Record<FaultName, { label: string; hint: string }> = {
  mirrorDown: {
    label: "Mirror webhook outage",
    hint: "Mirror deliveries fail as if Slack/Discord were down. Watch them retry with backoff, then recover when you switch it off.",
  },
  aiDown: {
    label: "AI provider outage",
    hint: "Triage falls back to keyword rules instantly; an AI retry job enriches the report once the outage ends.",
  },
  aiSlow: {
    label: "Slow AI (+6 s)",
    hint: "Longer than Discord's 3 s window: /report still answers in time because it defers and follows up.",
  },
};

export function Reliability({ guild }: { guild: GuildSummaryDTO }) {
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();
  const now = useNow(1000);
  const settings = usePolling(() => api.get<GuildSettingsDTO>(guildPath(guild.id)), 15_000, [guild.id]);
  const jobs = usePolling(() => api.get<JobDTO[]>(guildPath(guild.id, `/jobs?view=${showAll ? "all" : "problems"}`)), 4000, [guild.id, showAll]);
  const security = usePolling(() => api.get<SecurityCounterDTO[]>("/api/security"), 15_000, []);

  const toggleFault = async (fault: FaultName, enabled: boolean) => {
    setBusy(fault);
    try {
      await api.put(guildPath(guild.id, "/faults"), { fault, enabled, minutes: 10 });
      await settings.refresh();
      toast(`${FAULTS[fault].label} ${enabled ? "on for 10 minutes" : "off"}`);
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(null);
    }
  };

  const retry = async (job: JobDTO) => {
    setBusy(job.id);
    try {
      await api.post(guildPath(guild.id, `/jobs/${encodeURIComponent(job.id)}/retry`));
      toast("Retry started");
      await jobs.refresh();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(null);
    }
  };

  const faults = settings.data?.faults ?? {};
  return (
    <>
      <PageHeader
        title="Reliability"
        subtitle="Failures, retries and rejected requests. Every side effect is a durable job, retried with exponential backoff (30 s → 30 min) by a 1-minute cron."
      />

      <div className="grid-main-side">
        <Card bodyless title="Delivery jobs" subtitle={showAll ? "Most recent 100 jobs" : "Jobs that failed at least once"} actions={
          <button type="button" className="btn btn-sm" onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Show problems only" : "Show all recent"}
          </button>
        }>
          {jobs.loading ? (
            <Empty title="Loading jobs…" />
          ) : !jobs.data?.length ? (
            <Empty title={showAll ? "No jobs yet" : "No failed deliveries"}>
              {!showAll && <p style={{ margin: 0 }}>Turn on a simulated outage on the right, run <code>/report</code>, and watch the retries appear here.</p>}
            </Empty>
          ) : (
            <div className="table-wrap" style={{ marginTop: 12 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Job</th>
                    <th>Status</th>
                    <th>Attempts</th>
                    <th>Last error</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {jobs.data.map((j) => (
                    <tr key={j.id}>
                      <td>
                        <div className="cell-main">{JOB_TYPE_LABEL[j.type]}</div>
                        <div className="cell-sub">
                          {j.reportId ? <Link to={`/g/${guild.id}/reports?report=${j.reportId}`}>Report #{j.reportId}</Link> : j.id.split(":").slice(0, 2).join(" ")}
                          {" · "}
                          <span title={absoluteTime(j.updatedAt)}>{relativeTime(j.updatedAt, now)}</span>
                        </div>
                      </td>
                      <td>
                        <JobBadge status={j.status} />
                        {j.status === "retrying" && <div className="cell-sub">{nextAttempt(j.runAfter, now)}</div>}
                      </td>
                      <td className="num">
                        {j.attempts}/{j.maxAttempts}
                      </td>
                      <td className="cell-sub" style={{ maxWidth: 280, overflowWrap: "anywhere" }}>
                        {j.lastError ?? "—"}
                      </td>
                      <td>
                        {(j.status === "dead" || j.status === "retrying") && (
                          <button type="button" className="btn btn-sm" disabled={busy === j.id} onClick={() => retry(j)}>
                            Retry now
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div className="stack">
          <Card title="Fault injection" subtitle="Simulate an outage for this server only. Each switch turns itself off after 10 minutes.">
            <div>
              {FAULT_NAMES.map((name) => {
                const until = faults[name];
                const active = typeof until === "number" && until > now;
                return (
                  <Toggle
                    key={name}
                    label={FAULTS[name].label}
                    hint={
                      <>
                        {FAULTS[name].hint}
                        {active && <strong className="err-text"> Active, {countdown(until!, now)} left.</strong>}
                      </>
                    }
                    checked={active}
                    disabled={busy === name || !settings.data}
                    onChange={(v) => toggleFault(name, v)}
                  />
                );
              })}
            </div>
          </Card>

          <Card title="Rejected requests, 24h" subtitle="Calls to /interactions that failed verification (all servers).">
            {security.loading ? (
              <span className="muted">Loading…</span>
            ) : !security.data?.length ? (
              <p className="muted" style={{ margin: 0 }}>Nothing rejected in the last 24 hours.</p>
            ) : (
              <table className="table">
                <tbody>
                  {security.data.map((row) => (
                    <tr key={row.reason}>
                      <td>
                        <div className="cell-main">{SECURITY_REASONS[row.reason] ?? row.reason}</div>
                        <div className="cell-sub">last {relativeTime(row.lastSeen, now)}</div>
                      </td>
                      <td className="num" style={{ textAlign: "right" }}>
                        {row.count}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="hint" style={{ margin: 0 }}>
              Try it: <code>curl -X POST {window.location.origin}/interactions -d '{"{}"}'</code> returns 401 and shows up here.
            </p>
          </Card>
        </div>
      </div>
    </>
  );
}
