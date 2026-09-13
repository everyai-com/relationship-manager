import { useState } from "react";
import { api, type AgentCall, type AgentKey, type ToolCatalogEntry } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { errorMessage } from "../App";
import { CopyField, EmptyState, ErrorRetry, LoadingLine, PanelHeader, Surface } from "../components/ui";
import { clock, relativeDay } from "../lib/format";

type Notify = (message: string, tone?: "ok" | "error") => void;

export function AgentsScreen({ notify }: { notify: Notify }) {
  const endpoint = `${window.location.origin}/mcp`;
  const keys = useAsync<{ keys: AgentKey[]; paused: boolean }>(() => api.agents(), []);
  const calls = useAsync<{ calls: AgentCall[] }>(() => api.calls(40), []);
  const catalog = useAsync<{ tools: ToolCatalogEntry[] }>(() => api.catalog(), []);

  const [name, setName] = useState("");
  const [scope, setScope] = useState<"read" | "write">("read");
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testQuery, setTestQuery] = useState("LucidWay");
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const paused = keys.data?.paused ?? false;

  const create = () => {
    setBusy(true);
    api
      .createAgent(name.trim() || "Unnamed agent", scope)
      .then((created) => {
        setFreshKey(created.key);
        setName("");
        notify("Key created. Copy it now — it is shown once.");
        keys.reload();
      })
      .catch((err: unknown) => notify(errorMessage(err), "error"))
      .finally(() => setBusy(false));
  };

  const revoke = (id: number) => {
    api
      .revokeAgent(id)
      .then(() => {
        notify("Key revoked.");
        keys.reload();
      })
      .catch((err: unknown) => notify(errorMessage(err), "error"));
  };

  const togglePause = () => {
    api
      .pauseAgents(!paused)
      .then(() => {
        notify(paused ? "Agents are allowed again." : "All agent access paused.");
        keys.reload();
      })
      .catch((err: unknown) => notify(errorMessage(err), "error"));
  };

  const runTest = () => {
    setTesting(true);
    setTestResult(null);
    api
      .tool("search_people", { query: testQuery, limit: 3 })
      .then((result) => setTestResult(JSON.stringify(result, null, 2)))
      .catch((err: unknown) => setTestResult(`error: ${errorMessage(err)}`))
      .finally(() => setTesting(false));
  };

  return (
    <div className="screen">
      <Surface>
        <PanelHeader
          eyebrow="Agents first"
          title="Your MCP endpoint"
          detail="This deployment is an MCP server. Anything that speaks MCP — Claude Code, Codex, Cursor — can call the tools below. Reads are open to any valid key; writes need the write scope, and every call is logged."
          action={
            <button className="button secondary" onClick={togglePause}>
              {paused ? "Resume agents" : "Pause all agents"}
            </button>
          }
        />

        {paused ? (
          <div className="banner" style={{ marginBottom: "var(--space-4)" }}>
            Agent access is paused. Every tool call from a key is currently denied.
          </div>
        ) : null}

        <CopyField title="MCP endpoint (Streamable HTTP)" value={endpoint} />

        {freshKey ? (
          <p className="conn-note" style={{ marginTop: "var(--space-2)" }}>
            A new key was just minted, so the configs below already carry it — this is the only time it is shown.
          </p>
        ) : null}

        <div style={{ marginTop: "var(--space-4)", display: "grid", gap: "var(--space-3)" }}>
          <CopyField
            title="Claude Code"
            value={`claude mcp add --transport http relationship-manager ${endpoint} \\\n  --header "Authorization: Bearer ${freshKey ?? "rel_..."}"`}
          />
          <CopyField
            title="Codex (~/.codex/config.toml)"
            value={`[mcp_servers.relationship-manager]\nurl = "${endpoint}"\nhttp_headers = { Authorization = "Bearer ${freshKey ?? "rel_..."}" }`}
          />
          <CopyField
            title="Cursor / any JSON MCP config"
            value={`{\n  "mcpServers": {\n    "relationship-manager": {\n      "url": "${endpoint}",\n      "headers": { "Authorization": "Bearer ${freshKey ?? "rel_..."}" }\n    }\n  }\n}`}
          />
        </div>

        <div className="section">
          <div className="section-label">Try it from here</div>
          <div style={{ display: "flex", gap: "var(--space-2)", maxWidth: 520 }}>
            <input
              className="input"
              value={testQuery}
              onChange={(event) => setTestQuery(event.target.value)}
              placeholder="Search the graph as an agent would"
              aria-label="Test query"
            />
            <button className="button" onClick={runTest} disabled={testing}>
              {testing ? "Running…" : "Run search_people"}
            </button>
          </div>
          {testResult ? (
            <div className="code" style={{ marginTop: "var(--space-3)", maxHeight: 320, overflow: "auto" }}>
              {testResult}
            </div>
          ) : null}
        </div>
      </Surface>

      <Surface>
        <PanelHeader
          eyebrow="Access"
          title="Agent keys"
          detail="One key per agent, so you can revoke one without touching the rest. The plaintext is shown once; only its hash is stored."
        />

        {keys.error ? (
          <ErrorRetry message={keys.error} onRetry={keys.reload} />
        ) : keys.loading && !keys.data ? (
          <LoadingLine />
        ) : (
          <>
            <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", marginBottom: "var(--space-4)" }}>
              <input
                className="input"
                style={{ maxWidth: 240 }}
                placeholder="Agent name (e.g. Claude Code)"
                value={name}
                onChange={(event) => setName(event.target.value)}
                aria-label="Agent name"
              />
              <select
                className="select"
                style={{ maxWidth: 160 }}
                value={scope}
                onChange={(event) => setScope(event.target.value as "read" | "write")}
                aria-label="Scope"
              >
                <option value="read">read only</option>
                <option value="write">read + write</option>
              </select>
              <button className="button" onClick={create} disabled={busy}>
                Create key
              </button>
            </div>

            {freshKey ? (
              <div style={{ marginBottom: "var(--space-4)" }}>
                <div className="banner info" style={{ marginBottom: "var(--space-2)" }} role="status">
                  Copy this now — it cannot be shown again.
                </div>
                <CopyField title="New key" value={freshKey} />
              </div>
            ) : null}

            {keys.data && keys.data.keys.length > 0 ? (
              <ul className="list">
                {keys.data.keys.map((key) => (
                  <li key={key.id} className="row" style={{ cursor: "default" }}>
                    <div className="row-main">
                      <div className="row-title">{key.name}</div>
                      <div className="row-meta">
                        {key.scopes} · created {relativeDay(key.created_at)} ·{" "}
                        {key.last_seen_at ? `last used ${relativeDay(key.last_seen_at)}` : "never used"}
                      </div>
                    </div>
                    <div className="row-side">
                      {key.revoked_at ? (
                        <span className="pill danger">revoked</span>
                      ) : (
                        <button className="button ghost tiny" onClick={() => revoke(key.id)}>
                          Revoke
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="No keys yet" body="Create one above, then paste it into your MCP client config." />
            )}
          </>
        )}
      </Surface>

      <Surface>
        <PanelHeader eyebrow="Contract" title="Tools" detail="One definition drives MCP, REST and the CLI — what you read here is what an agent calls." />
        {catalog.data ? (
          <ul className="list">
            {catalog.data.tools.map((tool) => (
              <li key={tool.name} className="row" style={{ cursor: "default", alignItems: "flex-start" }}>
                <div className="row-main">
                  <div className="row-title" style={{ fontFamily: "var(--font-mono)", fontSize: 12.5 }}>
                    {tool.name}({tool.args.join(", ")})
                  </div>
                  <div className="row-meta" style={{ whiteSpace: "normal" }}>
                    {tool.description}
                  </div>
                </div>
                <div className="row-side">
                  <span className={`pill ${tool.scope === "write" ? "warning" : ""}`}>{tool.scope}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <LoadingLine />
        )}
      </Surface>

      <Surface>
        <PanelHeader eyebrow="Observability" title="Call log" detail="Every call, from every key — allowed, denied or failed. This is the audit trail for anything an agent did to your graph." />
        {calls.error ? (
          <ErrorRetry message={calls.error} onRetry={calls.reload} />
        ) : calls.loading && !calls.data ? (
          <LoadingLine />
        ) : calls.data && calls.data.calls.length > 0 ? (
          <ul className="list">
            {calls.data.calls.map((call) => (
              <li key={call.id} className="row" style={{ cursor: "default" }}>
                <div className="row-main">
                  <div className="row-title">{call.tool}</div>
                  <div className="row-meta">
                    {call.agent_name ?? "unnamed agent"} · {call.duration_ms}ms
                    {call.detail ? ` · ${call.detail}` : ""}
                  </div>
                </div>
                <div className="row-side">
                  <span className={`pill ${call.status === "ok" ? "positive" : call.status === "denied" ? "danger" : "warning"}`}>
                    {call.status}
                  </span>
                  <span className="row-time">{clock(call.created_at)}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="No calls yet" body="Once an agent connects, every call it makes shows up here." />
        )}
      </Surface>
    </div>
  );
}
