import { useState, type ReactNode } from "react";
import { Check, X } from "lucide-react";

/**
 * Evidence display — the trust surface of the whole product.
 * A value the system found is underlined; hovering (or focusing) says what it
 * rests on, in plain language, and where it came from.
 */
export function SourcedValue({
  claim,
  reasons,
  observedAt,
  sourceHost,
  children,
}: {
  claim: string;
  reasons: string[];
  observedAt?: string;
  sourceHost?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const hasDetail = reasons.length > 0 || Boolean(observedAt) || Boolean(sourceHost);

  return (
    <span
      className="sourced"
      tabIndex={0}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      aria-label={`${claim}. ${reasons.join("; ")}`}
    >
      {children}
      {open && hasDetail ? (
        <span className="provenance-pop" role="tooltip">
          <strong>{claim}</strong>
          {reasons.length ? (
            <ul>
              {reasons.map((reason, index) => (
                <li key={index}>{reason}</li>
              ))}
            </ul>
          ) : null}
          {observedAt || sourceHost ? (
            <span className="provenance-meta">
              {observedAt ? `observed ${observedAt}` : ""}
              {observedAt && sourceHost ? " · " : ""}
              {sourceHost ?? ""}
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

export function FactSuggestion({
  value,
  rationale,
  pending = false,
  onAccept,
  onDismiss,
}: {
  value: string;
  rationale: string;
  pending?: boolean;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="suggestion">
      <div className="suggestion-body">
        <div className="suggestion-value">{value}</div>
        <div className="suggestion-why">{rationale}</div>
      </div>
      <div className="row-side">
        <button className="icon-button" onClick={onAccept} disabled={pending} aria-label="Add to record" title="Add to record">
          <Check size={14} />
        </button>
        <button
          className="icon-button"
          onClick={onDismiss}
          disabled={pending}
          aria-label="Dismiss — won't be suggested again"
          title="Dismiss — won't be suggested again"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
