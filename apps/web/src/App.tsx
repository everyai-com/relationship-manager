import { useCallback, useEffect, useState } from "react";
import { Search } from "lucide-react";
import { api, ApiError, type Overview, type SessionInfo } from "./lib/api";
import { useAsync } from "./lib/useAsync";
import { TodayScreen } from "./screens/TodayScreen";
import { AskScreen } from "./screens/AskScreen";
import { PeopleScreen } from "./screens/PeopleScreen";
import { PipelineScreen } from "./screens/PipelineScreen";
import { ReconnectScreen } from "./screens/ReconnectScreen";
import { ConnectionsScreen } from "./screens/ConnectionsScreen";
import { AgentsScreen } from "./screens/AgentsScreen";
import { AuthScreen } from "./screens/AuthScreen";
import { PersonDetail } from "./screens/PersonDetail";
import { CommandPalette, type ScreenId } from "./components/CommandPalette";
import { LoadingLine, Toast } from "./components/ui";

const NAV: Array<{ id: ScreenId; label: string; group: string }> = [
  { id: "today", label: "Today", group: "Workspace" },
  { id: "ask", label: "Ask", group: "Workspace" },
  { id: "people", label: "People", group: "Workspace" },
  { id: "pipeline", label: "Pipeline", group: "Workspace" },
  { id: "reconnect", label: "Reconnect", group: "Workspace" },
  { id: "connections", label: "Connections", group: "Setup" },
  { id: "agents", label: "Agents", group: "Setup" },
];

export function App() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [checked, setChecked] = useState(false);
  const [screen, setScreen] = useState<ScreenId>("today");
  const [openPerson, setOpenPerson] = useState<number | null>(null);
  const [askPerson, setAskPerson] = useState<number | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((value) => !value);
      }
      if (event.key === "/" && !paletteOpen) {
        const target = event.target as HTMLElement | null;
        if (target && /input|textarea|select/i.test(target.tagName)) return;
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paletteOpen]);

  const notify = useCallback((message: string, tone: "ok" | "error" = "ok") => {
    setToast({ message, tone });
    window.setTimeout(() => setToast(null), 4000);
  }, []);

  const overview = useAsync<Overview>(() => api.overview(), [session?.authed, screen]);

  const counts = overview.data?.counts;
  const badges: Partial<Record<ScreenId, number>> = {
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
      <AuthScreen
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
            <span className="brand-sub">{session.kind === "agent" ? session.name : "your graph, agent-ready"}</span>
          </span>
        </div>

        <button className="nav-item" onClick={() => setPaletteOpen(true)} style={{ marginBottom: "var(--space-2)" }}>
          <Search size={13} />
          Search
          <span className="nav-count">
            <kbd>⌘K</kbd>
          </span>
        </button>

        {groups.map((group) => (
          <div key={group}>
            <div className="nav-group-label">{group}</div>
            {NAV.filter((item) => item.group === group).map((item) => (
              <button
                key={item.id}
                className={`nav-item${screen === item.id ? " active" : ""}`}
                onClick={() => {
                  setScreen(item.id);
                  setOpenPerson(null);
                }}
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
              api.signOut().finally(() => {
                window.location.reload();
              });
            }}
          >
            Sign out
          </button>
          <p className="signature" title={session.model ? `Grounded answers: ${session.model}` : undefined}>
            {session.signature ?? "Built by Phanindra Reddy at Saphaare Labs"}
          </p>
        </div>
      </aside>

      <main className="app-main">
        <div className="topbar">
          <span className="topbar-title">{NAV.find((item) => item.id === screen)?.label ?? "Workspace"}</span>
          <div className="topbar-right">
            {overview.data?.stale.length ? (
              <span className="pill warning" title="Some sources have not synced in a while">
                <span className="dot" /> {overview.data.stale.length} source
                {overview.data.stale.length === 1 ? "" : "s"} stale
              </span>
            ) : null}
            <span className="pill" title={session.account?.email ?? "Signed in"}>
              {session.kind === "agent" ? `agent · ${session.name}` : (session.account?.email ?? "you")}
            </span>
          </div>
        </div>

        <div className="app-body">
          {screen === "today" ? (
            <TodayScreen
              overview={overview}
              notify={notify}
              onGoTo={(next) => setScreen(next)}
            />
          ) : null}
          {screen === "ask" ? (
            <AskScreen
              notify={notify}
              onOpenPerson={setOpenPerson}
              focusPerson={askPerson}
              onFocusConsumed={() => setAskPerson(null)}
            />
          ) : null}
          {screen === "people" ? (
            <PeopleScreen
              notify={notify}
              onOpenPerson={setOpenPerson}
              onGoToPipeline={() => setScreen("pipeline")}
            />
          ) : null}
          {screen === "pipeline" ? (
            <PipelineScreen notify={notify} onOpenPerson={setOpenPerson} onGoToPeople={() => setScreen("people")} />
          ) : null}
          {screen === "reconnect" ? <ReconnectScreen notify={notify} /> : null}
          {screen === "connections" ? <ConnectionsScreen notify={notify} /> : null}
          {screen === "agents" ? <AgentsScreen notify={notify} /> : null}
        </div>

        {openPerson ? (
          <PersonDetail
            personId={openPerson}
            notify={notify}
            onClose={() => setOpenPerson(null)}
            onStageChanged={overview.reload}
            onAskAbout={(id) => {
              setAskPerson(id);
              setOpenPerson(null);
              setScreen("ask");
            }}
          />
        ) : null}

        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          onNavigate={(next) => setScreen(next)}
          onOpenPerson={(id) => setOpenPerson(id)}
        />

        {toast ? <Toast message={toast.message} tone={toast.tone} onDismiss={() => setToast(null)} /> : null}
      </main>
    </div>
  );
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : String(err);
}
