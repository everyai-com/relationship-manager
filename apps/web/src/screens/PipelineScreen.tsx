import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import { api, type Board, type BoardCard } from "../lib/api";
import { useAsync, useDebounced } from "../lib/useAsync";
import { errorMessage } from "../App";
import { EmptyState, ErrorRetry, PanelHeader, Surface } from "../components/ui";
import { Avatar, SkeletonCards } from "../components/Avatar";
import { relativeDay } from "../lib/format";

type Notify = (message: string, tone?: "ok" | "error") => void;

/**
 * The pipeline. Columns are stages; cards are people; dragging a card is the
 * only way to move someone. Optimistic, but it rolls back and says so if the
 * write fails — a board that lies about where someone is would be worse than
 * no board.
 */
export function PipelineScreen({ notify, onOpenPerson }: { notify: Notify; onOpenPerson: (id: number) => void }) {
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query, 220);
  const [board, setBoard] = useState<Board | null>(null);
  const [dragging, setDragging] = useState<BoardCard | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [saving, setSaving] = useState<number | null>(null);

  const state = useAsync<Board>(() => api.board(40, debounced), [debounced]);

  useEffect(() => {
    if (state.data) setBoard(state.data);
  }, [state.data]);

  const move = useCallback(
    async (card: BoardCard, stage: string) => {
      if (!board || card.stage === stage) return;
      const snapshot = board;
      setSaving(card.id);
      // Optimistic: move the card now, put it back if the write is refused.
      setBoard({
        unstaged: board.unstaged,
        stages: board.stages.map((column) => {
          const people = column.people.filter((person) => person.id !== card.id);
          const total = column.stage === card.stage ? Math.max(0, column.total - 1) : column.total;
          if (column.stage !== stage) return { ...column, people, total };
          const moved = [{ ...card, stage }];
          return { ...column, people: [...moved, ...people], total: column.total + 1 };
        }),
      });

      try {
        const result = await api.setStage(card.id, stage);
        notify(`${result.name} → ${stage}`, "ok");
      } catch (error) {
        setBoard(snapshot);
        notify(`Could not move them: ${errorMessage(error)}`, "error");
      } finally {
        setSaving(null);
        setDragging(null);
        setOver(null);
      }
    },
    [board, notify],
  );

  const total = board?.stages.reduce((sum, column) => sum + column.total, 0) ?? 0;

  return (
    <div className="screen" style={{ maxWidth: "none" }}>
      <Surface flush>
        <div style={{ padding: "var(--space-5) var(--space-5) 0" }}>
          <PanelHeader
            eyebrow="Workspace"
            title="Pipeline"
            detail={`Where each relationship stands. ${total.toLocaleString()} people placed, ${(board?.unstaged ?? 0).toLocaleString()} not in the pipeline yet. Drag a card to move someone.`}
            action={
              <button className="button secondary" onClick={state.reload} disabled={state.loading}>
                <RefreshCw size={13} /> Refresh
              </button>
            }
          />
          <div className="toolbar">
            <div className="search">
              <Search size={14} />
              <input
                type="search"
                value={query}
                placeholder="Filter the board by name, company or domain"
                aria-label="Filter the board"
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          </div>
        </div>

        {state.error ? (
          <div style={{ padding: "var(--space-5)" }}>
            <ErrorRetry message={state.error} onRetry={state.reload} />
          </div>
        ) : !board ? (
          <div style={{ padding: "var(--space-5)" }}>
            <SkeletonCards count={5} />
          </div>
        ) : total === 0 && debounced ? (
          <div style={{ padding: "var(--space-5)" }}>
            <EmptyState
              title="Nobody matches"
              body="No one in the pipeline matches that filter. Clear it, or search People and add someone to a stage."
            />
          </div>
        ) : total === 0 ? (
          <div style={{ padding: "var(--space-5)" }}>
            <EmptyState
              title="The pipeline is empty"
              body="Open someone in People and choose a stage — they will appear here, and you can drag them along as things move."
              action={
                <button className="button" onClick={() => onOpenPerson(0)}>
                  Go to People
                </button>
              }
            />
          </div>
        ) : (
          <div className="board-wrap" style={{ padding: "0 var(--space-5) var(--space-5)" }}>
            <div className="board">
              {board.stages.map((column) => (
                <section
                  key={column.stage}
                  className={`column${over === column.stage ? " dropping" : ""}`}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    setOver(column.stage);
                  }}
                  onDragLeave={() => setOver((value) => (value === column.stage ? null : value))}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (dragging) void move(dragging, column.stage);
                  }}
                  aria-label={`${column.stage}, ${column.total} people`}
                >
                  <header className="column-head">
                    <span className="column-name">{column.stage}</span>
                    <span className="column-count">{column.total}</span>
                  </header>
                  <div className="column-body">
                    {column.people.length === 0 ? (
                      <div className="column-empty">{column.total === 0 ? "Nobody here" : "Drag a card in"}</div>
                    ) : (
                      column.people.map((card) => (
                        <article
                          key={card.id}
                          className={`card${dragging?.id === card.id ? " dragging" : ""}`}
                          draggable
                          onDragStart={(event) => {
                            setDragging(card);
                            event.dataTransfer.effectAllowed = "move";
                            event.dataTransfer.setData("text/plain", String(card.id));
                          }}
                          onDragEnd={() => {
                            setDragging(null);
                            setOver(null);
                          }}
                          onClick={() => onOpenPerson(card.id)}
                          style={saving === card.id ? { opacity: 0.6 } : undefined}
                        >
                          <div className="card-top">
                            <Avatar name={card.name || card.email} size="sm" />
                            <span className="card-name">{card.name || card.email}</span>
                          </div>
                          <div className="card-meta">
                            {[card.title, card.company || card.company_domain].filter(Boolean).join(" · ") ||
                              card.email ||
                              "no company on file"}
                          </div>
                          <div className="card-foot">
                            {card.last_touch ? <span>last {relativeDay(card.last_touch)}</span> : <span>never in touch</span>}
                            {card.message_count ? <span>· {card.message_count} msg</span> : null}
                            {card.meeting_count ? <span>· {card.meeting_count} mtg</span> : null}
                          </div>
                        </article>
                      ))
                    )}
                    {column.total > column.people.length ? (
                      <div className="column-more">
                        +{column.total - column.people.length} more not shown
                      </div>
                    ) : null}
                  </div>
                </section>
              ))}
            </div>
          </div>
        )}
      </Surface>
    </div>
  );
}
