import { useEffect, useState } from "react";
import type { CommandConfigDTO, GuildSummaryDTO } from "../../shared/types";
import { Card, Empty, PageHeader, Toggle, useToast } from "../components/ui";
import { api, guildPath } from "../lib/api";
import { usePolling } from "../lib/hooks";

function CommandCard({ guildId, config, onSaved }: { guildId: string; config: CommandConfigDTO; onSaved: () => void }) {
  const [draft, setDraft] = useState(config);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  useEffect(() => setDraft(config), [config]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(config);
  const set = <K extends keyof CommandConfigDTO>(key: K, value: CommandConfigDTO[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const save = async () => {
    setBusy(true);
    try {
      const { command, description, ...settings } = draft;
      void description;
      await api.put(guildPath(guildId, `/commands/${command}`), settings);
      toast(`/${command} saved`);
      onSaved();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={<code style={{ fontSize: 15 }}>/{config.command}</code>}
      subtitle={config.description}
    >
      <div>
        <Toggle label="Enabled" hint="When off, the bot answers that the command is turned off." checked={draft.enabled} onChange={(v) => set("enabled", v)} />
        <Toggle label="Private replies" hint="Only the person who ran the command sees the bot's reply." checked={draft.ephemeral} onChange={(v) => set("ephemeral", v)} />
        {config.command === "report" && (
          <Toggle
            label="Post to the report channel"
            hint="Posts the report with Acknowledge / Resolve buttons (pick the channel in Settings)."
            checked={draft.postToChannel}
            onChange={(v) => set("postToChannel", v)}
          />
        )}
        <Toggle
          label="Mirror to the second channel"
          hint={config.command === "report" ? "New reports and status changes go to Slack / the Discord mirror." : "Each /status query is announced in the mirror."}
          checked={draft.mirror}
          onChange={(v) => set("mirror", v)}
        />
      </div>
      <label className="field">
        <span>Per-user cooldown (seconds)</span>
        <input
          className="input"
          type="number"
          min={0}
          max={3600}
          value={draft.cooldownSeconds}
          onChange={(e) => set("cooldownSeconds", Math.max(0, Math.min(3600, Number(e.target.value) || 0)))}
          style={{ maxWidth: 160 }}
        />
        <small>0 turns it off. A user who runs the command again sooner gets a "slow down" reply.</small>
      </label>
      <div className="inline">
        <button type="button" className="btn btn-primary" onClick={save} disabled={!dirty || busy}>
          {busy ? "Saving…" : dirty ? "Save changes" : "Saved"}
        </button>
        {dirty && (
          <button type="button" className="btn btn-ghost" onClick={() => setDraft(config)}>
            Discard
          </button>
        )}
      </div>
    </Card>
  );
}

export function Commands({ guild }: { guild: GuildSummaryDTO }) {
  const configs = usePolling(() => api.get<CommandConfigDTO[]>(guildPath(guild.id, "/commands")), 0, [guild.id]);
  return (
    <>
      <PageHeader title="Commands" subtitle="How each slash command behaves on this server. Changes apply to the next command immediately." />
      {configs.error && <p className="err-text">{configs.error.message}</p>}
      {configs.loading ? (
        <Empty title="Loading…" />
      ) : (
        <div className="grid-2">
          {configs.data?.map((c) => (
            <CommandCard key={c.command} guildId={guild.id} config={c} onSaved={configs.refresh} />
          ))}
        </div>
      )}
    </>
  );
}
