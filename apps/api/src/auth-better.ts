import { APIError, betterAuth } from "better-auth";
import { Kysely } from "kysely";
import { d1Dialect } from "./d1-dialect";
import type { Env } from "./env";

/**
 * Real accounts on Cloudflare.
 *
 * Better Auth over D1 (Kysely + the D1 dialect), email + password, sessions in
 * the `session` table. Agent keys are unchanged — they are a separate principal
 * with their own scopes, and they never touch this.
 *
 * Sign-up is closed by default. This graph is one person's private
 * relationships; an open sign-up form would be a data leak with a nice UI.
 */

/** Who may create an account: an explicit list, or the first person only. */
export async function signUpAllowed(env: Env, email: string, existingUsers: number): Promise<boolean> {
  const allowlist = (env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (allowlist.length > 0) return allowlist.includes(email.toLowerCase());
  return existingUsers === 0;
}

export function createAuth(env: Env) {
  const db = new Kysely({ dialect: d1Dialect(env.DB) });

  return betterAuth({
    appName: "Relationship Manager",
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL ?? "http://localhost:8787",
    basePath: "/api/auth",
    database: { db, type: "kysely" },
    // D1 refuses the statements Better Auth's schema introspection uses
    // (`SQLITE_AUTH: not authorized`), and the check is advisory anyway — the
    // migration in apps/api/migrations/0003_auth.sql is the source of truth.
    advanced: { database: { validateSchema: false } },
    emailAndPassword: {
      enabled: true,
      // No mail server is configured, and this is a private deployment: an
      // account is created by the owner, not confirmed by an inbox.
      requireEmailVerification: false,
      minPasswordLength: 10,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
    trustedOrigins: [env.BETTER_AUTH_URL ?? "http://localhost:8787", "http://localhost:5173"],
    user: {
      changeEmail: { enabled: false },
      deleteUser: { enabled: false },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const existing = await env.DB.prepare("SELECT COUNT(*) AS n FROM user").first<{ n: number }>();
            if (!(await signUpAllowed(env, user.email, existing?.n ?? 0))) {
              throw new APIError("FORBIDDEN", {
                message:
                  "This deployment is private. Ask the owner to add your address to ALLOWED_EMAILS, or sign in with an existing account.",
              });
            }
            return { data: user };
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
