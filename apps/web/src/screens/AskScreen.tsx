import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Copy, Plus, Send, Sparkles, Square, Trash2, X } from "lucide-react";
import { errorMessage } from "../App";
import { api, type ChatMessage, type ChatThread, type GroundedOn } from "../lib/api";
import { relativeDay } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import { ErrorRetry, LoadingLine, Markdown, Surface } from "../components/ui";

type Notify = (message: string, tone?: "ok" | "error") => void;

interface Turn extends ChatMessage {
  streaming?: boolean;
  failed?: boolean;
  people?: Array<{ id: number; name: string }>;
}

const STARTERS = [
  "Who should I reconnect with this week, and why?",
  "What's waiting on my decision right now?",
  "What's gone quiet that matters?",
  "Summarise the last week in relationships.",
];

/**
 * Ask — a conversation with the graph.
 *
 * Every answer streams, says what it is grounded on, and keeps whatever it wrote
 * even if you stop it. Nothing here writes to the graph: answers are reads, and
 * the ones that touch people link back into their record.
 */
export function AskScreen({
  notify,
  onOpenPerson,
  focusPerson,
  onFocusConsumed,
}: {
  notify: Notify;
  onOpenPerson: (id: number) => void;
  focusPerson: number | null;
  onFocusConsumed: () => void;
}) {
  const threads = useAsync<{ threads: ChatThread[] }>(() => api.chatThreads(), []);
  const [threadId, setThreadId] = useState<number | null>(null);
  const [personId, setPersonId] = useState<number | null>(null);
  const [personName, setPersonName] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<"idle" | "reading" | "thinking" | "writing">("idle");
  const [confirming, setConfirming] = useState<number | null>(null);
  const [autoOpen, setAutoOpen] = useState(true);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const openThread = useCallback(
    async (id: number) => {
      setThreadId(id);
      setLoadingThread(true);
      setPhase("idle");
      try {
        const res = await api.chatThread(id);
        setTurns(res.messages.map((message) => ({ ...message })));
        setPersonId(res.thread.person_id);
        setPersonName(res.thread.person_name ?? null);
      } catch (err) {
        notify(errorMessage(err), "error");
      } finally {
        setLoadingThread(false);
      }
    },
    [notify],
  );

  const startNew = useCallback((person: number | null = null, name: string | null = null) => {
    setThreadId(null);
    setPersonId(person);
    setPersonName(name);
    setTurns([]);
    setPhase("idle");
    composerRef.current?.focus();
  }, []);

  // The most recent conversation opens itself — exactly once, on first load.
  useEffect(() => {
    if (!autoOpen || !threads.data) return;
    setAutoOpen(false);
    const first = threads.data.threads[0];
    if (first) void openThread(first.id);
  }, [autoOpen, threads.data, openThread]);

  // "Ask about them" from a profile: start a thread already pinned to the person.
  useEffect(() => {
    if (!focusPerson) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.createChatThread(focusPerson);
        if (cancelled) return;
        setThreadId(res.thread.id);
        setPersonId(res.thread.person_id);
        setPersonName(res.thread.person_name ?? null);
        setTurns([]);
        threads.reload();
        composerRef.current?.focus();
      } catch (err) {
        notify(errorMessage(err), "error");
      } finally {
        if (!cancelled) onFocusConsumed();
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusPerson]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [question]);

  const stop = () => {
    abortRef.current?.abort();
  };

  const send = async (text: string) => {
    const content = text.trim();
    if (!content || busy) return;

    setQuestion("");
    setBusy(true);
    setPhase("reading");

    const stamp = new Date().toISOString();
    const localUser: Turn = {
      id: -Date.now(),
      thread_id: threadId ?? 0,
      role: "user",
      content,
      grounded_on: {},
      model: null,
      created_at: stamp,
    };
    const localAnswer: Turn = {
      ...localUser,
      id: localUser.id - 1,
      role: "assistant",
      content: "",
      streaming: true,
    };
    setTurns((prev) => [...prev, localUser, localAnswer]);

    const controller = new AbortController();
    abortRef.current = controller;
    let activeThread = threadId;

    try {
      await api.chatStream(
        { thread_id: activeThread ?? undefined, person_id: personId ?? undefined, question: content },
        {
          signal: controller.signal,
          onContext: (event) => {
            setPhase("thinking");
            if (!activeThread) {
              activeThread = event.thread_id;
              setThreadId(event.thread_id);
            }
            setTurns((prev) =>
              prev.map((turn) =>
                turn.id === localAnswer.id
                  ? { ...turn, model: event.model, grounded_on: event.grounded, people: event.people }
                  : turn,
              ),
            );
          },
          onDelta: (delta) => {
            setPhase("writing");
            setTurns((prev) =>
              prev.map((turn) => (turn.id === localAnswer.id ? { ...turn, content: turn.content + delta } : turn)),
            );
          },
          onDone: (event) => {
            if (!activeThread) {
              activeThread = event.thread_id;
              setThreadId(event.thread_id);
            }
            setTurns((prev) =>
              prev.map((turn) =>
                turn.id === localAnswer.id
                  ? {
                      ...turn,
                      streaming: false,
                      id: event.message_id ?? turn.id,
                      grounded_on: event.grounded_on,
                      people: event.people,
                      model: event.model,
                    }
                  : turn,
              ),
            );
            threads.reload();
          },
          onError: (message) => {
            setTurns((prev) =>
              prev.map((turn) =>
                turn.id === localAnswer.id
                  ? { ...turn, streaming: false, failed: true, content: turn.content || message }
                  : turn,
              ),
            );
            notify(message, "error");
          },
        },
      );
    } catch (err) {
      const aborted = err instanceof DOMException && err.name === "AbortError";
      setTurns((prev) =>
        prev.map((turn) =>
          turn.id === localAnswer.id
            ? { ...turn, streaming: false, failed: !aborted && turn.content.length === 0, content: turn.content || errorMessage(err) }
            : turn,
        ),
      );
      if (aborted) {
        notify("Stopped — what was written is kept.");
        threads.reload();
      } else {
        notify(errorMessage(err), "error");
      }
    } finally {
      setBusy(false);
      setPhase("idle");
      abortRef.current = null;
    }
  };

  const remove = async (id: number) => {
    if (confirming !== id) {
      setConfirming(id);
      window.setTimeout(() => setConfirming((current) => (current === id ? null : current)), 4000);
      return;
    }
    setConfirming(null);
    try {
      await api.deleteChatThread(id);
      notify("Conversation deleted");
      if (threadId === id) startNew();
      threads.reload();
    } catch (err) {
      notify(errorMessage(err), "error");
    }
  };

  const copy = (content: string) => {
    void navigator.clipboard?.writeText(content).then(
      () => notify("Copied"),
      () => notify("Could not copy", "error"),
    );
  };

  const onComposerKey = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send(question);
    }
  };

  const phaseLabel =
    phase === "reading"
      ? "Reading your graph…"
      : phase === "thinking"
        ? "Thinking…"
        : phase === "writing"
          ? ""
          : "";

  const threadList = threads.data?.threads ?? [];
  const activeTitle = threadList.find((thread) => thread.id === threadId)?.title ?? (turns.length ? "Conversation" : "New conversation");

  return (
    <div className="screen chat-screen">
      <div className="chat-shell">
        <aside className="chat-rail">
          <button className="button secondary chat-new" onClick={() => startNew()}>
            <Plus size={14} /> New conversation
          </button>

          {threads.loading && !threads.data ? (
            <LoadingLine label="Loading conversations…" />
          ) : threads.error ? (
            <ErrorRetry message={threads.error ?? undefined} onRetry={threads.reload} />
          ) : threadList.length === 0 ? (
            <p className="chat-rail-empty">Nothing asked yet. Your conversations will collect here.</p>
          ) : (
            <div className="chat-threads">
              {threadList.map((thread) => (
                <div
                  key={thread.id}
                  className={`chat-thread${thread.id === threadId ? " active" : ""}`}
                  onClick={() => void openThread(thread.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void openThread(thread.id);
                  }}
                >
                  <div className="chat-thread-main">
                    <span className="chat-thread-title">{thread.title || "Conversation"}</span>
                    <span className="chat-thread-meta">
                      {thread.person_name ? `${thread.person_name} · ` : ""}
                      {relativeDay(thread.updated_at)}
                      {thread.message_count ? ` · ${thread.message_count} turns` : ""}
                    </span>
                  </div>
                  <button
                    className={`icon-button compact chat-thread-delete${confirming === thread.id ? " confirming" : ""}`}
                    title={confirming === thread.id ? "Click again to delete" : "Delete conversation"}
                    onClick={(event) => {
                      event.stopPropagation();
                      void remove(thread.id);
                    }}
                  >
                    {confirming === thread.id ? <span className="chat-confirm">sure?</span> : <Trash2 size={13} />}
                  </button>
                </div>
              ))}
            </div>
          )}
        </aside>

        <section className="chat-main">
          <header className="chat-head">
            <div>
              <div className="chat-title">{activeTitle}</div>
              <div className="chat-sub">
                {personName ? `Pinned to ${personName}` : "Grounded on your graph — never the internet"}
              </div>
            </div>
            {personName ? (
              <button
                className="chip"
                title="Stop pinning this person — the next question starts fresh"
                onClick={() => startNew()}
              >
                {personName} <X size={11} />
              </button>
            ) : null}
          </header>

          <div className="chat-scroll" ref={scrollRef}>
            {loadingThread ? (
              <LoadingLine label="Opening the conversation…" />
            ) : turns.length === 0 ? (
              <div className="chat-empty">
                <Surface quiet className="chat-empty-card">
                  <div className="chat-empty-mark">
                    <Sparkles size={15} />
                  </div>
                  <h3>Ask your graph</h3>
                  <p>
                    Every answer is assembled from your record — people, facts, messages, calls, and what is stale — and
                    says what it drew on. If the record is silent, it says so.
                  </p>
                </Surface>
                <div className="chat-starters">
                  {STARTERS.map((starter) => (
                    <button key={starter} className="starter" onClick={() => void send(starter)}>
                      {starter}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              turns.map((turn) =>
                turn.role === "user" ? (
                  <div className="msg msg-user" key={turn.id}>
                    <div className="msg-user-body">{turn.content}</div>
                  </div>
                ) : (
                  <div className={`msg msg-ai${turn.failed ? " failed" : ""}`} key={turn.id}>
                    <div className="msg-ai-head">
                      <Sparkles size={13} />
                      <span>{turn.model ?? "Workers AI"}</span>
                      {turn.failed ? <span className="pill danger">failed</span> : null}
                    </div>

                    {turn.content ? (
                      <div className="msg-body">
                        <Markdown content={turn.content} />
                        {turn.streaming ? <span className="caret" /> : null}
                      </div>
                    ) : (
                      <div className="msg-body thinking">
                        <span className="think-line">{phaseLabel || "Reading your graph…"}</span>
                      </div>
                    )}

                    {turn.content ? (
                      <div className="msg-meta">
                        {turnGrounded(turn).map((chip) => (
                          <span className="pill" key={chip}>
                            {chip}
                          </span>
                        ))}
                        {mentionedPeople(turn).map((person) => (
                          <button className="chip" key={person.id} onClick={() => onOpenPerson(person.id)}>
                            {person.name}
                          </button>
                        ))}
                        <span className="msg-spacer" />
                        <button className="button ghost tiny" onClick={() => copy(turn.content)}>
                          <Copy size={12} /> Copy
                        </button>
                      </div>
                    ) : null}
                  </div>
                ),
              )
            )}
          </div>

          <div className="composer">
            {personName ? <span className="composer-pin">Pinned: {personName}</span> : null}
            <textarea
              ref={composerRef}
              className="composer-input"
              rows={1}
              value={question}
              placeholder="Ask anything your graph would know…"
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={onComposerKey}
            />
            <div className="composer-actions">
              <span className="composer-hint">{phaseLabel || (busy ? "Working…" : "Enter to ask · Shift+Enter for a new line")}</span>
              {busy ? (
                <button className="button secondary" onClick={stop}>
                  <Square size={12} /> Stop
                </button>
              ) : (
                <button className="button" disabled={!question.trim()} onClick={() => void send(question)}>
                  <Send size={13} /> Ask
                </button>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function turnGrounded(turn: Turn): string[] {
  const grounded = turn.grounded_on as GroundedOn;
  if (!grounded || typeof grounded !== "object") return [];
  const chips: string[] = [];
  if (grounded.people) chips.push(`${grounded.people} ${grounded.people === 1 ? "person" : "people"}`);
  if (grounded.facts) chips.push(`${grounded.facts} facts`);
  if (grounded.messages) chips.push(`${grounded.messages} messages`);
  if (grounded.sources) chips.push(`${grounded.sources} sources`);
  return chips;
}

/** People the answer actually names — a way straight back into the record. */
function mentionedPeople(turn: Turn): Array<{ id: number; name: string }> {
  const content = turn.content.toLowerCase();
  const seen = new Set<string>();
  const chips: Array<{ id: number; name: string }> = [];
  for (const person of turn.people ?? []) {
    const name = String(person.name ?? "").trim();
    const key = name.toLowerCase();
    // The graph holds duplicate names on purpose; three identical chips is a
    // mis-click trap, so the first (best-ranked) record stands for the name.
    if (name.length <= 3 || seen.has(key) || !content.includes(key)) continue;
    seen.add(key);
    chips.push({ id: person.id, name });
    if (chips.length === 5) break;
  }
  return chips;
}
