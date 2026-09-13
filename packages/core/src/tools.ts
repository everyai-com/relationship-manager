import { z } from "zod";
import type { Band } from "./evidence";

/** The tool contract. MCP, REST and the CLI all register from this list. */

export type ToolScope = "read" | "write";

export interface ToolDef {
  name: string;
  scope: ToolScope;
  /** Written for an agent deciding whether to call it. Keep it literal. */
  description: string;
  input: z.ZodRawShape;
}

const PERSON_ID = z.number().int().positive().describe("Person id from search_people.");

export const TOOLS: ToolDef[] = [
  {
    name: "search_people",
    scope: "read",
    description:
      "Find people by name, email, company or domain. Returns id, display name, company, and how " +
      "recently you were in touch. Use this first when you do not already know a person id.",
    input: {
      query: z
        .string()
        .optional()
        .describe("Name, email, company or domain fragment. Omit to list the people you were most recently in touch with."),
      limit: z.number().int().min(1).max(200).optional().describe("Max results, default 25."),
    },
  },
  {
    name: "get_person",
    scope: "read",
    description:
      "The full record for one person: identity, every settled fact with its evidence and reasons, " +
      "all known handles, and message/meeting counts. Facts carry a band — VERIFIED was written by " +
      "the evidence ledger, PROPOSED is a suggestion nobody has decided yet.",
    input: { person_id: PERSON_ID },
  },
  {
    name: "prep_brief",
    scope: "read",
    description:
      "A deterministic markdown brief to read before you talk to someone: who they are, how you are " +
      "reachable, what is on file, recent email, meetings, WhatsApp and recorded calls. No model is " +
      "spent producing it, and it never invents anything that is not in the graph.",
    input: { person_id: PERSON_ID },
  },
  {
    name: "person_timeline",
    scope: "read",
    description:
      "Merged chronology for one person — email, calendar meetings, recorded calls and WhatsApp in " +
      "time order. This is ground truth for 'when did we last talk'; prefer it over any summary.",
    input: {
      person_id: PERSON_ID,
      limit: z.number().int().min(1).max(200).optional().describe("Max entries, default 40, newest first."),
    },
  },
  {
    name: "list_facts",
    scope: "read",
    description:
      "Facts across the graph, filtered by status. PROPOSED is what is waiting on a human decision; " +
      "APPLIED is settled. Use person_id to scope to one person.",
    input: {
      status: z.enum(["PROPOSED", "APPLIED"]).optional().describe("Defaults to both when omitted."),
      person_id: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(200).optional().describe("Max rows, default 50."),
    },
  },
  {
    name: "reconnect_queue",
    scope: "read",
    description:
      "Ranked list of people worth reconnecting with, each with the cohort it belongs to, the signal " +
      "that put it there, when you last spoke and a starter draft where one exists. Suppressed people " +
      "are excluded unless you explicitly ask for them.",
    input: {
      cohort: z.string().optional().describe("Filter to one cohort label."),
      limit: z.number().int().min(1).max(200).optional().describe("Max rows, default 25."),
      include_suppressed: z.boolean().optional().describe("Default false. Suppressed people are deliberate holds."),
    },
  },
  {
    name: "connection_status",
    scope: "read",
    description:
      "Per-source freshness: which sources fed this graph, when each last synced and how much it " +
      "carried. Call this before implying that anything is current — stale is a real answer.",
    input: {},
  },
  {
    name: "record_fact",
    scope: "write",
    description:
      "The only way to write something you learned about a person. Supply evidence observations, " +
      "never a confidence number: the ledger scores them. VERIFIED observations are written to the " +
      "record; PROBABLE/POSSIBLE become suggestions; below POSSIBLE nothing is stored. Recognised " +
      "kinds include email.thread-reply, email.signature-block, whatsapp.message-exchanged, " +
      "calendar.attendance, fathom.meeting-attendance, call.transcript-statement, web.cited-claim, " +
      "user.stated, agent.inference, heuristic.estimate and contradiction.",
    input: {
      person_id: PERSON_ID,
      field: z.string().min(1).describe("Field name, e.g. title, company, location, or a custom key."),
      value: z.string().min(1),
      evidence: z
        .array(
          z.object({
            kind: z.string().min(1),
            detail: z.string().optional().describe("Plain-language note shown to the human."),
          }),
        )
        .min(1)
        .describe("What you observed. The ledger, not you, decides what it is worth."),
      source_url: z.string().optional().describe("Where this came from, if it has a URL."),
    },
  },
  {
    name: "decide_fact",
    scope: "write",
    description:
      "Accept or dismiss a suggested fact. Call this only on the human's instruction — accepting " +
      "writes the value to the record and freezes the field as human-held; dismissing means it is " +
      "never suggested again.",
    input: {
      fact_id: z.number().int().positive(),
      decision: z.enum(["accept", "dismiss"]),
    },
  },
  {
    name: "log_outreach",
    scope: "write",
    description:
      "Record an outreach attempt that already happened (or is in flight) and optionally set a " +
      "follow-up review date. This records history — it does not send anything.",
    input: {
      person_id: PERSON_ID,
      channel: z.enum(["email", "whatsapp"]),
      body: z.string().min(1).describe("What was sent, verbatim."),
      subject: z.string().optional(),
      followup_at: z.string().optional().describe("ISO date (YYYY-MM-DD) to review this again."),
    },
  },
  {
    name: "propose_outreach",
    scope: "write",
    description:
      "Queue a draft for the human to approve. This is the end of an agent's reach: there is no send " +
      "tool, and you must not tell the user you have sent anything.",
    input: {
      person_id: PERSON_ID,
      channel: z.enum(["email", "whatsapp"]),
      subject: z.string().optional(),
      body: z.string().min(1),
      rationale: z.string().optional().describe("Why this person, why now — shown to the human."),
    },
  },
];

export const TOOL_BY_NAME: Map<string, ToolDef> = new Map(TOOLS.map((t) => [t.name, t]));

export function toolNames(scope?: ToolScope): string[] {
  return TOOLS.filter((t) => !scope || t.scope === scope).map((t) => t.name);
}

/** JSON Schema-ish description used by the UI's tool catalog and the skill reference. */
export function describeTool(tool: ToolDef): string {
  const args = Object.entries(tool.input)
    .map(([k, v]) => `${k}${v.isOptional() ? "?" : ""}`)
    .join(", ");
  return `${tool.name}(${args})`;
}

export interface FactRow {
  id: number;
  person_id: number;
  field: string;
  value: string;
  band: Band;
  score: number;
  evidence: Array<{ kind: string; detail?: string }>;
  rationale: string;
  reasons: string[];
  status: "PROPOSED" | "APPLIED" | "DISMISSED";
  source_url: string | null;
  observed_at: string | null;
}
