import { useEffect, useMemo, useRef, useState } from "react";
import { PRIORITIES, type EventDTO, type EventKind, type GuildSummaryDTO, type StatsDTO } from "../../shared/types";
import { Card, Dot, Empty, PageHeader } from "../components/ui";
import { api, guildPath } from "../lib/api";
import { absoluteTime, compact, EVENT_KIND_LABEL, PRIORITY_META, relativeTime } from "../lib/format";
import { useNow, usePolling } from "../lib/hooks";
import { Link } from "../lib/router";

const FEED_LIMIT = 200;
const POLL_MS = 3000;

function useLiveEvents(guildId: string, paused: boolean) {
  const [events, setEvents] = useState<EventDTO[]>([]);
  const [fresh, setFresh] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const cursor = useRef(0);
  const loadedOnce = useRef(false);
  // Pausing must not reset the feed, so it is read through a ref rather than an effect dependency.
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    let cancelled = false;
    cursor.current = 0;
    loadedOnce.current = false;
    setEvents([]);
    setLoaded(false);

    const poll = async () => {
      const initial = !loadedOnce.current;
      // The first load always runs; later polls skip while paused or while the tab is hidden.
      if (cancelled || (!initial && (pausedRef.current || document.visibilityState !== "visible"))) return;
      try {
        const batch = await api.get<EventDTO[]>(guildPath(guildId, initial ? "/events?limit=60" : `/events?after=${cursor.current}`));
        if (cancelled) return;
        loadedOnce.current = true;
        setError(null);
        setLoaded(true);
        if (!batch.length) return;
        cursor.current = Math.max(cursor.current, ...batch.map((e) => e.id));
        setEvents((prev) => {
          const seen = new Set(prev.map((e) => e.id));
          return [...batch.filter((e) => !seen.has(e.id)), ...prev].slice(0, FEED_LIMIT);
        });
        if (!initial) setFresh(new Set(batch.map((e) => e.id)));
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    };

    void poll();
    const timer = window.setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [guildId]);

  return { events, fresh, error, loaded };
}

const ICONS: Record<string, string> = { info: "•", warn: "!", error: "✕" };
const FILTERS: (EventKind | "all" | "problems")[] = ["all", "command", "action", "job", "config", "security", "problems"];

const FILTER_LABELS: Record<(typeof FILTERS)[number], string> = {
  all: "All",
  command: "Commands",
  action: "Actions",
  job: "Deliveries",
  config: "Config",
  security: "Security",
  problems: "Warnings & errors",
};

