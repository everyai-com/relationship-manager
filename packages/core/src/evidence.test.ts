import { describe, expect, it } from "vitest";
import { bandFor, labelsFor, scoreEvidence } from "./evidence";

const round = (n: number) => Math.round(n * 1000) / 1000;

describe("scoreEvidence", () => {
  it("stores nothing when there is no evidence at all", () => {
    const r = scoreEvidence([]);
    expect(r.score).toBe(0);
    expect(r.band).toBeNull();
    expect(r.rationale).toBe("No evidence.");
  });

  it("ignores unknown kinds entirely", () => {
    const r = scoreEvidence([{ kind: "made.up.kind" }, { kind: "also.fake" }]);
    expect(r.band).toBeNull();
    expect(r.score).toBe(0);
  });

  it("promotes a primary observation at/above the VERIFIED floor", () => {
    const r = scoreEvidence([{ kind: "email.thread-reply" }]);
    expect(r.band).toBe("VERIFIED");
    expect(r.hasPrimary).toBe(true);
    expect(round(r.score)).toBe(0.85);
  });

  it("never reaches VERIFIED without a primary observation", () => {
    // 0.4 + 0.35 + 0.3 noisy-OR ≈ 0.727, but nothing identifies the person.
    const r = scoreEvidence([
      { kind: "web.cited-claim" },
      { kind: "handle.name-form" },
      { kind: "heuristic.estimate" },
    ]);
    expect(r.score).toBeGreaterThan(0.55);
    expect(r.hasPrimary).toBe(false);
    expect(r.band).toBe("PROBABLE");
    expect(r.rationale).toContain("nothing that identifies this directly");
  });

  it("caps a contradicted claim at 0.45 and explains why", () => {
    const r = scoreEvidence([{ kind: "user.stated" }, { kind: "contradiction", detail: "the two invoices disagree" }]);
    expect(round(r.score)).toBe(0.45);
    expect(r.band).toBe("POSSIBLE");
    expect(r.rationale).toBe("Held: the two invoices disagree.");
  });

  it("combines independent observations with noisy-OR, capped at the ceiling", () => {
    const r = scoreEvidence([
      { kind: "whatsapp.message-exchanged" },
      { kind: "calendar.attendance" },
      { kind: "email.signature-block" },
    ]);
    // 1 - 0.1 * 0.3 * 0.2 = 0.994, capped at CEILING (0.99).
    expect(round(r.score)).toBe(0.99);
    expect(r.band).toBe("VERIFIED");
  });

  it("drops below POSSIBLE when only a weak guess is offered", () => {
    const r = scoreEvidence([{ kind: "agent.inference" }]);
    expect(r.band).toBeNull();
    expect(r.score).toBeLessThan(0.3);
  });

  it("treats a transcript alone as a suggestion, never a verified claim", () => {
    const r = scoreEvidence([{ kind: "call.transcript-statement" }]);
    expect(r.hasPrimary).toBe(false);
    expect(r.band).toBe("PROBABLE");
  });
});

describe("bandFor", () => {
  it("walks the floors in order", () => {
    expect(bandFor(0.29, true)).toBeNull();
    expect(bandFor(0.3, true)).toBe("POSSIBLE");
    expect(bandFor(0.55, true)).toBe("PROBABLE");
    expect(bandFor(0.85, false)).toBe("PROBABLE");
    expect(bandFor(0.85, true)).toBe("VERIFIED");
    expect(bandFor(0.99, true)).toBe("VERIFIED");
  });
});

describe("labelsFor", () => {
  it("prefers the detail and skips contradictions", () => {
    expect(
      labelsFor([
        { kind: "email.signature-block", detail: "signature says VP Engineering" },
        { kind: "contradiction", detail: "LinkedIn says otherwise" },
        { kind: "calendar.attendance" },
      ]),
    ).toEqual(["signature says VP Engineering", "they were on a meeting on the calendar"]);
  });
});
