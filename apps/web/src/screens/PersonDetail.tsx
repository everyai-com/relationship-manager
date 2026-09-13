import { useState } from "react";
import { Briefcase, Link2, Mail, MessageCircle, MessageSquare, Sparkles } from "lucide-react";
import { api, type Fact, type PersonDetail as PersonDetailData, type TimelineEntry } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { errorMessage } from "../App";
import { Drawer } from "../components/Drawer";
import { Avatar } from "../components/Avatar";
import { ErrorRetry, LoadingLine, Markdown } from "../components/ui";
import { FactSuggestion, SourcedValue } from "../components/Provenance";
import { day, hostOf, relativeDay, titleCase } from "../lib/format";

type Notify = (message: string, tone?: "ok" | "error") => void;
type Tab = "overview" | "history" | "brief";

// Kept in step with PIPELINE_STAGES in packages/core — a select that offers a
// stage the API refuses is a dead end the user only finds by clicking it.
const STAGES = [
  "",
  "Needs review",
  "Ready",
  "Contacted",
  "Replied",
  "Meeting",
  "Proposal",
  "Won",
  "On hold",
  "Closed",
  "Excluded",
];

const KIND_LABEL: Record<TimelineEntry["kind"], string> = {
  email: "email",
  meeting: "meeting",
  call: "call",
  whatsapp: "whatsapp",
  linkedin: "linkedin",
  instagram: "instagram",
};

/**
 * The full profile, in a drawer beside whatever you were doing.
 * Overview = what is known and what needs you; History = the chronology;
 * Brief = the deterministic brief, rendered here rather than dumped into chat.
 */
