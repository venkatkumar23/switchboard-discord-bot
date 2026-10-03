import { useCallback, useEffect, useState } from "react";
import type { MeDTO } from "../shared/types";
import { Layout, type Section } from "./components/Layout";
import { Empty, ToastProvider } from "./components/ui";
import { api, ApiError } from "./lib/api";
import { Link, navigate, useLocation } from "./lib/router";
import { Commands } from "./pages/Commands";
import { Connect } from "./pages/Connect";
import { Login } from "./pages/Login";
import { Overview } from "./pages/Overview";
import { Reliability } from "./pages/Reliability";
import { Reports } from "./pages/Reports";
import { Rules } from "./pages/Rules";
import { Settings } from "./pages/Settings";

const GUILD_ROUTE = /^\/g\/(\d{17,20})(?:\/(reports|commands|rules|settings|reliability))?\/?$/;

export function App() {
  const { path, query } = useLocation();
  // undefined = still checking the session, null = signed out
  const [me, setMe] = useState<MeDTO | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadMe = useCallback(async () => {
    try {
      setMe(await api.get<MeDTO>("/api/auth/me"));
      setLoadError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setMe(null);
      else setLoadError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void loadMe();
    const signedOut = () => setMe(null);
    window.addEventListener("sb:unauthorized", signedOut);
    return () => window.removeEventListener("sb:unauthorized", signedOut);
  }, [loadMe]);

  // Default landing: first server, or the connect page.
  useEffect(() => {
    if (!me) return;
    if (path === "/" || path === "/login") {
      const next = query.get("next");
      const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : null;
      navigate(safeNext ?? (me.guilds[0] ? `/g/${me.guilds[0].id}` : "/connect"), { replace: true });
    }
  }, [me, path, query]);

  if (me === undefined) {
    return loadError ? (
      <Empty title="Couldn't reach the server">
        <p>{loadError}</p>
        <button type="button" className="btn" onClick={() => void loadMe()}>
          Try again
        </button>
      </Empty>
    ) : null;
  }

  if (me === null) {
    return (
      <ToastProvider>
        <Login onLoggedIn={() => void loadMe()} />
      </ToastProvider>
    );
  }

  const match = GUILD_ROUTE.exec(path);
  const guild = match ? (me.guilds.find((g) => g.id === match[1]) ?? null) : null;
  const section: Section | null = match ? ((match[2] as Section | undefined) ?? "overview") : null;

  let page;
  if (path === "/connect") page = <Connect me={me} />;
  else if (match && !guild) {
    page = (
      <Empty title="Server not found">
        <p>It isn't connected to your account. <Link to="/connect">Connect a server</Link></p>
      </Empty>
    );
  } else if (guild) {
    page = {
      overview: <Overview guild={guild} />,
      reports: <Reports guild={guild} />,
      commands: <Commands guild={guild} />,
      rules: <Rules guild={guild} />,
      settings: <Settings guild={guild} />,
      reliability: <Reliability guild={guild} />,
    }[section!];
  } else page = <Empty title="Loading…" />;

  return (
    <ToastProvider>
      {/* key: switching servers resets every page's local state */}
      <Layout me={me} guild={guild} section={section} onLoggedOut={() => setMe(null)} key={guild?.id ?? path}>
        {page}
      </Layout>
    </ToastProvider>
  );
}
