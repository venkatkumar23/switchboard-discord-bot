import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../lib/api";

export function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ inviteUrl: string | null }>("/api/public")
      .then((r) => setInviteUrl(r.inviteUrl))
      .catch(() => undefined);
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/auth/login", { email, password });
      onLoggedIn();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setError("Wrong email or password.");
      else if (err instanceof ApiError && err.status === 429) {
        const wait = Math.ceil(Number(err.body?.retryAfterSeconds ?? 60) / 60);
        setError(`Too many attempts. Try again in ${wait} minute${wait === 1 ? "" : "s"}.`);
      } else setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <section className="auth-brand">
        <img src="/favicon.svg" alt="" width={44} height={44} />
        <h1>Switchboard</h1>
        <p>
          A Discord bot that turns <code>/report</code> into a tracked, triaged incident: recorded, answered in Discord,
          posted to your moderators with buttons, and mirrored to Slack or another channel.
        </p>
        <ul>
          <li>
            <span aria-hidden="true">🔏</span>
            <span>Every request is Ed25519-verified; replays and duplicates are rejected.</span>
          </li>
          <li>
            <span aria-hidden="true">📦</span>
            <span>Durable job pipeline: nothing is lost when Slack, Discord or the AI hiccup — it retries.</span>
          </li>
          <li>
            <span aria-hidden="true">🤖</span>
            <span>Keyword rules plus free-tier AI triage that can escalate, never hide, a report.</span>
          </li>
          <li>
            <span aria-hidden="true">📈</span>
            <span>Live log of every command and action, per server.</span>
          </li>
        </ul>
        {inviteUrl && (
          <p style={{ fontSize: 14 }}>
            Just want to try the bot? <a href={inviteUrl}>Add it to a Discord server</a>.
          </p>
        )}
      </section>
      <div className="auth-form">
        <form className="card" onSubmit={submit}>
          <div className="card-header">
            <div>
              <h2>Sign in</h2>
              <p>Admin dashboard</p>
            </div>
          </div>
          <div className="card-body">
            <label className="field">
              <span>Email</span>
              <input className="input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="field">
              <span>Password</span>
              <input
                className="input"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            {error && (
              <p className="err-text" role="alert" style={{ margin: "8px 0 0" }}>
                {error}
              </p>
            )}
            <button className="btn btn-primary btn-lg" type="submit" disabled={busy} style={{ width: "100%" }}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
