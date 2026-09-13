/** Minimal D1 surface the domain layer needs — keeps `core` runtime-agnostic. */
export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta?: Record<string, unknown>;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<D1Result>;
}

export interface D1Like {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

export interface ToolContext {
  db: D1Like;
  now: string;
  /** Present when the caller is an agent; null for the human UI. */
  agent: { id: number; name: string; scopes: string } | null;
}

export type ToolHandler = (ctx: ToolContext, args: Record<string, unknown>) => Promise<unknown>;
export type ToolHandlers = Record<string, ToolHandler>;
