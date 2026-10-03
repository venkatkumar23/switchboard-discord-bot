import { useEffect, useState } from "react";
import type { ChannelDTO, GuildSettingsDTO, GuildSummaryDTO, JobDTO, RoleDTO } from "../../shared/types";
import { Banner, Card, ConfirmButton, Empty, PageHeader, Toggle, useToast } from "../components/ui";
import { api, guildPath } from "../lib/api";
import { absoluteTime, JOB_STATUS_META } from "../lib/format";
import { usePolling } from "../lib/hooks";
import { setQuery, useLocation } from "../lib/router";

function useDiscordList<T>(guildId: string, kind: "channels" | "roles") {
  const [items, setItems] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    setItems(null);
    api
      .get<T[]>(guildPath(guildId, `/discord/${kind}`))
      .then((r) => !stale && setItems(r))
      .catch((e) => !stale && setError((e as Error).message));
    return () => {
      stale = true;
    };
  }, [guildId, kind]);
  return { items, error };
}

export function Settings({ guild }: { guild: GuildSummaryDTO }) {
  const { query } = useLocation();
  const toast = useToast();
  const settings = usePolling(() => api.get<GuildSettingsDTO>(guildPath(guild.id)), 0, [guild.id]);
  const channels = useDiscordList<ChannelDTO>(guild.id, "channels");
  const roles = useDiscordList<RoleDTO>(guild.id, "roles");
  const [mirrorUrl, setMirrorUrl] = useState("");
  const [mirrorTest, setMirrorTest] = useState<JobDTO | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const s = settings.data;

  const patch = async (body: Partial<Pick<GuildSettingsDTO, "postChannelId" | "alertRoleId" | "moderatorsOnly" | "aiEnabled">>, what: string) => {
    setBusy(what);
    try {
      await api.patch(guildPath(guild.id, "/settings"), body);
      await settings.refresh();
      toast(`${what} saved`);
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(null);
    }
  };

  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    try {
      await fn();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(null);
    }
  };

  if (settings.error) return <p className="err-text">{settings.error.message}</p>;
  if (!s) return <Empty title="Loading settings…" />;

  return (
    <>
      <PageHeader title="Settings" subtitle={`Where ${s.name}'s reports go, who gets pinged, and where they are mirrored.`} />
      {query.get("connected") && (
        <Banner kind="good">
          <strong>{s.name} is connected.</strong> Pick a report channel and a mirror webhook below to finish setup.{" "}
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setQuery("connected", null)}>
            Dismiss
          </button>
        </Banner>
      )}

      <div className="grid-2">
        <Card title="Report channel" subtitle="New reports are posted here with Acknowledge / Resolve buttons.">
          {channels.error ? (
            <p className="err-text">Couldn't load channels: {channels.error}. Is the bot still in this server?</p>
          ) : (
            <div className="inline">
              <select
                className="select"
                aria-label="Report channel"
                value={s.postChannelId ?? ""}
                disabled={!channels.items || busy === "Report channel"}
                onChange={(e) => patch({ postChannelId: e.target.value || null }, "Report channel")}
              >
                <option value="">{channels.items ? "No channel (reply only)" : "Loading channels…"}</option>
                {channels.items?.map((c) => (
                  <option key={c.id} value={c.id}>
                    #{c.name}
                    {c.category ? ` · ${c.category}` : ""}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn"
                disabled={!s.postChannelId || busy === "test-channel"}
                onClick={() =>
                  run("test-channel", async () => {
                    const r = await api.post<{ ok: boolean; message?: string }>(guildPath(guild.id, "/channel/test"));
                    if (r.ok) toast("Test message sent to the channel");
                    else toast(`Couldn't post: ${r.message}`, "error");
                  })
                }
              >
                Send test message
              </button>
            </div>
          )}
          <p className="hint">The bot needs View Channel, Send Messages and Embed Links there.</p>
        </Card>

        <Card title="Alert role" subtitle="Pinged for rules that ask for it, and for every critical report.">
          {roles.error ? (
            <p className="err-text">Couldn't load roles: {roles.error}</p>
          ) : (
            <select
              className="select"
              aria-label="Alert role"
              value={s.alertRoleId ?? ""}
              disabled={!roles.items || busy === "Alert role"}
              onChange={(e) => patch({ alertRoleId: e.target.value || null }, "Alert role")}
            >
              <option value="">{roles.items ? "Nobody (no pings)" : "Loading roles…"}</option>
              {roles.items?.map((r) => (
                <option key={r.id} value={r.id}>
                  @{r.name}
                  {r.mentionable ? "" : " (not mentionable)"}
                </option>
              ))}
            </select>
          )}
          <p className="hint">Pings only work for roles that are mentionable. User-typed @everyone never pings.</p>
        </Card>

        <Card
          title="Mirror notifications"
          subtitle="The second channel: a Slack Incoming Webhook or a Discord channel webhook."
        >
          <p style={{ margin: 0 }}>
            {s.mirror.configured ? (
              <>
                Sending to a <strong>{s.mirror.kind === "slack" ? "Slack" : "Discord"} webhook</strong> <code>{s.mirror.hint}</code>
              </>
            ) : (
              <span className="muted">Not configured, so nothing is mirrored yet.</span>
            )}
          </p>
          <form
            className="inline"
            onSubmit={(e) => {
              e.preventDefault();
              void run("mirror", async () => {
                await api.put(guildPath(guild.id, "/mirror"), { url: mirrorUrl });
                setMirrorUrl("");
                await settings.refresh();
                toast("Mirror webhook saved (stored encrypted)");
              });
            }}
          >
            <input
              className="input"
              type="url"
              autoComplete="off"
              spellCheck={false}
              placeholder={s.mirror.configured ? "Paste a new URL to replace it" : "https://hooks.slack.com/services/…"}
              value={mirrorUrl}
              onChange={(e) => setMirrorUrl(e.target.value)}
              aria-label="Webhook URL"
            />
            <button type="submit" className="btn btn-primary" disabled={!mirrorUrl || busy === "mirror"}>
              Save
            </button>
          </form>
          {s.mirror.configured && (
            <div className="inline">
              <button
                type="button"
                className="btn"
                disabled={busy === "mirror-test"}
                onClick={() =>
                  run("mirror-test", async () => {
                    const r = await api.post<{ job: JobDTO | null }>(guildPath(guild.id, "/mirror/test"));
                    setMirrorTest(r.job);
                  })
                }
              >
                {busy === "mirror-test" ? "Sending…" : "Send test"}
              </button>
              <ConfirmButton
                label="Remove"
                confirmLabel="Really remove?"
                onConfirm={() =>
                  run("mirror-remove", async () => {
                    await api.del(guildPath(guild.id, "/mirror"));
                    await settings.refresh();
                    toast("Mirror removed");
                  })
                }
              />
            </div>
          )}
          {mirrorTest && (
            <p className={mirrorTest.status === "succeeded" ? "ok-text" : "err-text"} style={{ margin: 0 }}>
              Test {JOB_STATUS_META[mirrorTest.status].label.toLowerCase()}
              {mirrorTest.lastError ? `: ${mirrorTest.lastError}` : "."}
              {mirrorTest.status === "retrying" && " It will retry automatically — see Reliability."}
            </p>
          )}
          <p className="hint">The URL is encrypted at rest and never shown again in full.</p>
        </Card>

        <Card title="Moderation & AI">
          <Toggle
            label="Only moderators can press report buttons"
            hint="Requires Manage Messages (or Manage Server / Administrator) for Acknowledge, Resolve and Reopen."
            checked={s.moderatorsOnly}
            disabled={busy === "Moderation"}
            onChange={(v) => patch({ moderatorsOnly: v }, "Moderation")}
          />
          <Toggle
            label="AI triage"
            hint={
              s.aiAvailable
                ? "Summarises, categorises and tags each report; may escalate its priority."
                : "Unavailable: no AI provider key is configured for this deployment."
            }
            checked={s.aiEnabled && s.aiAvailable}
            disabled={!s.aiAvailable || busy === "AI triage"}
            onChange={(v) => patch({ aiEnabled: v }, "AI triage")}
          />
        </Card>

        <Card title="Connection">
          <dl className="facts">
            <dt>Server ID</dt>
            <dd className="mono">{s.id}</dd>
            <dt>Connected</dt>
            <dd>{s.connectedAt ? absoluteTime(s.connectedAt) : "Bot added without the dashboard flow"}</dd>
          </dl>
          <a className="btn btn-sm" href={`/oauth/discord/start?guild=${s.id}`}>
            Re-run Discord authorization
          </a>
        </Card>
      </div>
    </>
  );
}
