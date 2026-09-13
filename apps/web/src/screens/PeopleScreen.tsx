import { useState } from "react";
import { ChevronRight, LayoutGrid, Search, Sparkles } from "lucide-react";
import { api, type Fact, type Person, type PersonDetail as PersonDetailData, type TimelineEntry } from "../lib/api";
import { useAsync, useDebounced } from "../lib/useAsync";
import { errorMessage } from "../App";
import { EmptyState, ErrorRetry, PanelHeader, Surface } from "../components/ui";
import { Avatar, SkeletonRows, StageChip } from "../components/Avatar";
import { FactSuggestion, SourcedValue } from "../components/Provenance";
import { day, hostOf, relativeDay, titleCase } from "../lib/format";

type Notify = (message: string, tone?: "ok" | "error") => void;
type SourceFilter = "all" | "email" | "whatsapp" | "linkedin" | "instagram";
type InPipeline = "any" | "in" | "out";

const SOURCE_FILTERS: Array<{ id: SourceFilter; label: string }> = [
  { id: "all", label: "Everyone" },
  { id: "email", label: "Email" },
  { id: "whatsapp", label: "WhatsApp" },
  { id: "linkedin", label: "LinkedIn" },
  { id: "instagram", label: "Instagram" },
];

/**
 * People, with profiles that open in place. A row expands to what is known and
 * what needs a decision; the full profile is one click further, in a drawer,
 * so you never lose the list you were working through.
 */
