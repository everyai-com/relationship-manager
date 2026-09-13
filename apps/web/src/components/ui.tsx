import { useState, type ReactNode } from "react";

export function Surface({
  children,
  className = "",
  flush = false,
  quiet = false,
}: {
  children: ReactNode;
  className?: string;
  flush?: boolean;
  quiet?: boolean;
}) {
  return (
    <section className={`surface${flush ? " flush" : ""}${quiet ? " quiet" : ""} ${className}`.trim()}>{children}</section>
  );
}

export function PanelHeader({
  eyebrow,
  title,
  detail,
  action,
}: {
  eyebrow?: string;
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <header className="panel-header">
      <div>
        {eyebrow ? <div className="panel-eyebrow">{eyebrow}</div> : null}
        <h2>{title}</h2>
        {detail ? <p className="panel-detail">{detail}</p> : null}
      </div>
      {action ? <div className="panel-action">{action}</div> : null}
    </header>
  );
}

export function EmptyState({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {body ? <p className="empty-body">{body}</p> : null}
      {action}
    </div>
  );
}

export function ErrorRetry({
  message,
  onRetry,
  retrying = false,
}: {
  message?: string;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  return (
    <div className="error-card">
      <h4>Something went wrong</h4>
      <p>{message ?? "The last request did not come back. Nothing was lost — try again."}</p>
      {onRetry ? (
        <button className="button secondary" onClick={onRetry} disabled={retrying}>
          {retrying ? <Spinner /> : null}
          Try again
        </button>
      ) : null}
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" aria-hidden />;
}

export function LoadingLine({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="loading-line" role="status" aria-live="polite">
      <Spinner /> {label}
    </div>
  );
}

export function Metric({ label, value, tone }: { label: string; value: number | string; tone?: "warning" | "positive" }) {
  return (
    <div className="metric">
      <div className="metric-label">{label}</div>
      <div className={`metric-value${tone ? ` ${tone}` : ""}`}>{value}</div>
    </div>
  );
}

export function StatusPill({ status }: { status: string }) {
  const tone = status === "connected" ? "positive" : status === "error" ? "danger" : status === "stale" ? "warning" : "";
  const label = status.replace(/_/g, " ");
  return (
    <span className={`pill ${tone}`}>
      <span className="dot" /> {label}
    </span>
  );
}

export function CopyField({ title, value }: { title: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="code">
      <div className="code-head">
        <span className="code-title">{title}</span>
        <button
          className="button ghost tiny"
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1600);
            });
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {value}
    </div>
  );
}

export function Toast({ message, tone, onDismiss }: { message: string; tone: "ok" | "error"; onDismiss: () => void }) {
  return (
    <div className={`toast ${tone}`} role="status" aria-live="polite">
      {message}
      <button className="icon-button compact" style={{ marginLeft: 12 }} onClick={onDismiss} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}

/** Inline markdown: **bold** and `code`. */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  parts.forEach((part, index) => {
    if (!part) return;
    if (part.startsWith("**") && part.endsWith("**")) {
      out.push(<strong key={`${keyPrefix}-b${index}`}>{part.slice(2, -2)}</strong>);
    } else if (part.startsWith("`") && part.endsWith("`")) {
      out.push(<code key={`${keyPrefix}-c${index}`}>{part.slice(1, -1)}</code>);
    } else {
      out.push(part);
    }
  });
  return out;
}

/** The prep brief and other server-produced markdown, rendered small and calm. */
export function Markdown({ content }: { content: string }) {
  const lines = (content ?? "").split("\n");
  const blocks: ReactNode[] = [];
  let list: string[] = [];

  const flushList = (key: string) => {
    if (list.length === 0) return;
    blocks.push(
      <ul key={`ul-${key}`}>
        {list.map((item, i) => (
          <li key={`li-${key}-${i}`}>{inline(item, `li-${key}-${i}`)}</li>
        ))}
      </ul>,
    );
    list = [];
  };

  lines.forEach((raw, index) => {
    const line = raw.replace(/\s+$/, "");
    const key = String(index);
    if (line.startsWith("  ") && list.length > 0) {
      list[list.length - 1] += ` — ${line.trim()}`;
      return;
    }
    if (line.startsWith("# ")) {
      flushList(key);
      blocks.push(<h1 key={`h1-${key}`}>{inline(line.slice(2), `h1-${key}`)}</h1>);
    } else if (line.startsWith("## ")) {
      flushList(key);
      blocks.push(<h2 key={`h2-${key}`}>{inline(line.slice(3), `h2-${key}`)}</h2>);
    } else if (line.startsWith("- ")) {
      list.push(line.slice(2));
    } else if (line.trim() === "") {
      flushList(key);
    } else {
      flushList(key);
      blocks.push(<p key={`p-${key}`}>{inline(line, `p-${key}`)}</p>);
    }
  });
  flushList("end");

  return <div className="md">{blocks}</div>;
}
