import type { ReactNode } from "react";

/** Monochrome, deterministic: same person, same tone, no decorative palette. */
function toneFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) % 997;
  const steps = [6, 10, 14, 18, 22, 26];
  return `color-mix(in srgb, var(--ink) ${steps[hash % steps.length]}%, var(--surface-soft))`;
}

export function initialsOf(value: string): string {
  const clean = (value || "?").replace(/<[^>]*>/g, " ").trim();
  const parts = clean.split(/[\s@._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

export function Avatar({
  name,
  size = "md",
  title,
}: {
  name: string;
  size?: "sm" | "md" | "lg";
  title?: string;
}) {
  return (
    <span className={`avatar ${size}`} style={{ background: toneFor(name) }} title={title ?? name} aria-hidden>
      {initialsOf(name)}
    </span>
  );
}

export function SkeletonRows({ rows = 6 }: { rows?: number }) {
  return (
    <div aria-hidden>
      {Array.from({ length: rows }).map((_, index) => (
        <div className="skeleton-row" key={index}>
          <span className="skeleton skeleton-circle" />
          <span style={{ flex: 1 }}>
            <span className="skeleton" style={{ display: "block", height: 11, width: `${38 + ((index * 7) % 26)}%` }} />
            <span
              className="skeleton"
              style={{ display: "block", height: 9, width: `${22 + ((index * 5) % 20)}%`, marginTop: 6 }}
            />
          </span>
          <span className="skeleton" style={{ display: "block", height: 10, width: 44 }} />
        </div>
      ))}
    </div>
  );
}

export function SkeletonCards({ count = 4 }: { count?: number }) {
  return (
    <div style={{ display: "grid", gap: "var(--space-2)" }} aria-hidden>
      {Array.from({ length: count }).map((_, index) => (
        <span className="skeleton" key={index} style={{ display: "block", height: 62 }} />
      ))}
    </div>
  );
}

/** A stage pill: a dot that carries the meaning, and the name. */
export function StageChip({ stage }: { stage: string }) {
  if (!stage) return null;
  return (
    <span className="stage" data-stage={stage}>
      <span className="dot" /> {stage}
    </span>
  );
}

export function IconLink({
  href,
  children,
  title,
}: {
  href: string;
  children: ReactNode;
  title: string;
}) {
  return (
    <a className="quick-link" href={href} target="_blank" rel="noreferrer" title={title}>
      {children}
    </a>
  );
}
