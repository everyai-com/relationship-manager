export interface SessionInfo {
  authed: boolean;
  kind: "human" | "agent" | null;
  name: string | null;
  scopes: string | null;
  configured: boolean;
  app: string;
}

export interface ToolMeta {
  tool: string;
  scope: string;
  duration_ms: number;
  band?: string;
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
  agent_name: string | null;
  tool: string;
  status: "ok" | "denied" | "error";
  duration_ms: number;
  detail?: string;
  created_at: string;
}

export interface ToolCatalogEntry {
  name: string;
  scope: "read" | "write";
  description: string;
  args: string[];
}

/** Shapes returned by the tools. Kept here so screens never guess. */
export interface Identifiers {
  emails: string[];
  phones: string[];
  wa_jids: string[];
  fathom: string[];
}

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

export interface Fact {
  id: number;
  person_id: number;
  person_name?: string;
  field: string;
  value: string;
  band: "VERIFIED" | "PROBABLE" | "POSSIBLE";
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

export interface Connection {
  id: string;
  source: string;
  label: string;
  status: "connected" | "stale" | "error" | "not_configured";
  last_sync_at: string | null;
  item_count: number;
  detail: string;
}

export interface PersonDetail {
  person: Person & { human_fields: string[] };
  facts: Fact[];
  identifiers: Identifiers;
  messages: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const message = (data as { error?: string } | null)?.error ?? `Request failed (${res.status})`;
    throw new ApiError(message, res.status);
  }
  return data as T;
}

/** Tools return { ok, result } — unwrap so screens see the result or an error. */
async function tool<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await request<{ ok: boolean; result?: T; error?: string }>(`/api/tools/${name}`, {
    method: "POST",
    body: JSON.stringify(args),
  });
  if (!res.ok || res.result === undefined) throw new ApiError(res.error ?? "Tool failed", 400);
  return res.result;
}

export const api = {
  session: () => request<SessionInfo>("/api/session"),
  login: (password: string) =>
    request<{ ok: boolean }>("/api/login", { method: "POST", body: JSON.stringify({ password }) }),
  logout: () => request<{ ok: boolean }>("/api/logout", { method: "POST" }),
  overview: () => request<Overview>("/api/overview"),
  tool,
  catalog: () => request<{ tools: ToolCatalogEntry[] }>("/api/tools"),
  agents: () => request<{ keys: AgentKey[]; paused: boolean }>("/api/agents"),
  createAgent: (name: string, scopes: "read" | "write") =>
    request<{ key: string; name: string; scopes: string; note: string }>("/api/agents", {
      method: "POST",
      body: JSON.stringify({ name, scopes }),
    }),
  revokeAgent: (id: number) => request<{ ok: boolean }>(`/api/agents/${id}/revoke`, { method: "POST" }),
  pauseAgents: (paused: boolean) =>
    request<{ ok: boolean; paused: boolean }>("/api/agents/0/pause", { method: "POST", body: JSON.stringify({ paused }) }),
  calls: (limit = 50) => request<{ calls: AgentCall[] }>(`/api/agents/calls?limit=${limit}`),
  approvals: () =>
    request<{ approvals: Array<{ id: number; kind: string; payload: Record<string, unknown>; created_at: string }> }>(
      "/api/approvals",
    ),
  decideApproval: (id: number, decision: "approve" | "deny") =>
    request<{ ok: boolean; status: string }>(`/api/approvals/${id}`, {
      method: "POST",
      body: JSON.stringify({ decision }),
    }),
};

export interface Overview {
  caller: { kind: string; name: string };
  counts: {
    people: number;
    messages: number;
    meetings: number;
    proposed: number;
    reconnectReady: number;
    agents24h: number;
  };
  due: Array<{
    id: number;
    person_id: number | null;
    channel: string;
    subject: string;
    followup_at: string;
    status: string;
  }>;
  stale: Array<{ id: string; source: string; label: string; status: string; last_sync_at: string | null; item_count: number }>;
  agent_calls: Array<{
    id: number;
    tool: string;
    status: "ok" | "denied" | "error";
    duration_ms: number;
    created_at: string;
    agent_name: string | null;
  }>;
}
