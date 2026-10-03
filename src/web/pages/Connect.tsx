import type { MeDTO } from "../../shared/types";
import { GuildIcon } from "../components/Layout";
import { Banner, Card, PageHeader } from "../components/ui";
import { Link, useLocation } from "../lib/router";

const ERRORS: Record<string, string> = {
  cancelled: "Discord authorization was cancelled, so nothing was connected.",
  invalid_state: "That connection link expired or was already used. Please start again.",
  exchange_failed:
    "Discord rejected the authorization code. Check the client secret and that the redirect URL is registered in the Discord Developer Portal.",
  no_guild: "Discord didn't say which server the bot was added to. Pick a server on Discord's screen.",
  not_configured: "This deployment has no Discord client secret configured, so the connect flow is disabled.",
  discord_error: "Discord returned an error during authorization.",
};

export function Connect({ me }: { me: MeDTO }) {
  const { query } = useLocation();
  const error = query.get("error");

  return (
    <>
      <PageHeader title="Connect a Discord server" subtitle="Add the bot to a server you manage and it will show up here." />
      {error && <Banner kind="error">{ERRORS[error] ?? "Connecting the server failed."}</Banner>}
      <Card title="How it works">
        <ol style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 6 }}>
          <li>Click the button and pick a server where you have <strong>Manage Server</strong>.</li>
          <li>Discord adds the bot with only the permissions it needs (view, send, embed, read history).</li>
          <li>You come back here to choose the report channel, the alert role and the mirror webhook.</li>
        </ol>
        <a className="btn btn-primary btn-lg" href="/oauth/discord/start">
          Add Switchboard to a server
        </a>
      </Card>
      {me.guilds.length > 0 && (
        <Card title="Your servers">
          <div className="stack" style={{ gap: 8 }}>
            {me.guilds.map((g) => (
              <Link key={g.id} to={`/g/${g.id}`} className="guild-current">
                <GuildIcon guild={g} />
                {g.name}
              </Link>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}
