export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  AI?: Ai;
  AI_MODEL?: string;
  /** Composio: connect accounts and pull Gmail / Google Calendar / Fathom from the cloud. */
  COMPOSIO_API_KEY?: string;
  /** Better Auth: the signing secret and the canonical origin. */
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  /** Optional comma-separated allowlist; without it, only the first account may be created. */
  ALLOWED_EMAILS?: string;
  APP_NAME?: string;
}
