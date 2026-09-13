import type { Band } from "./evidence";
import type { IdentifierKind } from "./identity";

export interface Person {
  id: number;
  email: string;
  name: string;
  title: string;
  company: string;
  company_domain: string;
  location: string;
  last_touch: string | null;
  first_seen: string | null;
  message_count: number;
  meeting_count: number;
  proposed_count?: number;
  identifiers?: Identifiers;
}

export interface Identifiers {
  emails: string[];
  phones: string[];
  wa_jids: string[];
  fathom: string[];
}

export interface Identifier {
  id: number;
  person_id: number;
  kind: IdentifierKind;
  value: string;
}

export interface Fact {
  id: number;
  person_id: number;
  field: string;
  value: string;
  band: Band;
  score: number;
  rationale: string;
  reasons: string[];
  evidence: Array<{ kind: string; detail?: string }>;
  status: "PROPOSED" | "APPLIED" | "DISMISSED";
  source_url: string | null;
  observed_at: string | null;
}

export interface TimelineEntry {
  kind: "email" | "meeting" | "call" | "whatsapp";
  id: string;
  title: string;
  detail: string;
  at: string | null;
  service: string;
  link?: string | null;
}

export interface ReconnectEntry {
  contact_id: string;
  name: string;
  email: string;
  phone: string;
  company: string;
  lane: string;
  stage: string;
  cohort: string;
  cohort_rank: number;
  priority: number;
  signal: string;
  action: string;
  conversation_first: string | null;
  conversation_last: string | null;
  conversation_evidence: string;
  inbound: number;
  outbound: number;
  draft: string;
  draft_status: string;
  suppressed: boolean;
  history_links: string[];
}

export type ConnectionState = "connected" | "stale" | "error" | "not_configured";

export interface Connection {
  id: string;
  source: string;
  label: string;
  status: ConnectionState;
  last_sync_at: string | null;
  item_count: number;
  detail: string;
}

export interface AgentKey {
  id: number;
  name: string;
  scopes: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

export interface AgentCall {
  id: number;
  agent_key_id: number | null;
  agent_name?: string | null;
  tool: string;
  args_digest: string;
  status: "ok" | "denied" | "error";
  duration_ms: number;
  created_at: string;
}

export interface Outreach {
  id: number;
  person_id: number;
  channel: "email" | "whatsapp";
  to_addr: string;
  subject: string;
  body: string;
  status: string;
  sent_at: string | null;
  followup_at: string | null;
  reply_summary: string;
}

export interface Approval {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
  status: "pending" | "approved" | "denied";
  created_at: string;
  decided_at: string | null;
}

/** What the API returns from a tool call. */
export interface ToolOk<T> {
  ok: true;
  result: T;
}
export interface ToolErr {
  ok: false;
  error: string;
}
export type ToolResponse<T = unknown> = ToolOk<T> | ToolErr;
