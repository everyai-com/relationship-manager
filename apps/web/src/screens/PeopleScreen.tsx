import { useState } from "react";
import { Search } from "lucide-react";
import { api, type Person } from "../lib/api";
import { useAsync, useDebounced } from "../lib/useAsync";
import { EmptyState, ErrorRetry, LoadingLine, PanelHeader, Surface } from "../components/ui";
import { relativeDay } from "../lib/format";
import { PersonSheet } from "./PersonSheet";

type Notify = (message: string, tone?: "ok" | "error") => void;

export function PeopleScreen({ notify }: { notify: Notify }) {
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query, 200);
  const [openId, setOpenId] = useState<number | null>(null);

  const result = useAsync<{ people: Person[] }>(
    () => api.tool("search_people", { query: debounced, limit: 60 }),
    [debounced],
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
          detail="Everyone you actually talk to, resolved across email, WhatsApp, calendar and calls. Values the system found carry their evidence — hover a dotted one."
        />

        <div className="search" style={{ marginBottom: "var(--space-4)" }}>
          <Search size={14} />
          <input
            type="search"
            value={query}
            placeholder="Search by name, email, company or domain"
            aria-label="Search people"
            onChange={(event) => setQuery(event.target.value)}
          />
          {result.loading ? <span className="spinner" aria-hidden /> : null}
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
            {rows.map((person) => (
              <li key={person.id}>
                <button className="row" onClick={() => setOpenId(person.id)}>
                  <div className="row-main">
                    <div className="row-title">{person.name || person.email}</div>
                    <div className="row-meta">
                      {[person.title, person.company || person.company_domain].filter(Boolean).join(" · ") || person.email}
                    </div>
                  </div>
                  <div className="row-side">
                    {person.proposed_count ? <span className="pill accent">{person.proposed_count} to review</span> : null}
                    <span className="row-time">{relativeDay(person.last_touch)}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Surface>
    </div>
  );
}
