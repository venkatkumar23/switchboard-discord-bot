import { useEffect, useState, type ReactNode } from "react";
import type { GuildSummaryDTO, MeDTO } from "../../shared/types";
import { api } from "../lib/api";
import { Link, navigate, useLocation } from "../lib/router";

export type Section = "overview" | "reports" | "commands" | "rules" | "settings" | "reliability";

const NAV: { section: Section; label: string; icon: ReactNode }[] = [
  { section: "overview", label: "Overview", icon: <path d="M3 13h4v7H3zM10 4h4v16h-4zM17 9h4v11h-4z" /> },
  { section: "reports", label: "Reports", icon: <path d="M5 3h10l4 4v14H5zM14 3v5h5M8 12h8M8 16h6" /> },
  { section: "commands", label: "Commands", icon: <path d="M4 5h16v14H4zM8 10l3 2-3 2M13 15h4" /> },
  { section: "rules", label: "Rules", icon: <path d="M4 6h10M4 12h16M4 18h7M17 4v4M14 6h6M11 16v4M8 18h6" /> },
  { section: "settings", label: "Settings", icon: <path d="M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM4 12h2M18 12h2M12 4v2M12 18v2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4" /> },
  { section: "reliability", label: "Reliability", icon: <path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6zM8.5 12l2.5 2.5 4.5-5" /> },
];

type Theme = "system" | "light" | "dark";

function readTheme(): Theme {
  try {
    const v = localStorage.getItem("sb-theme");
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function applyTheme(theme: Theme) {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem("sb-theme", theme);
  } catch {
    // private mode: the choice just won't persist
  }
}

export function GuildIcon({ guild }: { guild: GuildSummaryDTO }) {
  return (
    <span className="guild-icon" aria-hidden="true">
      {guild.iconUrl ? <img src={guild.iconUrl} alt="" /> : guild.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function Layout({
  me,
  guild,
  section,
  children,
  onLoggedOut,
}: {
  me: MeDTO;
  guild: GuildSummaryDTO | null;
  section: Section | null;
  children: ReactNode;
  onLoggedOut: () => void;
}) {
  const { path } = useLocation();
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => applyTheme(theme), [theme]);

  const logout = async () => {
    await api.post("/api/auth/logout").catch(() => undefined);
    onLoggedOut();
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <img src="/favicon.svg" alt="" />
          Switchboard
        </div>

        <div className="guild-switcher">
          <label htmlFor="guild-select">Server</label>
          <div className="guild-current">
            {guild && <GuildIcon guild={guild} />}
            <select
              id="guild-select"
              className="select"
              value={guild?.id ?? ""}
              onChange={(e) => navigate(e.target.value === "+" ? "/connect" : `/g/${e.target.value}${section && section !== "overview" ? `/${section}` : ""}`)}
            >
              {!guild && <option value="">Choose a server…</option>}
              {me.guilds.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
              <option value="+">＋ Connect another server</option>
            </select>
          </div>
        </div>

        {guild && (
          <nav className="nav" aria-label="Sections">
            {NAV.map((item) => {
              const to = item.section === "overview" ? `/g/${guild.id}` : `/g/${guild.id}/${item.section}`;
              return (
                <Link key={item.section} to={to} aria-current={section === item.section ? "page" : undefined}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    {item.icon}
                  </svg>
                  {item.label}
                </Link>
              );
            })}
          </nav>
        )}
        {!guild && path !== "/connect" && (
          <nav className="nav">
            <Link to="/connect">Connect a server</Link>
          </nav>
        )}

        <div className="sidebar-footer">
          <div className="row">
            <span className="who" title={me.email}>
              {me.email}
            </span>
            <button type="button" className="btn btn-sm btn-ghost" onClick={logout}>
              Log out
            </button>
          </div>
          <div className="row">
            <label htmlFor="theme-select" className="muted">
              Theme
            </label>
            <select id="theme-select" className="select" style={{ width: "auto", minHeight: 30, padding: "3px 8px" }} value={theme} onChange={(e) => setTheme(e.target.value as Theme)}>
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </div>
        </div>
      </aside>
      <main className="main">
        <div className="content">{children}</div>
      </main>
    </div>
  );
}
