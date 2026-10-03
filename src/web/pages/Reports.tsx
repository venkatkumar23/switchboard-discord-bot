import { useEffect, useState } from "react";
import type { GuildSummaryDTO, JobType, ReportDetailDTO, ReportDTO } from "../../shared/types";
import { Card, Empty, JobBadge, PageHeader, PriorityBadge, StatusBadge } from "../components/ui";
import { api, guildPath } from "../lib/api";
import { absoluteTime, clockTime, JOB_STATUS_META, JOB_TYPE_LABEL, nextAttempt, relativeTime } from "../lib/format";
import { useNow, usePolling } from "../lib/hooks";
import { setQuery, useLocation } from "../lib/router";

const STATUS_FILTERS = ["all", "open", "acknowledged", "resolved"] as const;
const PIPELINE: JobType[] = ["triage", "reply", "post", "mirror"];

function Steps({ report }: { report: ReportDTO }) {
  return (
    <span className="steps">
      {PIPELINE.map((step) => {
        const status = report.steps[step];
        const meta = status ? JOB_STATUS_META[status] : null;
        const label = `${JOB_TYPE_LABEL[step]}: ${meta?.label ?? "skipped"}`;
        return (
          <span key={step} className="step" title={label}>
            <i className="dot" style={{ ["--dot" as string]: meta?.color ?? "var(--surface-3)" }} aria-hidden="true" />
            {JOB_TYPE_LABEL[step].split(" ")[0]}
            <span className="sr-only">{meta?.label ?? "skipped"}</span>
          </span>
        );
      })}
    </span>
  );
}

