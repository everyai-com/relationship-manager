import { useState } from "react";
import { api, type ReconnectEntry } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { EmptyState, ErrorRetry, LoadingLine, PanelHeader, Surface } from "../components/ui";
import { relativeDay } from "../lib/format";

const COHORTS = [
  "All active",
  "Researched opportunity",
  "Past conversation — review to reconnect",
  "Already contacted — await reply",
  "Incoming only — review",
  "One-way outreach — review",
  "Meeting invite only",
  "Saved contact — no exchange verified",
  "Resolve relationship first",
  "Personal / service / non-sales",
];

export function ReconnectScreen({ notify }: { notify: (message: string, tone?: "ok" | "error") => void }) {
  const [cohort, setCohort] = useState(COHORTS[0]!);
  const [showSuppressed, setShowSuppressed] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const result = useAsync<{ queue: ReconnectEntry[] }>(
    () =>
      api.tool("reconnect_queue", {
        cohort: cohort === "All active" ? undefined : cohort,
        include_suppressed: showSuppressed,
        limit: 100,
      }),
    [cohort, showSuppressed],
  );

  const rows = result.data?.queue ?? [];

  return (
    <div className="screen">
      <Surface>
        <PanelHeader
          eyebrow="Workspace"
          title="Reconnect"
          detail="Ranked by cohort and the signal that put each person there. Suppressed people are deliberate holds — they stay out unless you ask for them."
          action={
            <button
              className="button secondary"
              onClick={() => {
                setShowSuppressed((value) => !value);
                notify(showSuppressed ? "Hiding suppressed records." : "Showing suppressed records (locked).");
              }}
            >
              {showSuppressed ? "Hide suppressed" : "Show suppressed"}
            </button>
          }
        />

        <div className="field" style={{ maxWidth: 340, marginBottom: "var(--space-4)" }}>
          <label className="field-label" htmlFor="cohort">
            Cohort
          </label>
          <select id="cohort" className="select" value={cohort} onChange={(event) => setCohort(event.target.value)}>
            {COHORTS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>

        {result.error ? (
          <ErrorRetry message={result.error} onRetry={result.reload} />
        ) : result.loading && !result.data ? (
          <LoadingLine label="Ranking your reconnect queue…" />
        ) : rows.length === 0 ? (
          <EmptyState
            title="Nothing in this cohort"
            body="Either it is empty or the CRM export has not been imported into this deployment."
          />
        ) : (
          <ul className="list">
            {rows.map((entry) => (
              <li key={entry.contact_id}>
                <button
                  className="row"
                  onClick={() => setOpen(open === entry.contact_id ? null : entry.contact_id)}
                  aria-expanded={open === entry.contact_id}
                >
                  <div className="row-main">
                    <div className="row-title">
                      {entry.name || entry.email || entry.phone}
                      {entry.suppressed ? <span className="pill danger">locked</span> : null}
                    </div>
                    <div className="row-meta">
                      {[entry.cohort, entry.conversation_last ? `last ${relativeDay(entry.conversation_last)}` : null]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  </div>
                  <div className="row-side">
                    {entry.inbound || entry.outbound ? (
                      <span className="pill mono">
                        {entry.inbound}in / {entry.outbound}out
                      </span>
                    ) : null}
                    <span className="row-time">#{entry.priority}</span>
                  </div>
                </button>

                {open === entry.contact_id ? (
                  <div style={{ padding: "var(--space-3) 0 var(--space-4)", borderBottom: "1px solid var(--border)" }}>
                    {entry.signal ? (
                      <p style={{ fontSize: 13, marginBottom: "var(--space-2)" }}>{entry.signal}</p>
                    ) : null}
                    {entry.action ? (
                      <p style={{ fontSize: 12.5, color: "var(--gray-500)", marginBottom: "var(--space-3)" }}>
                        Next: {entry.action}
                      </p>
                    ) : null}
                    <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", marginBottom: "var(--space-3)" }}>
                      {entry.stage ? <span className="pill">{entry.stage}</span> : null}
                      {entry.lane ? <span className="pill">{entry.lane}</span> : null}
                      {entry.conversation_evidence ? <span className="pill">{entry.conversation_evidence}</span> : null}
                      {entry.suppressed ? <span className="pill danger">do not contact</span> : null}
                    </div>
                    {entry.draft && !entry.suppressed ? (
                      <div className="code">
                        <div className="code-head">
                          <span className="code-title">Starter draft · {entry.draft_status || "unreviewed"}</span>
                        </div>
                        {entry.draft}
                      </div>
                    ) : null}
                    <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", marginTop: "var(--space-3)" }}>
                      {entry.email ? (
                        <a className="button ghost tiny" href={`mailto:${entry.email}`}>
                          {entry.email}
                        </a>
                      ) : null}
                      {entry.phone ? (
                        <a className="button ghost tiny" href={`https://wa.me/${entry.phone}`} target="_blank" rel="noreferrer">
                          WhatsApp
                        </a>
                      ) : null}
                      {entry.history_links.slice(0, 3).map((link) => (
                        <a className="button ghost tiny" key={link} href={link} target="_blank" rel="noreferrer">
                          email history
                        </a>
                      ))}
                    </div>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Surface>
    </div>
  );
}
