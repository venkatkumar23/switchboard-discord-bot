import { useEffect, useState, type FormEvent } from "react";
import { PRIORITIES, type GuildSummaryDTO, type Priority, type RuleDTO, type RuleTestResultDTO } from "../../shared/types";
import { Card, ConfirmButton, Empty, PageHeader, PriorityBadge, Toggle, useToast } from "../components/ui";
import { api, guildPath } from "../lib/api";
import { PRIORITY_META } from "../lib/format";
import { useDebounced, usePolling } from "../lib/hooks";

type Draft = Omit<RuleDTO, "id" | "position"> & { keywordsText: string };

const emptyDraft: Draft = { name: "", keywords: [], keywordsText: "", priority: "high", mentionRole: false, enabled: true };

function RuleEditor({ initial, onSave, onCancel }: { initial: Draft; onSave: (d: Draft) => Promise<void>; onCancel: () => void }) {
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await onSave(draft);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="stack" style={{ gap: 12, padding: "14px 0" }}>
      <div className="grid-2" style={{ gap: 12 }}>
        <label className="field">
          <span>Name</span>
          <input className="input" required maxLength={60} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </label>
        <label className="field">
          <span>Priority</span>
          <select className="select" value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value as Priority })}>
            {[...PRIORITIES].reverse().map((p) => (
              <option key={p} value={p}>
                {PRIORITY_META[p].label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        <span>Keywords or phrases</span>
        <input
          className="input"
          required
          placeholder="down, outage, not working"
          value={draft.keywordsText}
          onChange={(e) => setDraft({ ...draft, keywordsText: e.target.value })}
        />
        <small>Comma-separated. Whole words only: “down” matches “site is down” but not “download”.</small>
      </label>
      <div>
        <Toggle label="Ping the alert role" hint="Critical reports always ping it." checked={draft.mentionRole} onChange={(v) => setDraft({ ...draft, mentionRole: v })} />
        <Toggle label="Enabled" checked={draft.enabled} onChange={(v) => setDraft({ ...draft, enabled: v })} />
      </div>
      <div className="inline">
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
          {busy ? "Saving…" : "Save rule"}
        </button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function RuleTester({ guildId, version }: { guildId: string; version: number }) {
  const [text, setText] = useState("The verification bot is down for everyone");
  const debounced = useDebounced(text, 300);
  const [result, setResult] = useState<RuleTestResultDTO | null>(null);
  useEffect(() => {
    if (!debounced.trim()) return setResult(null);
    let stale = false;
    api
      .post<RuleTestResultDTO>(guildPath(guildId, "/rules/test"), { text: debounced })
      .then((r) => !stale && setResult(r))
      .catch(() => !stale && setResult(null));
    return () => {
      stale = true;
    };
  }, [debounced, guildId, version]);

  return (
    <Card title="Try a message" subtitle="See which rule a report would match before anyone files it.">
      <textarea className="textarea" value={text} onChange={(e) => setText(e.target.value)} aria-label="Sample report text" />
      {result && (
        <div className="inline" aria-live="polite">
          <PriorityBadge priority={result.priority} />
          <span>
            {result.matched ? (
              <>
                matches <strong>{result.matched.ruleName}</strong> (keyword “{result.matched.keyword}”)
              </>
            ) : (
              "no rule matches, so it stays Normal"
            )}
            {result.mentionRole && " · pings the alert role"}
          </span>
        </div>
      )}
      <p className="hint" style={{ margin: 0 }}>
        AI triage runs after the rules and can raise the priority further, but never lowers it.
      </p>
    </Card>
  );
}

export function Rules({ guild }: { guild: GuildSummaryDTO }) {
  const rules = usePolling(() => api.get<RuleDTO[]>(guildPath(guild.id, "/rules")), 0, [guild.id]);
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [version, setVersion] = useState(0);
  const toast = useToast();

  const apply = (list: RuleDTO[]) => {
    void rules.refresh();
    setVersion((v) => v + 1);
    return list;
  };

  const toPayload = (d: Draft) => ({
    name: d.name,
    keywords: d.keywordsText.split(",").map((k) => k.trim()).filter(Boolean),
    priority: d.priority,
    mentionRole: d.mentionRole,
    enabled: d.enabled,
  });

  const save = async (d: Draft, id?: number) => {
    try {
      apply(id ? await api.put<RuleDTO[]>(guildPath(guild.id, `/rules/${id}`), toPayload(d)) : await api.post<RuleDTO[]>(guildPath(guild.id, "/rules"), toPayload(d)));
      setEditing(null);
      toast(`Rule “${d.name}” saved`);
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  const remove = async (rule: RuleDTO) => {
    try {
      apply(await api.del<RuleDTO[]>(guildPath(guild.id, `/rules/${rule.id}`)));
      toast(`Rule “${rule.name}” deleted`);
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  const move = async (index: number, delta: -1 | 1) => {
    const list = [...(rules.data ?? [])];
    const [item] = list.splice(index, 1);
    list.splice(index + delta, 0, item!);
    try {
      apply(await api.post<RuleDTO[]>(guildPath(guild.id, "/rules/reorder"), { ids: list.map((r) => r.id) }));
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  const list = rules.data ?? [];
  return (
    <>
      <PageHeader
        title="Rules"
        subtitle="Keyword rules set each report's priority. The highest-priority match wins; order breaks ties."
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setEditing("new")} disabled={editing === "new"}>
            Add rule
          </button>
        }
      />
      <div className="grid-main-side">
        <Card bodyless title={`${list.length} rule${list.length === 1 ? "" : "s"}`}>
          <div className="card-body">
            {editing === "new" && <RuleEditor initial={emptyDraft} onSave={(d) => save(d)} onCancel={() => setEditing(null)} />}
            {rules.loading && <Empty title="Loading…" />}
            {!rules.loading && list.length === 0 && editing !== "new" && <Empty title="No rules yet">Every report will be Normal priority unless AI triage escalates it.</Empty>}
            {list.map((rule, i) =>
              editing === rule.id ? (
                <RuleEditor
                  key={rule.id}
                  initial={{ ...rule, keywordsText: rule.keywords.join(", ") }}
                  onSave={(d) => save(d, rule.id)}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <div key={rule.id} style={{ padding: "12px 0", borderTop: i ? "1px solid var(--hairline)" : undefined, opacity: rule.enabled ? 1 : 0.6 }}>
                  <div className="inline" style={{ justifyContent: "space-between" }}>
                    <div className="inline">
                      <strong>{rule.name}</strong>
                      <PriorityBadge priority={rule.priority} />
                      {rule.mentionRole && <span className="chip">pings alert role</span>}
                      {!rule.enabled && <span className="chip">disabled</span>}
                    </div>
                    <div className="inline" style={{ gap: 4 }}>
                      <button type="button" className="btn btn-sm btn-ghost" aria-label={`Move ${rule.name} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                        ↑
                      </button>
                      <button type="button" className="btn btn-sm btn-ghost" aria-label={`Move ${rule.name} down`} disabled={i === list.length - 1} onClick={() => move(i, 1)}>
                        ↓
                      </button>
                      <button type="button" className="btn btn-sm" onClick={() => setEditing(rule.id)}>
                        Edit
                      </button>
                      <ConfirmButton label="Delete" confirmLabel="Really delete?" onConfirm={() => remove(rule)} />
                    </div>
                  </div>
                  <div className="chips" style={{ marginTop: 8 }}>
                    {rule.keywords.map((k) => (
                      <span key={k} className="chip">
                        {k}
                      </span>
                    ))}
                  </div>
                </div>
              ),
            )}
          </div>
        </Card>
        <RuleTester guildId={guild.id} version={version} />
      </div>
    </>
  );
}
