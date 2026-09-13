import { useState } from "react";
import { ArrowLeft, Sparkles } from "lucide-react";
import { api, type Fact, type PersonDetail, type TimelineEntry } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { errorMessage } from "../App";
import { EmptyState, ErrorRetry, LoadingLine, Markdown, PanelHeader, Surface } from "../components/ui";
import { FactSuggestion, SourcedValue } from "../components/Provenance";
import { day, hostOf, relativeDay, titleCase } from "../lib/format";

type Notify = (message: string, tone?: "ok" | "error") => void;

const KIND_LABEL: Record<TimelineEntry["kind"], string> = {
  email: "email",
  meeting: "meeting",
  call: "call",
  whatsapp: "whatsapp",
};

export function PersonSheet({
  personId,
  onBack,
  notify,
}: {
  personId: number;
  onBack: () => void;
  notify: Notify;
}) {
  const detail = useAsync<PersonDetail>(() => api.tool("get_person", { person_id: personId }), [personId]);
  const timeline = useAsync<{ timeline: TimelineEntry[] }>(
    () => api.tool("person_timeline", { person_id: personId, limit: 25 }),
    [personId],
  );

  const [brief, setBrief] = useState<string | null>(null);
  const [prepping, setPrepping] = useState(false);
  const [prepFailed, setPrepFailed] = useState(false);
  const [pending, setPending] = useState<number | null>(null);

  const person = detail.data?.person;
  const facts = detail.data?.facts ?? [];
  const applied = facts.filter((fact) => fact.status === "APPLIED");
  const proposed = facts.filter((fact) => fact.status === "PROPOSED");

  const prep = () => {
    setPrepping(true);
    setPrepFailed(false);
    api
      .tool<{ brief: string }>("prep_brief", { person_id: personId })
      .then((result) => setBrief(result.brief))
      .catch(() => setPrepFailed(true))
      .finally(() => setPrepping(false));
  };

  const decide = (fact: Fact, decision: "accept" | "dismiss") => {
    setPending(fact.id);
    api
      .tool("decide_fact", { fact_id: fact.id, decision })
      .then(() => {
        notify(decision === "accept" ? "Added to the record — that field is yours now." : "Dismissed for good.");
        detail.reload();
      })
      .catch((err: unknown) => notify(errorMessage(err), "error"))
      .finally(() => setPending(null));
  };

  const who = person ? [person.title, person.company || person.company_domain].filter(Boolean).join(" · ") : "";

  return (
    <div className="screen">
      <Surface>
        <div className="sheet-head">
          <button className="icon-button" onClick={onBack} aria-label="Back to people">
            <ArrowLeft size={15} />
          </button>
          <div className="sheet-id">
            <h3>{person ? person.name || person.email : "…"}</h3>
            <p>{who || person?.email || ""}</p>
          </div>
          <div className="panel-action">
            <button className="button" onClick={prep} disabled={prepping}>
              {prepping ? <span className="spinner" aria-hidden /> : <Sparkles size={13} />}
              Prep me
            </button>
          </div>
        </div>

        {detail.error ? (
          <div style={{ marginTop: "var(--space-4)" }}>
            <ErrorRetry message={detail.error} onRetry={detail.reload} />
          </div>
        ) : detail.loading && !detail.data ? (
          <LoadingLine />
        ) : (
          <>
            {prepFailed ? (
              <div className="banner" style={{ marginTop: "var(--space-4)" }} role="alert">
                Could not build the brief just now — try again in a moment.
              </div>
            ) : null}

            {brief ? (
              <section className="section">
                <div className="section-label">Brief</div>
                <Markdown content={brief} />
              </section>
            ) : null}

            <section className="section">
              <div className="section-label">On file</div>
              {applied.length === 0 ? (
                <p style={{ fontSize: 13, color: "var(--gray-500)" }}>
                  Nothing confirmed by you yet — anything in the header came from the sources, not from a decision.
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

            <section className="section">
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

            {detail.data?.identifiers ? (
              <section className="section">
                <div className="section-label">Reachable on</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
                  {[
                    ...detail.data.identifiers.emails.map((v) => ({ label: v, href: `mailto:${v}` })),
                    ...detail.data.identifiers.phones.map((v) => ({ label: v, href: `https://wa.me/${v}` })),
                    ...detail.data.identifiers.wa_jids.map((v) => ({ label: v, href: `https://wa.me/${v.split("@")[0]}` })),
                    ...detail.data.identifiers.linkedin.map((v) => ({ label: `in/${v.split("/in/")[1] ?? v}`, href: v })),
                    ...detail.data.identifiers.instagram.map((v) => ({ label: `@${v}`, href: `https://instagram.com/${v}` })),
                    ...detail.data.identifiers.fathom.map((v) => ({ label: v, href: null })),
                  ].map((item) =>
                    item.href ? (
                      <a className="pill" key={item.label} href={item.href} target="_blank" rel="noreferrer">
                        {item.label}
                      </a>
                    ) : (
                      <span className="pill" key={item.label}>
                        {item.label}
                      </span>
                    ),
                  )}
                </div>
              </section>
            ) : null}
          </>
        )}
      </Surface>

      <Surface>
        <PanelHeader
          eyebrow="History"
          title="Recent"
          detail="Email, meetings, recorded calls, WhatsApp and LinkedIn in one chronology — the ground truth for when you last spoke."
        />
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
          <EmptyState
            title="Nothing yet beyond the address"
            body="Mail, meetings and calls land here as the graph is fed."
          />
        )}
      </Surface>
    </div>
  );
}
