import { api, type AgentCall, type Fact, type Overview } from "../lib/api";
import type { AsyncState } from "../lib/useAsync";
import { useAsync } from "../lib/useAsync";
import { errorMessage } from "../App";
import { EmptyState, ErrorRetry, LoadingLine, Metric, PanelHeader, Surface } from "../components/ui";
import { FactSuggestion } from "../components/Provenance";
import { relativeDay, titleCase } from "../lib/format";
import { useState } from "react";

type Notify = (message: string, tone?: "ok" | "error") => void;

export function TodayScreen({
  overview,
  notify,
  onGoTo,
}: {
  overview: AsyncState<Overview>;
  notify: Notify;
  onGoTo: (screen: "people" | "reconnect" | "connections" | "agents") => void;
}) {
  const data = overview.data;
  const counts = data?.counts;

  return (
    <div className="screen">
      <Surface>
        <PanelHeader
          eyebrow="Workspace"
          title="Today"
          detail="What needs you right now: facts waiting on your call, follow-ups that have come due, and the sources that have gone quiet."
          action={
            <button className="button secondary" onClick={() => onGoTo("agents")}>
              Connect an agent
            </button>
          }
        />

        <div className="grid-metrics">
          <Metric label="People" value={counts?.people ?? "—"} />
          <Metric label="Facts to review" value={counts?.proposed ?? "—"} tone={counts?.proposed ? "warning" : undefined} />
          <Metric label="Reconnect ready" value={counts?.reconnectReady ?? "—"} />
          <Metric label="Messages" value={counts?.messages ?? "—"} />
          <Metric label="Meetings" value={counts?.meetings ?? "—"} />
          <Metric label="Agent calls · 24h" value={counts?.agents24h ?? "—"} />
        </div>
      </Surface>

      {data?.stale.length ? (
        <div className="banner">
          <strong>{data.stale.length} source{data.stale.length === 1 ? "" : "s"} need attention</strong>
          <span>
            {data.stale.map((row) => `${row.label} (${row.status})`).join(" · ")} —{" "}
            <button className="button ghost tiny" onClick={() => onGoTo("connections")}>
              see connections
            </button>
          </span>
        </div>
      ) : null}

      <NeedsYourCall notify={notify} />

      <Surface>
        <PanelHeader eyebrow="Outreach" title="Follow-ups due" detail="Review dates you set on things you already sent. Nothing here sends anything." />
        {overview.loading && !data ? (
          <LoadingLine />
        ) : overview.error ? (
          <ErrorRetry message={overview.error} onRetry={overview.reload} />
        ) : data && data.due.length > 0 ? (
          <ul className="list">
            {data.due.map((row) => (
              <li key={row.id} className="row" style={{ cursor: "default" }}>
                <div className="row-main">
                  <div className="row-title">{row.subject || "(no subject)"}</div>
                  <div className="row-meta">{row.channel}</div>
                </div>
                <div className="row-side">
                  <span className="pill warning">due {relativeDay(row.followup_at)}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            title="Nothing is due"
            body="Use log_outreach from an agent (or the CLI) to record what you sent and when to look again."
          />
        )}
      </Surface>

      <Surface>
        <PanelHeader eyebrow="Agents" title="What agents did" detail="Every call an agent makes against this graph is logged — allowed, denied or failed." />
        {data && data.agent_calls.length > 0 ? (
          <ul className="list">
            {data.agent_calls.map((call: AgentCall) => (
              <li key={call.id} className="row" style={{ cursor: "default" }}>
                <div className="row-main">
                  <div className="row-title">{call.tool}</div>
                  <div className="row-meta">
                    {call.agent_name ?? "unnamed agent"} · {call.duration_ms}ms
                  </div>
                </div>
                <div className="row-side">
                  <span className={`pill ${call.status === "ok" ? "positive" : call.status === "denied" ? "danger" : "warning"}`}>
                    {call.status}
                  </span>
                  <span className="row-time">{relativeDay(call.created_at)}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            title="No agent has called yet"
            body="Point Claude Code, Codex or any MCP client at your endpoint and the calls land here."
            action={
              <button className="button" onClick={() => onGoTo("agents")}>
                Get the connection details
              </button>
            }
          />
        )}
      </Surface>
    </div>
  );
}

function NeedsYourCall({ notify }: { notify: Notify }) {
  const facts = useAsync<{ facts: Fact[] }>(
    () => api.tool("list_facts", { status: "PROPOSED", limit: 10 }),
    [],
  );
  const [pending, setPending] = useState<number | null>(null);

  const decide = (factId: number, decision: "accept" | "dismiss") => {
    setPending(factId);
    api
      .tool("decide_fact", { fact_id: factId, decision })
      .then(() => {
        notify(decision === "accept" ? "Added to the record." : "Dismissed — it won't be suggested again.");
        facts.reload();
      })
      .catch((err: unknown) => notify(errorMessage(err), "error"))
      .finally(() => setPending(null));
  };

  return (
    <Surface>
      <PanelHeader
        eyebrow="Evidence"
        title="Needs your call"
        detail="The system found these but would not write them without you. Accepting freezes the field as yours — an agent can never overwrite it."
      />
      {facts.loading && !facts.data ? (
        <LoadingLine />
      ) : facts.error ? (
        <ErrorRetry message={facts.error} onRetry={facts.reload} />
      ) : facts.data && facts.data.facts.length > 0 ? (
        facts.data.facts.map((fact) => (
          <FactSuggestion
            key={fact.id}
            value={`${titleCase(fact.field)}: ${fact.value}`}
            rationale={`${fact.rationale}${fact.person_name ? ` — ${fact.person_name}` : ""}`}
            pending={pending === fact.id}
            onAccept={() => decide(fact.id, "accept")}
            onDismiss={() => decide(fact.id, "dismiss")}
          />
        ))
      ) : (
        <EmptyState title="Nothing waiting" body="When an agent proposes something it cannot prove, it lands here for you." />
      )}
    </Surface>
  );
}
