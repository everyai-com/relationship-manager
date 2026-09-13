/**
 * Evidence ledger — code-scored confidence for agent-derived facts.
 *
 * The model never asserts a confidence number. It reports what it *observed* —
 * "their email signature says so", "they replied on that thread" — and this
 * module assigns the worth. Noisy-OR combination, a contradiction caps the
 * score, and VERIFIED additionally requires at least one *primary* observation
 * (something that identifies the person/fact directly, not by association).
 *
 * Downstream law (enforced in the API's record_fact, re-asserted here):
 *   VERIFIED            → may be written to a record.
 *   PROBABLE / POSSIBLE → become a suggestion a human accepts or dismisses.
 *   below POSSIBLE      → not stored at all.
 *
 * Ported faithfully from the AIOS People OS implementation (`evidence.py`);
 * the weights are Phase-0-calibrated defaults, not validated constants.
 */

export type Band = "VERIFIED" | "PROBABLE" | "POSSIBLE";

export interface EvidenceItem {
  kind: string;
  detail?: string;
  sourceUrl?: string;
}

export interface ScoredEvidence {
  score: number;
  band: Band | null;
  hasPrimary: boolean;
  rationale: string;
}

interface Weight {
  weight: number;
  primary: boolean;
  label: string;
}

/**
 * kind -> {weight, primary, plain-language label}. Labels are user-facing — they
 * render in provenance tooltips, so they speak like a person, never like a schema.
 */
export const WEIGHTS: Record<string, Weight> = {
  "invoice.reconciled": { weight: 0.95, primary: true, label: "the payment reconciled against the real invoice" },
  "user.stated": { weight: 0.9, primary: true, label: "you told us this directly" },
  "email.thread-reply": { weight: 0.85, primary: true, label: "they replied on an email thread we have" },
  "email.signature-block": { weight: 0.8, primary: true, label: "their own email signature says so" },
  // Local transcripts carry no speaker identity yet. A transcript can support a
  // suggestion, but it cannot be the primary observation that promotes a fact
  // to VERIFIED until diarization exists.
  "call.transcript-statement": { weight: 0.75, primary: false, label: "it was said on a recorded call" },
  // A WhatsApp exchange is a direct, primary tie to the person: the message is
  // addressed between the user and that counterparty's own number.
  "whatsapp.message-exchanged": { weight: 0.9, primary: true, label: "you've exchanged WhatsApp messages" },
  "calendar.attendance": { weight: 0.7, primary: true, label: "they were on a meeting on the calendar" },
  // A Fathom-identified attendee (matched by email) is meeting attendance from
  // the recording — as strong as, and mirrored on, calendar.attendance.
  "fathom.meeting-attendance": { weight: 0.7, primary: true, label: "they were on a recorded Fathom meeting with you" },
  "web.cited-claim": { weight: 0.4, primary: false, label: "a cited web source states it" },
  "handle.name-form": { weight: 0.35, primary: false, label: "the handle is a form of their name" },
  "employer-only": { weight: 0.2, primary: false, label: "the company matches, the person does not" },
  "agent.inference": { weight: 0.25, primary: false, label: "an agent inferred it, without a direct source" },
  "heuristic.estimate": { weight: 0.3, primary: false, label: "a conservative built-in estimate" },
  contradiction: { weight: 0.0, primary: false, label: "another source disagrees" },
};

export const CEILING = 0.99;
export const CONTRADICTED_CAP = 0.45;
export const BAND_FLOOR: Record<Band, number> = { VERIFIED: 0.85, PROBABLE: 0.55, POSSIBLE: 0.3 };

/** Fields a fact may be written onto directly once VERIFIED. */
export const ROW_FIELDS = new Set(["name", "title", "company", "company_domain", "location"]);

export function bandFor(score: number, hasPrimary: boolean): Band | null {
  if (score >= BAND_FLOOR.VERIFIED && hasPrimary) return "VERIFIED";
  if (score >= BAND_FLOOR.PROBABLE) return "PROBABLE";
  if (score >= BAND_FLOOR.POSSIBLE) return "POSSIBLE";
  return null;
}

export function scoreEvidence(evidence: EvidenceItem[]): ScoredEvidence {
  const known = (evidence ?? []).filter((e) => e && typeof e.kind === "string" && WEIGHTS[e.kind]);
  if (known.length === 0) {
    return { score: 0, band: null, hasPrimary: false, rationale: "No evidence." };
  }

  const contradicted = known.some((e) => e.kind === "contradiction");
  const hasPrimary = known.some((e) => WEIGHTS[e.kind]!.primary);

  let remaining = 1;
  for (const e of known) remaining *= 1 - WEIGHTS[e.kind]!.weight;
  let score = Math.min(CEILING, 1 - remaining);
  if (contradicted) score = Math.min(score, CONTRADICTED_CAP);

  return {
    score,
    band: bandFor(score, hasPrimary),
    hasPrimary,
    rationale: rationale(known, contradicted, hasPrimary),
  };
}

/** Plain-language reasons for the provenance tooltip, detail preferred. */
export function labelsFor(evidence: EvidenceItem[]): string[] {
  const out: string[] = [];
  for (const e of evidence ?? []) {
    const kind = String(e?.kind ?? "");
    if (!WEIGHTS[kind] || kind === "contradiction") continue;
    const detail = String(e?.detail ?? "").trim();
    out.push(detail || WEIGHTS[kind]!.label);
  }
  return out;
}

function rationale(evidence: EvidenceItem[], contradicted: boolean, hasPrimary: boolean): string {
  if (contradicted) {
    const clash = evidence.find((e) => e.kind === "contradiction");
    return `Held: ${String(clash?.detail ?? "").trim() || "sources disagree"}.`;
  }
  const reasons = evidence.filter((e) => e.kind !== "contradiction").map((e) => WEIGHTS[e.kind]!.label);
  if (reasons.length === 0) return "No supporting evidence.";
  const joined = reasons.length === 1 ? reasons[0]! : `${reasons.slice(0, -1).join(", ")} and ${reasons.at(-1)}`;
  const sentence = joined.charAt(0).toUpperCase() + joined.slice(1);
  return hasPrimary ? sentence : `${sentence} — but nothing that identifies this directly.`;
}