export function Overview({ guild }: { guild: GuildSummaryDTO }) {
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const now = useNow(5000);
  const stats = usePolling(() => api.get<StatsDTO>(guildPath(guild.id, "/stats")), 10_000, [guild.id]);
  const live = useLiveEvents(guild.id, paused);

  const shown = useMemo(
    () =>
      live.events.filter((e) =>
        filter === "all" ? true : filter === "problems" ? e.level !== "info" : e.kind === filter,
      ),
    [live.events, filter],
  );

  const s = stats.data;
  return (
    <>
      <PageHeader title="Overview" subtitle={<>Every command and action in <strong>{guild.name}</strong>, as it happens.</>} />

      <div className="tiles">
        <section className="card tile">
          <span className="tile-label">Commands, last 24h</span>
          <span className="tile-value">{s ? compact(s.commands24h) : "–"}</span>
          <span className="tile-sub">{s ? `${compact(s.reports24h)} reports filed` : " "}</span>
        </section>
        <section className="card tile">
          <span className="tile-label">Open reports</span>
          <span className="tile-value">{s ? compact(s.openReports) : "–"}</span>
          <span className="tile-sub">
            {s &&
              [...PRIORITIES].reverse()
                .filter((p) => s.openByPriority[p] > 0)
                .map((p) => (
                  <span key={p} className="inline" style={{ gap: 4 }}>
                    <i className="dot" style={{ ["--dot" as string]: PRIORITY_META[p].color }} aria-hidden="true" />
                    {s.openByPriority[p]} {PRIORITY_META[p].label.toLowerCase()}
                  </span>
                ))}
            {s && s.openReports === 0 && "Nothing waiting"}
          </span>
        </section>
        <section className="card tile">
          <span className="tile-label">Deliveries, last 24h</span>
          <span className="tile-value">{s ? compact(s.jobs.succeeded24h) : "–"}</span>
          <span className="tile-sub">
            {s && (
              <>
                <span>{s.jobs.retrying} retrying</span>
                <span className={s.jobs.dead ? "err-text" : undefined}>{s.jobs.dead} failed</span>
                {s.jobs.pending > 0 && <span>{s.jobs.pending} queued</span>}
              </>
            )}
          </span>
        </section>
        <section className="card tile">
          <span className="tile-label">Duplicates ignored, 24h</span>
          <span className="tile-value">{s ? compact(s.duplicates24h) : "–"}</span>
          <span className="tile-sub">Redelivered interactions, no side effects</span>
        </section>
      </div>

      <div className="grid-main-side">
        <Card
          bodyless
          title="Live activity"
          subtitle="Commands, actions, deliveries and config changes"
          actions={
            <>
              <span className={`live ${paused ? "paused" : ""}`}>
                <i className="dot" aria-hidden="true" />
                {paused ? "Paused" : "Live"}
              </span>
              <button type="button" className="btn btn-sm" onClick={() => setPaused((p) => !p)}>
                {paused ? "Resume" : "Pause"}
              </button>
            </>
          }
        >
          <div className="card-body" style={{ paddingBottom: 12 }}>
            <div className="filters" role="group" aria-label="Filter activity">
              {FILTERS.map((f) => (
                <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>
                  {FILTER_LABELS[f]}
                </button>
              ))}
            </div>
          </div>
          {live.error && <p className="err-text" style={{ padding: "0 18px" }}>Couldn't refresh: {live.error}</p>}
          {!live.loaded && !live.error ? (
            <Empty title="Loading activity…" />
          ) : shown.length === 0 ? (
            <Empty title={live.events.length ? "Nothing matches this filter" : "No activity yet"}>
              {!live.events.length && (
                <p style={{ margin: 0 }}>
                  Run <code>/report</code> or <code>/status</code> in your Discord server and watch it appear here.
                </p>
              )}
            </Empty>
          ) : (
            <ol className="feed">
              {shown.map((e) => (
                <li key={e.id} className={`event lvl-${e.level} ${live.fresh.has(e.id) ? "fresh" : ""}`}>
                  <span className="event-icon" aria-label={e.level}>
                    {ICONS[e.level]}
                  </span>
                  <div>
                    <div className="event-msg">{e.message}</div>
                    <div className="event-meta">
                      <span className="kind">{EVENT_KIND_LABEL[e.kind] ?? e.kind}</span>
                      <time dateTime={new Date(e.createdAt).toISOString()} title={absoluteTime(e.createdAt)}>
                        {relativeTime(e.createdAt, now)}
                      </time>
                      {e.reportId && <Link to={`/g/${guild.id}/reports?report=${e.reportId}`}>Report #{e.reportId}</Link>}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Card>

        <div className="stack">
          <Card title="Try it in Discord">
            <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 8 }}>
              <li>
                <code>/report text:the server is down</code> — filed, triaged and posted with buttons.
              </li>
              <li>
                <code>/report</code> with no text opens a form.
              </li>
              <li>
                <code>/status</code> or <code>/status report:1</code> answers instantly.
              </li>
              <li>
                Press <strong>Acknowledge</strong> / <strong>Resolve</strong> on the posted report.
              </li>
            </ul>
          </Card>
          <Card title="Pipeline health">
            {s ? (
              <div className="stack" style={{ gap: 8 }}>
                <Dot color={s.jobs.dead ? "var(--critical)" : s.jobs.retrying ? "var(--warning)" : "var(--good)"} label={s.jobs.dead ? "Some deliveries failed" : s.jobs.retrying ? "Retrying deliveries" : "All deliveries healthy"} />
                <p className="hint" style={{ margin: 0 }}>
                  Failed and retrying jobs are listed on <Link to={`/g/${guild.id}/reliability`}>Reliability</Link>, where you can retry them or simulate an outage.
                </p>
              </div>
            ) : (
              <span className="muted">Loading…</span>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