export function PersonDetail({
  personId,
  notify,
  onClose,
  onStageChanged,
  onAskAbout,
}: {
  personId: number;
  notify: Notify;
  onClose: () => void;
  onStageChanged?: () => void;
  onAskAbout?: (personId: number) => void;
}) {
  const [tab, setTab] = useState<Tab>("overview");
  const [brief, setBrief] = useState<string | null>(null);
  const [prepping, setPrepping] = useState(false);
  const [pending, setPending] = useState<number | null>(null);
  const [stage, setStage] = useState<string | null>(null);

  const detail = useAsync<PersonDetailData>(() => api.tool("get_person", { person_id: personId }), [personId]);
  const timeline = useAsync<{ timeline: TimelineEntry[] }>(
    () => api.tool("person_timeline", { person_id: personId, limit: 60 }),
    [personId],
  );

  const person = detail.data?.person;
  const currentStage = stage ?? person?.stage ?? "";
  const facts = detail.data?.facts ?? [];
  const applied = facts.filter((fact) => fact.status === "APPLIED");
  const proposed = facts.filter((fact) => fact.status === "PROPOSED");
  const identifiers = detail.data?.identifiers;

  const decide = (fact: Fact, decision: "accept" | "dismiss") => {
    setPending(fact.id);
    api
      .tool("decide_fact", { fact_id: fact.id, decision })
      .then(() => {
        notify(decision === "accept" ? "Added to the record — that field is yours now." : "Dismissed for good.");
        detail.reload();
      })
      .catch((error: unknown) => notify(errorMessage(error), "error"))
      .finally(() => setPending(null));
  };

  const changeStage = (next: string) => {
    const previous = currentStage;
    setStage(next);
    api
      .setStage(personId, next)
      .then((result) => {
        notify(result.note, "ok");
        onStageChanged?.();
      })
      .catch((error: unknown) => {
        setStage(previous);
        notify(errorMessage(error), "error");
      });
  };

  const prep = () => {
    setPrepping(true);
    setTab("brief");
    api
      .tool<{ brief: string }>("prep_brief", { person_id: personId })
      .then((result) => setBrief(result.brief))
      .catch((error: unknown) => notify(errorMessage(error), "error"))
      .finally(() => setPrepping(false));
  };

  const email = identifiers?.emails[0] ?? person?.email ?? "";
  const linkedin = identifiers?.linkedin[0] ?? "";
  const waNumber = identifiers?.phones[0] ?? identifiers?.wa_jids[0]?.split("@")[0] ?? "";

  return (
    <Drawer
      open
      onClose={onClose}
      title={
        <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "center" }}>
          <Avatar name={person?.name || person?.email || "?"} size="lg" />
          <div style={{ minWidth: 0 }}>
            <h2 style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {person ? person.name || person.email : "…"}
            </h2>
            <p>
              {person
                ? [person.title, person.company || person.company_domain].filter(Boolean).join(" · ") ||
                  person.email
                : "loading"}
            </p>
          </div>
        </div>
      }
      footer={
        <>
          <select
            className="stage-select"
            value={currentStage}
            aria-label="Pipeline stage"
            onChange={(event) => changeStage(event.target.value)}
          >
            {STAGES.map((option) => (
              <option key={option || "none"} value={option}>
                {option || "Not in the pipeline"}
              </option>
            ))}
          </select>
          <span style={{ flex: 1 }} />
          {onAskAbout ? (
            <button
              className="button secondary"
              title="Open Ask with this person's record pinned"
              onClick={() => onAskAbout(personId)}
            >
              <MessageCircle size={13} /> Ask about them
            </button>
          ) : null}
          <button className="button" onClick={prep} disabled={prepping}>
            {prepping ? <span className="spinner" aria-hidden /> : <Sparkles size={13} />} Prep me
          </button>
        </>
      }
    >
      {detail.error ? (
        <ErrorRetry message={detail.error} onRetry={detail.reload} />
      ) : detail.loading && !detail.data ? (
        <LoadingLine label="Reading the record…" />
      ) : (
        <>
          <div className="action-row" style={{ marginBottom: "var(--space-4)" }}>
            {email ? (
              <a className="quick-link" href={`mailto:${email}`} title={email}>
                <Mail size={13} /> Email
              </a>
            ) : null}
            {linkedin ? (
              <a className="quick-link" href={linkedin} target="_blank" rel="noreferrer" title={linkedin}>
                <Link2 size={13} /> LinkedIn
              </a>
            ) : null}
            {waNumber ? (
              <a className="quick-link" href={`https://wa.me/${waNumber}`} target="_blank" rel="noreferrer" title={`WhatsApp ${waNumber}`}>
                <MessageSquare size={13} /> WhatsApp
              </a>
            ) : null}
            {person?.company_domain ? (
              <a className="quick-link" href={`https://${person.company_domain}`} target="_blank" rel="noreferrer">
                <Briefcase size={13} /> {person.company_domain}
              </a>
            ) : null}
          </div>

          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === "overview"} onClick={() => setTab("overview")}>
              Overview {proposed.length ? `(${proposed.length} to review)` : ""}
            </button>
            <button role="tab" aria-selected={tab === "history"} onClick={() => setTab("history")}>
              History
            </button>
            <button role="tab" aria-selected={tab === "brief"} onClick={() => setTab("brief")}>
              Brief
            </button>
          </div>

          {tab === "overview" ? (
            <>
              <section className="section" style={{ marginTop: 0 }}>
                <div className="section-label">Needs your call</div>
                {proposed.length === 0 ? (
                  <p style={{ fontSize: 13, color: "var(--gray-500)" }}>Nothing proposed for this person.</p>
                ) : (
                  proposed.map((fact) => (
                    <FactSuggestion
                      key={fact.id}
                      value={`${titleCase(fact.field)}: ${fact.value}`}
                      rationale={fact.rationale}
                      pending={pending === fact.id}
                      onAccept={() => decide(fact, "accept")}
                      onDismiss={() => decide(fact, "dismiss")}
                    />
                  ))
                )}
              </section>

              <section className="section">
                <div className="section-label">On file</div>
                {applied.length === 0 ? (
                  <p style={{ fontSize: 13, color: "var(--gray-500)" }}>
                    Nothing confirmed by you yet — anything above came from the sources, not from a decision.
                  </p>
                ) : (
                  applied.map((fact) => (
                    <div className="fact-row" key={fact.id}>
                      <div className="fact-field">{titleCase(fact.field)}</div>
                      <div className="fact-value">
                        <SourcedValue
                          claim={`${titleCase(fact.field)}: ${fact.value}`}
                          reasons={fact.reasons.length ? fact.reasons : [fact.rationale]}
                          observedAt={day(fact.observed_at)}
                          sourceHost={hostOf(fact.source_url)}
                        >
                          {fact.value}
                        </SourcedValue>
                      </div>
                      <span className="pill mono">{fact.band.toLowerCase()}</span>
                    </div>
                  ))
                )}
              </section>

              {identifiers ? (
                <section className="section">
                  <div className="section-label">Reachable on</div>
                  <div className="chip-row">
                    {identifiers.emails.map((value) => (
                      <a className="chip" key={value} href={`mailto:${value}`}>
                        {value}
                      </a>
                    ))}
                    {identifiers.phones.map((value) => (
                      <a className="chip" key={value} href={`https://wa.me/${value}`} target="_blank" rel="noreferrer">
                        {value}
                      </a>
                    ))}
                    {identifiers.linkedin.map((value) => (
                      <a className="chip" key={value} href={value} target="_blank" rel="noreferrer">
                        in/{value.split("/in/")[1] ?? value}
                      </a>
                    ))}
                    {identifiers.instagram.map((value) => (
                      <a className="chip" key={value} href={`https://instagram.com/${value}`} target="_blank" rel="noreferrer">
                        @{value}
                      </a>
                    ))}
                    {identifiers.fathom.map((value) => (
                      <span className="chip" key={value}>
                        {value}
                      </span>
                    ))}
                  </div>
                </section>
              ) : null}

              <section className="section">
                <div className="section-label">In numbers</div>
                <div className="chip-row">
                  <span className="chip">{person?.message_count ?? 0} messages</span>
                  <span className="chip">{person?.meeting_count ?? 0} meetings</span>
                  <span className="chip">first seen {relativeDay(person?.first_seen)}</span>
                  <span className="chip">last touch {relativeDay(person?.last_touch)}</span>
                </div>
              </section>
            </>
          ) : null}

          {tab === "history" ? (
            <>
              {timeline.error ? (
                <ErrorRetry message={timeline.error} onRetry={timeline.reload} />
              ) : timeline.loading && !timeline.data ? (
                <LoadingLine />
              ) : timeline.data && timeline.data.timeline.length > 0 ? (
                <ul className="timeline">
                  {timeline.data.timeline.map((entry) => (
                    <li key={`${entry.kind}-${entry.id}`}>
                      <span className="timeline-kind">{KIND_LABEL[entry.kind] ?? entry.kind}</span>
                      <span className="timeline-title">
                        {entry.link ? (
                          <a href={entry.link} target="_blank" rel="noreferrer">
                            {entry.title}
                          </a>
                        ) : (
                          entry.title
                        )}
                        {entry.detail ? <span className="timeline-detail">{entry.detail}</span> : null}
                      </span>
                      <span className="timeline-time">{relativeDay(entry.at)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p style={{ fontSize: 13, color: "var(--gray-500)" }}>
                  Nothing yet beyond the address. Mail, meetings and messages land here as the graph is fed.
                </p>
              )}
            </>
          ) : null}

          {tab === "brief" ? (
            <>
              {prepping ? (
                <LoadingLine label="Building the brief…" />
              ) : brief ? (
                <Markdown content={brief} />
              ) : (
                <div className="empty">
                  <div className="empty-title">No brief yet</div>
                  <p className="empty-body">
                    The brief is deterministic — it reads the record and writes it up, with no model involved.
                  </p>
                  <button className="button" onClick={prep}>
                    <Sparkles size={13} /> Prep me
                  </button>
                </div>
              )}
            </>
          ) : null}
        </>
      )}
    </Drawer>
  );
}
