import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type Overview, type SessionInfo } from "./lib/api";
import { useAsync } from "./lib/useAsync";
import { TodayScreen } from "./screens/TodayScreen";
import { PeopleScreen } from "./screens/PeopleScreen";
import { ReconnectScreen } from "./screens/ReconnectScreen";
import { ConnectionsScreen } from "./screens/ConnectionsScreen";
import { AgentsScreen } from "./screens/AgentsScreen";
import { LoginScreen } from "./screens/LoginScreen";
import { LoadingLine, Toast } from "./components/ui";

type Screen = "today" | "people" | "reconnect" | "connections" | "agents";

const NAV: Array<{ id: Screen; label: string; group: string }> = [
  { id: "today", label: "Today", group: "Workspace" },
  { id: "people", label: "People", group: "Workspace" },
  { id: "reconnect", label: "Reconnect", group: "Workspace" },
  { id: "connections", label: "Connections", group: "Setup" },
  { id: "agents", label: "Agents", group: "Setup" },
];

export function App() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [checked, setChecked] = useState(false);
  const [screen, setScreen] = useState<Screen>("today");
  const [theme, setTheme] = useState<"light" | "dark">(
    () => (localStorage.getItem("rel-theme") as "light" | "dark" | null) ?? "light",
  );
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "error" } | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("rel-theme", theme);
  }, [theme]);

  useEffect(() => {
    api
      .session()
      .then(setSession)
      .catch(() => setSession(null))
      .finally(() => setChecked(true));
  }, []);

  const notify = useCallback((message: string, tone: "ok" | "error" = "ok") => {
    setToast({ message, tone });
    window.setTimeout(() => setToast(null), 4000);
  }, []);

  const overview = useAsync<Overview>(() => api.overview(), [session?.authed, screen]);

  const counts = overview.data?.counts;
  const badges: Partial<Record<Screen, number>> = {
    people: counts?.proposed,
    reconnect: counts?.reconnectReady,
    agents: counts?.agents24h,
  };

  if (!checked) {
    return (
      <div className="login-wrap">
        <LoadingLine label="Checking your session…" />
      </div>
    );
  }

  if (!session?.authed) {
    return (
      <LoginScreen
        configured={session?.configured ?? true}
        onSignedIn={() => {
          api.session().then(setSession).catch(() => undefined);
        }}
      />
    );
  }

  const groups = [...new Set(NAV.map((item) => item.group))];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">RM</span>
          <span>
            <span className="brand-name">Relationship Manager</span>
            <br />
            <span className="brand-sub">{session.app ?? ""}</span>
          </span>
        </div>

        {groups.map((group) => (
          <div key={group}>
            <div className="nav-group-label">{group}</div>
            {NAV.filter((item) => item.group === group).map((item) => (
              <button
                key={item.id}
                className={`nav-item${screen === item.id ? " active" : ""}`}
                onClick={() => setScreen(item.id)}
              >
                {item.label}
                {badges[item.id] ? <span className="nav-count">{badges[item.id]}</span> : null}
              </button>
            ))}
          </div>
        ))}

        <div className="sidebar-foot">
          <button className="nav-item" onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
            {theme === "light" ? "Dark theme" : "Light theme"}
          </button>
          <button
            className="nav-item"
            onClick={() => {
              api.logout().finally(() => {
                window.location.reload();
              });
            }}
          >
            Sign out
          </button>
        </div>
      </aside>

      <main className="app-main">
        <div className="topbar">
          <span className="topbar-title">
            {NAV.find((item) => item.id === screen)?.label ?? "Workspace"}
          </span>
          <div className="topbar-right">
            {overview.data?.stale.length ? (
              <span className="pill warning" title="Some sources have not synced in a while">
                <span className="dot" /> {overview.data.stale.length} source
                {overview.data.stale.length === 1 ? "" : "s"} stale
              </span>
            ) : null}
            <span className="pill" title="Signed in">
              {session.kind === "agent" ? `agent · ${session.name}` : "you"}
            </span>
          </div>
        </div>

        <div className="app-body">
          {screen === "today" ? <TodayScreen overview={overview} notify={notify} onGoTo={setScreen} /> : null}
          {screen === "people" ? <PeopleScreen notify={notify} /> : null}
          {screen === "reconnect" ? <ReconnectScreen notify={notify} /> : null}
          {screen === "connections" ? <ConnectionsScreen /> : null}
          {screen === "agents" ? <AgentsScreen notify={notify} /> : null}
        </div>
      </main>

      {toast ? <Toast message={toast.message} tone={toast.tone} onDismiss={() => setToast(null)} /> : null}
    </div>
  );
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : String(err);
}
