import { useState } from "react";
import { Search } from "lucide-react";
import { api, type Person } from "../lib/api";
import { useAsync, useDebounced } from "../lib/useAsync";
import { EmptyState, ErrorRetry, LoadingLine, PanelHeader, Surface } from "../components/ui";
import { relativeDay } from "../lib/format";
import { PersonSheet } from "./PersonSheet";

type Notify = (message: string, tone?: "ok" | "error") => void;

type SourceFilter = "all" | "email" | "whatsapp" | "linkedin" | "instagram";

const SOURCE_FILTERS: Array<{ id: SourceFilter; label: string }> = [
  { id: "all", label: "Everyone" },
  { id: "email", label: "Email" },
  { id: "whatsapp", label: "WhatsApp" },
  { id: "linkedin", label: "LinkedIn" },
  { id: "instagram", label: "Instagram" },
];

export function PeopleScreen({ notify }: { notify: Notify }) {
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query, 200);
  const [openId, setOpenId] = useState<number | null>(null);
  const [source, setSource] = useState<SourceFilter>("all");

  const result = useAsync<{ people: Person[] }>(
    () => api.tool("search_people", { query: debounced, source: source === "all" ? undefined : source, limit: 60 }),
    [debounced, source],
  );

  if (openId !== null) {
    return <PersonSheet personId={openId} onBack={() => setOpenId(null)} notify={notify} />;
  }

  const rows = result.data?.people ?? [];

  return (
    <div className="screen">
      <Surface>
        <PanelHeader
          eyebrow="Workspace"
          title="People"
          detail="Everyone you actually talk to, resolved across email, WhatsApp, LinkedIn, Instagram, calendar and calls. Values the system found carry their evidence — hover a dotted one."
        />

        <div className="search" style={{ marginBottom: "var(--space-3)" }}>
          <Search size={14} />
          <input
            type="search"
            value={query}
            placeholder="Search by name, email, company, domain or handle"
            aria-label="Search people"
            onChange={(event) => setQuery(event.target.value)}
          />
          {result.loading ? <span className="spinner" aria-hidden /> : null}
        </div>

        <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", marginBottom: "var(--space-4)" }}>
          {SOURCE_FILTERS.map((option) => (
            <button
              key={option.id}
              className={`button tiny ${source === option.id ? "" : "secondary"}`}
              onClick={() => setSource(option.id)}
              aria-pressed={source === option.id}
            >
              {option.label}
            </button>
          ))}
        </div>

        {result.error ? (
          <ErrorRetry message={result.error} onRetry={result.reload} />
        ) : result.loading && !result.data ? (
          <LoadingLine label="Reading your graph…" />
        ) : rows.length === 0 ? (
          <EmptyState
            title={query ? "No one matches that" : "No people yet"}
            body={
              query
                ? "Try a shorter name, or the company's domain."
                : "People appear here as the graph is fed from your mail, calendar and calls."
            }
          />
        ) : (
          <ul className="list">
            {rows.map((person) => {
              const label = person.name || person.email;
              const company = [person.title, person.company || person.company_domain].filter(Boolean).join(" · ");
              // With no name on file the address is the title, so the second line
              // carries what we do know rather than repeating it.
              const meta =
                company || (person.name ? person.email : `${person.message_count} messages · ${person.meeting_count} meetings`);
              return (
                <li key={person.id}>
                  <button className="row" onClick={() => setOpenId(person.id)}>
                    <div className="row-main">
                      <div className="row-title">{label}</div>
                      <div className="row-meta">{meta}</div>
                    </div>
                    <div className="row-side">
                      {person.proposed_count ? <span className="pill accent">{person.proposed_count} to review</span> : null}
                      <span className="row-time">{relativeDay(person.last_touch)}</span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Surface>
    </div>
  );
}
