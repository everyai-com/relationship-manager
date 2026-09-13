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

/**
 * The stages a person can sit in. Deliberately the same vocabulary as the CRM
 * this graph inherited, so the stages that came across mean something —
 * including "Excluded", which the import used for its deliberate holds. It is a
 * stage here; the hard do-not-contact flag lives on the reconnect row.
 */
export const PIPELINE_STAGES = [
  "Needs review",
  "Ready",
  "Contacted",
  "Replied",
  "Meeting",
  "Proposal",
  "Won",
  "On hold",
  "Closed",
  "Excluded",
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

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
        .describe("Name, email, company, domain or social handle. Omit to list the people you were most recently in touch with."),
      source: z
        .enum(["email", "whatsapp", "linkedin", "instagram", "phone", "fathom"])
        .optional()
        .describe("Only people reachable on this kind of handle."),
      stage: z.string().optional().describe("Only people in this pipeline stage."),
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
    name: "ask_about_person",
    scope: "read",
    description:
      "Ask a question about one person, answered from their record only. Runs on Workers AI with the graph as the sole " +
      "context, so it can only tell you what is actually on file — if the data is silent, it says so. Use it when a " +
      "question needs judgement over the record (what to raise, what changed, how to approach them) rather than a dump.",
    input: {
      person_id: PERSON_ID,
      question: z
        .string()
        .optional()
        .describe("Defaults to 'What should I know before I talk to them, and what is the natural next step?'"),
    },
  },
  {
    name: "daily_brief",
    scope: "read",
    description:
      "A short brief on who needs attention right now, built from overdue follow-ups, facts awaiting a decision and the " +
      "top of the reconnect queue, then written up by Workers AI. Grounded: it can only reference what the graph holds.",
    input: {
      focus: z.string().optional().describe("Optional angle, e.g. 'revenue', 'investors', 'people I owe a reply'."),
    },
  },
  {
    name: "about",
    scope: "read",
    description:
      "Who built this, what it is, and what is in the graph right now. Call it when the user asks who made this, what " +
      "this connects to, or how much the system knows.",
    input: {},
  },
  {
    name: "pipeline_board",
    scope: "read",
    description:
      "The pipeline: people grouped by the stage the user has placed them in, newest activity first inside each column. " +
      "Only people who have been placed appear — an empty stage means nobody is in it, not that nobody matches. Use it " +
      "to answer 'where does this stand' and 'what has moved'.",
    input: {
      query: z.string().optional().describe("Only people matching this name, company or domain."),
      per_stage: z.number().int().min(1).max(200).optional().describe("Cards per column, default 40."),
    },
  },
  {
    name: "set_person_stage",
    scope: "write",
    description:
      `Move a person to a pipeline stage. Stages: ${PIPELINE_STAGES.join(" · ")}. Use "" to take them out of the ` +
      "pipeline entirely. This records where a relationship stands; it does not send anything.",
    input: {
      person_id: PERSON_ID,
      stage: z.string().max(40).describe('One of the stages, or "" to remove them from the pipeline.'),
    },
  },
  {
    name: "import_social_export",
    scope: "write",
    description:
      "Add people, invitations and messages from an official social export (LinkedIn's Connections/Invitations/messages CSVs, " +
      "Instagram's followers/following JSON). Use this rather than scraping: LinkedIn has no connections API and Instagram's " +
      "Graph API is business-only, so the user's own export is the only legitimate source. Handles are normalised and merged " +
      "into existing people — the same human never forks into two rows. Profile fields arrive as suggestions, never overwrites.",
    input: {
      source: z.enum(["linkedin", "instagram"]),
      label: z.string().optional().describe("Display name for the connection card, e.g. 'LinkedIn'."),
      exported_at: z.string().optional().describe("When the export was produced, if known."),
      self_handles: z
        .array(z.string())
        .optional()
        .describe("The user's own handles in this export, so their own messages are not attributed to a contact."),
      people: z
        .array(
          z.object({
            name: z.string().optional(),
            email: z.string().optional(),
            phone: z.string().optional(),
            linkedin: z.string().optional().describe("Profile URL or slug."),
            instagram: z.string().optional().describe("Handle or profile URL."),
            company: z.string().optional(),
            title: z.string().optional(),
            connected_on: z.string().optional().describe("ISO date, when the source says so."),
            evidence_kind: z
              .string()
              .optional()
              .describe(
                "Which observation this rests on: linkedin.connection, linkedin.invitation-sent, " +
                  "linkedin.invitation-received, instagram.follows-you, instagram.you-follow.",
              ),
            note: z.string().optional().describe("What they said, for invitations."),
          }),
        )
        .optional(),
      messages: z
        .array(
          z.object({
            conversation_id: z.string(),
            from_handle: z.string().optional(),
            to_handle: z.string().optional(),
            from_name: z.string().optional(),
            at: z.string().describe("ISO timestamp."),
            text: z.string(),
          }),
        )
        .optional(),
    },
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
