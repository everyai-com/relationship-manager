import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, Columns3, Home, Plug, Repeat, Search, Sparkles, Users } from "lucide-react";
import { api, type Person } from "../lib/api";
import { useDebounced } from "../lib/useAsync";
import { Avatar } from "./Avatar";
import { relativeDay } from "../lib/format";

export type ScreenId = "today" | "ask" | "people" | "pipeline" | "reconnect" | "connections" | "agents";

interface Item {
  id: string;
  label: string;
  hint?: string;
  group: string;
  icon: React.ReactNode;
  run: () => void;
}

const NAV: Array<{ id: ScreenId; label: string; icon: React.ReactNode }> = [
  { id: "today", label: "Today", icon: <Home size={14} /> },
  { id: "ask", label: "Ask your graph", icon: <Sparkles size={14} /> },
  { id: "people", label: "People", icon: <Users size={14} /> },
  { id: "pipeline", label: "Pipeline", icon: <Columns3 size={14} /> },
  { id: "reconnect", label: "Reconnect", icon: <Repeat size={14} /> },
  { id: "connections", label: "Connections", icon: <Plug size={14} /> },
  { id: "agents", label: "Agents", icon: <Bot size={14} /> },
];

/** ⌘K — go anywhere, or find anyone, without leaving the keyboard. */
export function CommandPalette({
  open,
  onClose,
  onNavigate,
  onOpenPerson,
}: {
  open: boolean;
  onClose: () => void;
  onNavigate: (screen: ScreenId) => void;
  onOpenPerson: (personId: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState<Person[]>([]);
  const [index, setIndex] = useState(0);
  const debounced = useDebounced(query, 160);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setPeople([]);
      setIndex(0);
    }
  }, [open]);

  useEffect(() => {
    if (!open || debounced.trim().length < 2) {
      setPeople([]);
      return;
    }
    let cancelled = false;
    api
      .tool<{ people: Person[] }>("search_people", { query: debounced.trim(), limit: 8 })
      .then((result) => {
        if (!cancelled) setPeople(result.people);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [debounced, open]);

  const items = useMemo<Item[]>(() => {
    const navItems: Item[] = NAV.filter((entry) => entry.label.toLowerCase().includes(query.trim().toLowerCase())).map(
      (entry) => ({
        id: `nav-${entry.id}`,
        label: entry.label,
        group: "Go to",
        icon: entry.icon,
        run: () => onNavigate(entry.id),
      }),
    );
    const peopleItems: Item[] = people.map((person) => ({
      id: `person-${person.id}`,
      label: person.name || person.email,
      hint: [person.company || person.company_domain, relativeDay(person.last_touch)].filter(Boolean).join(" · "),
      group: "People",
      icon: <Avatar name={person.name || person.email} size="sm" />,
      run: () => onOpenPerson(person.id),
    }));
    return query.trim() ? [...peopleItems, ...navItems] : navItems;
  }, [people, query, onNavigate, onOpenPerson]);

  useEffect(() => {
    setIndex(0);
  }, [items.length]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        setIndex((value) => Math.min(value + 1, items.length - 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setIndex((value) => Math.max(value - 1, 0));
      } else if (event.key === "Enter" && items[index]) {
        event.preventDefault();
        items[index]!.run();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, items, index, onClose]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  if (!open) return null;

  let group = "";

  return (
    <div className="palette-backdrop" onClick={onClose}>
      <div className="palette" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search people, or jump to a screen…"
          aria-label="Search"
        />
        <div className="palette-list" ref={listRef}>
          {items.length === 0 ? (
            <div style={{ padding: "var(--space-4)", fontSize: 13, color: "var(--gray-500)" }}>
              <Search size={13} style={{ verticalAlign: -2, marginRight: 6 }} />
              Type at least two characters to search the graph.
            </div>
          ) : (
            items.map((item, position) => {
              const header = item.group !== group ? item.group : null;
              group = item.group;
              return (
                <div key={item.id}>
                  {header ? <div className="palette-group">{header}</div> : null}
                  <button
                    className="palette-item"
                    data-index={position}
                    aria-selected={position === index}
                    onMouseEnter={() => setIndex(position)}
                    onClick={() => {
                      item.run();
                      onClose();
                    }}
                  >
                    {item.icon}
                    <span className="label">{item.label}</span>
                    {item.hint ? <span className="hint">{item.hint}</span> : null}
                  </button>
                </div>
              );
            })
          )}
        </div>
        <div className="palette-foot">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