export function Reports({ guild }: { guild: GuildSummaryDTO }) {
  const { query } = useLocation();
  const [status, setStatus] = useState<(typeof STATUS_FILTERS)[number]>("all");
  const now = useNow(10_000);
  const reports = usePolling(
    () => api.get<ReportDTO[]>(guildPath(guild.id, `/reports?status=${status}`)),
    5000,
    [guild.id, status],
  );
  const openId = Number(query.get("report")) || null;

  return (
    <>
      <PageHeader title="Reports" subtitle="Everything filed with /report, with where each delivery step stands." />
      <Card
        bodyless
        actions={
          <div className="filters" role="group" aria-label="Filter by status">
            {STATUS_FILTERS.map((f) => (
              <button key={f} type="button" aria-pressed={status === f} onClick={() => setStatus(f)}>
                {f === "all" ? "All" : f[0]!.toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
        }
        title="Latest 50"
      >
        {reports.error && <p className="err-text" style={{ padding: "0 18px" }}>{reports.error.message}</p>}
        {reports.loading ? (
          <Empty title="Loading reports…" />
        ) : !reports.data?.length ? (
          <Empty title="No reports here yet">
            <p style={{ margin: 0 }}>
              Run <code>/report</code> in Discord to file one.
            </p>
          </Empty>
        ) : (
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Priority</th>
                  <th>Report</th>
                  <th>Status</th>
                  <th>Pipeline</th>
                  <th>Filed</th>
                </tr>
              </thead>
              <tbody>
                {reports.data.map((r) => (
                  <tr
                    key={r.id}
                    className="clickable"
                    tabIndex={0}
                    onClick={() => setQuery("report", String(r.id))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setQuery("report", String(r.id));
                      }
                    }}
                  >
                    <td className="num">#{r.id}</td>
                    <td>
                      <PriorityBadge priority={r.priority} />
                    </td>
                    <td style={{ minWidth: 220 }}>
                      <div className="cell-main clamp">{r.title ?? r.body}</div>
                      <div className="cell-sub">by {r.userName}{r.ruleName ? ` · rule “${r.ruleName}”` : ""}</div>
                    </td>
                    <td>
                      <StatusBadge status={r.status} />
                    </td>
                    <td>
                      <Steps report={r} />
                    </td>
                    <td className="num" title={absoluteTime(r.createdAt)}>
                      {relativeTime(r.createdAt, now)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {openId && <ReportDrawer guildId={guild.id} reportId={openId} onClose={() => setQuery("report", null)} />}
    </>
  );
}

function ReportDrawer({ guildId, reportId, onClose }: { guildId: string; reportId: number; onClose: () => void }) {
  const detail = usePolling(() => api.get<ReportDetailDTO>(guildPath(guildId, `/reports/${reportId}`)), 4000, [guildId, reportId]);
  const now = useNow(5000);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const d = detail.data;
  const r = d?.report;
  return (
    <>
      <div className="overlay" onClick={onClose} aria-hidden="true" />
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="report-title">
        <div className="drawer-header">
          <div>
            <h2 id="report-title" style={{ fontSize: 18 }}>
              Report #{reportId}
              {r?.title ? ` — ${r.title}` : ""}
            </h2>
            {r && (
              <div className="inline" style={{ marginTop: 8 }}>
                <PriorityBadge priority={r.priority} />
                <StatusBadge status={r.status} />
              </div>
            )}
          </div>
          <button type="button" className="btn btn-sm" onClick={onClose} autoFocus>
            Close
          </button>
        </div>
        <div className="drawer-body">
          {detail.error && <p className="err-text">{detail.error.message}</p>}
          {!r ? (
            !detail.error && <span className="muted">Loading…</span>
          ) : (
            <>
              <p className="quote">{r.body}</p>
              <dl className="facts">
                <dt>Reporter</dt>
                <dd>{r.userName}</dd>
                <dt>Filed</dt>
                <dd>{absoluteTime(r.createdAt)}</dd>
                <dt>Priority</dt>
                <dd>
                  {r.priority ?? "pending"}
                  {r.prioritySource === "rule" && ` — rule “${r.ruleName}” matched “${r.matchedKeyword}”`}
                  {r.prioritySource === "ai" && " — escalated by AI triage"}
                  {r.prioritySource === "default" && " — no rule matched"}
                </dd>
                <dt>AI triage</dt>
                <dd>
                  {r.ai.status === "done" && (
                    <>
                      {r.ai.summary}
                      <div className="chips" style={{ marginTop: 6 }}>
                        {r.ai.category && <span className="chip">{r.ai.category}</span>}
                        {r.ai.severity && <span className="chip">severity: {r.ai.severity}</span>}
                        {r.ai.tags.map((t) => (
                          <span key={t} className="chip">
                            #{t}
                          </span>
                        ))}
                      </div>
                    </>
                  )}
                  {r.ai.status === "failed" && <span className="err-text">Unavailable: {r.ai.error}. Rules were used; retrying in the background.</span>}
                  {r.ai.status === "skipped" && <span className="muted">Off for this server</span>}
                  {r.ai.status === "pending" && <span className="muted">Pending…</span>}
                </dd>
                {r.ackedBy && (
                  <>
                    <dt>Acknowledged</dt>
                    <dd>
                      {r.ackedBy}, {relativeTime(r.ackedAt!, now)}
                    </dd>
                  </>
                )}
                {r.resolvedBy && (
                  <>
                    <dt>Resolved</dt>
                    <dd>
                      {r.resolvedBy}, {relativeTime(r.resolvedAt!, now)}
                    </dd>
                  </>
                )}
                {r.postedMessageUrl && (
                  <>
                    <dt>In Discord</dt>
                    <dd>
                      <a href={r.postedMessageUrl} target="_blank" rel="noreferrer">
                        Open the posted message ↗
                      </a>
                    </dd>
                  </>
                )}
              </dl>

              <section>
                <h3>Delivery jobs</h3>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Step</th>
                        <th>Status</th>
                        <th>Attempts</th>
                        <th>Last error</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.jobs.map((j) => (
                        <tr key={j.id}>
                          <td>
                            {JOB_TYPE_LABEL[j.type]}
                            {j.id.startsWith("mirror:status") && <div className="cell-sub">status change</div>}
                          </td>
                          <td>
                            <JobBadge status={j.status} />
                            {j.status === "retrying" && <div className="cell-sub">{nextAttempt(j.runAfter, now)}</div>}
                          </td>
                          <td className="num">
                            {j.attempts}/{j.maxAttempts}
                          </td>
                          <td className="cell-sub" style={{ maxWidth: 220, overflowWrap: "anywhere" }}>
                            {j.lastError ?? "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              <section>
                <h3>Timeline</h3>
                <ol className="timeline">
                  {d.events.map((e) => (
                    <li key={e.id}>
                      <time title={absoluteTime(e.createdAt)}>{clockTime(e.createdAt)}</time>
                      <span className={e.level === "error" ? "err-text" : undefined}>{e.message}</span>
                    </li>
                  ))}
                </ol>
              </section>
            </>
          )}
        </div>
      </aside>
    </>
  );
}