export function PeopleScreen({
  notify,
  onOpenPerson,
  onGoToPipeline,
}: {
  notify: Notify;
  onOpenPerson: (id: number) => void;
  onGoToPipeline: () => void;
}) {
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query, 200);
  const [source, setSource] = useState<SourceFilter>("all");
  const [pipeline, setPipeline] = useState<InPipeline>("any");
  const [expanded, setExpanded] = useState<number | null>(null);

  const result = useAsync<{ people: Person[] }>(
    () =>
      api.tool("search_people", {
        query: debounced,
        source: source === "all" ? undefined : source,
        stage: pipeline === "any" ? undefined : pipeline === "in" ? undefined : "",
        limit: 60,
      }),
    [debounced, source, pipeline],
  );

  // "In the pipeline" is a filter over the stage column, which search_people
  // only filters in one direction — so the positive case is applied here.
  const rows = (result.data?.people ?? []).filter((person) =>
    pipeline === "in" ? Boolean(person.stage) : true,
  );

  return (
    <div className="screen">
      <Surface flush>
        <div style={{ padding: "var(--space-5) var(--space-5) 0" }}>
          <PanelHeader
            eyebrow="Workspace"
            title="People"
            detail={`Everyone you actually talk to, resolved across email, WhatsApp, LinkedIn, Instagram, calendar and calls. ${rows.length} shown.`}
            action={
              <button className="button secondary" onClick={onGoToPipeline}>
                <LayoutGrid size={13} /> Pipeline
              </button>
            }
          />

          <div className="toolbar">
            <div className="search">
              <Search size={14} />
              <input
                type="search"
                value={query}
                placeholder="Search by name, email, company, domain or handle"
                aria-label="Search people"
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <div className="segmented">
              <button aria-pressed={pipeline === "any"} onClick={() => setPipeline("any")}>
                All
              </button>
              <button aria-pressed={pipeline === "in"} onClick={() => setPipeline("in")}>
                In pipeline
              </button>
              <button aria-pressed={pipeline === "out"} onClick={() => setPipeline("out")}>
                Not placed
              </button>
            </div>
          </div>

          <div className="chip-row" style={{ marginBottom: "var(--space-4)" }}>
            {SOURCE_FILTERS.map((option) => (
              <button
                key={option.id}
                className="chip"
                aria-pressed={source === option.id}
                onClick={() => setSource(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {result.error ? (
          <div style={{ padding: "var(--space-5)" }}>
            <ErrorRetry message={result.error} onRetry={result.reload} />
          </div>
        ) : result.loading && !result.data ? (
          <div style={{ padding: "0 var(--space-5) var(--space-5)" }}>
            <SkeletonRows rows={8} />
          </div>
        ) : rows.length === 0 ? (
          <div style={{ padding: "var(--space-5)" }}>
            <EmptyState
              title={query ? "No one matches that" : "No people yet"}
              body={
                query
                  ? "Try a shorter name, the company's domain, or a handle."
                  : "People appear here as the graph is fed from mail, calendar, calls and social exports."
              }
            />
          </div>
        ) : (
          <div>
            {rows.map((person) => (
              <div key={person.id}>
                <button
                  className={`person-row${expanded === person.id ? " open" : ""}`}
                  onClick={() => setExpanded(expanded === person.id ? null : person.id)}
                  aria-expanded={expanded === person.id}
                >
                  <ChevronRight size={14} className="caret" />
                  <Avatar name={person.name || person.email} />
                  <span className="person-row-main">
                    <span className="person-row-name">
                      {person.name || person.email}
                      {person.proposed_count ? <span className="pill accent">{person.proposed_count} to review</span> : null}
                    </span>
                    <span className="person-row-meta">
                      {[person.title, person.company || person.company_domain].filter(Boolean).join(" · ") ||
                        (person.name ? person.email : `${person.message_count} messages · ${person.meeting_count} meetings`)}
                    </span>
                  </span>
                  <span className="row-side">
                    {person.stage ? <StageChip stage={person.stage} /> : null}
                    <span className="row-time">{relativeDay(person.last_touch)}</span>
                  </span>
                </button>
                {expanded === person.id ? (
                  <PersonPeek
                    personId={person.id}
                    notify={notify}
                    onOpen={() => onOpenPerson(person.id)}
                    onDecided={result.reload}
                  />
                ) : null}
              </div>
            ))}
          </div>
        )}
      </Surface>
    </div>
  );
}

/** The in-place expansion: what is known, what needs you, and the last few things. */
function PersonPeek({
  personId,
  notify,
  onOpen,
  onDecided,
}: {
  personId: number;
  notify: Notify;
  onOpen: () => void;
  onDecided: () => void;
}) {
  const detail = useAsync<PersonDetailData>(() => api.tool("get_person", { person_id: personId }), [personId]);
  const timeline = useAsync<{ timeline: TimelineEntry[] }>(
    () => api.tool("person_timeline", { person_id: personId, limit: 4 }),
    [personId],
  );
  const [pending, setPending] = useState<number | null>(null);
  const [briefing, setBriefing] = useState(false);

  const decide = (fact: Fact, decision: "accept" | "dismiss") => {
    setPending(fact.id);
    api
      .tool("decide_fact", { fact_id: fact.id, decision })
      .then(() => {
        notify(decision === "accept" ? "Added to the record." : "Dismissed for good.");
        detail.reload();
        onDecided();
      })
      .catch((error: unknown) => notify(errorMessage(error), "error"))
      .finally(() => setPending(null));
  };

  const prep = () => {
    setBriefing(true);
    api
      .tool<{ brief: string }>("prep_brief", { person_id: personId })
      .then(() => onOpen())
      .catch((error: unknown) => notify(errorMessage(error), "error"))
      .finally(() => setBriefing(false));
  };

  if (detail.error) return <div className="person-expand"><ErrorRetry message={detail.error} onRetry={detail.reload} /></div>;
  if (detail.loading && !detail.data) return <div className="person-expand"><SkeletonRows rows={2} /></div>;

  const facts = detail.data?.facts ?? [];
  const applied = facts.filter((fact) => fact.status === "APPLIED").slice(0, 4);
  const proposed = facts.filter((fact) => fact.status === "PROPOSED").slice(0, 3);
  const identifiers = detail.data?.identifiers;

  return (
    <div className="person-expand">
      <div className="cols">
        <div>
          <div className="expand-label">Needs your call</div>
          {proposed.length === 0 ? (
            <p style={{ fontSize: 12.5, color: "var(--gray-500)" }}>Nothing waiting.</p>
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

          <div className="expand-label" style={{ marginTop: "var(--space-4)" }}>
            On file
          </div>
          {applied.length === 0 ? (
            <p style={{ fontSize: 12.5, color: "var(--gray-500)" }}>Nothing settled yet.</p>
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
              </div>
            ))
          )}
        </div>

        <div>
          <div className="expand-label">Recent</div>
          {timeline.data && timeline.data.timeline.length > 0 ? (
            <ul className="timeline">
              {timeline.data.timeline.map((entry) => (
                <li key={`${entry.kind}-${entry.id}`}>
                  <span className="timeline-kind">{entry.kind}</span>
                  <span className="timeline-title">{entry.title}</span>
                  <span className="timeline-time">{relativeDay(entry.at)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p style={{ fontSize: 12.5, color: "var(--gray-500)" }}>Nothing recorded yet.</p>
          )}

          {identifiers ? (
            <div className="chip-row" style={{ marginTop: "var(--space-3)" }}>
              {identifiers.emails.slice(0, 1).map((value) => (
                <span className="chip" key={value}>
                  {value}
                </span>
              ))}
              {identifiers.linkedin.slice(0, 1).map((value) => (
                <span className="chip" key={value}>
                  in/{value.split("/in/")[1]}
                </span>
              ))}
              {identifiers.instagram.slice(0, 1).map((value) => (
                <span className="chip" key={value}>
                  @{value}
                </span>
              ))}
            </div>
          ) : null}

          <div className="expand-actions">
            <button className="button" onClick={onOpen}>
              Open profile
            </button>
            <button className="button secondary" onClick={prep} disabled={briefing}>
              <Sparkles size={12} /> Prep me
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
