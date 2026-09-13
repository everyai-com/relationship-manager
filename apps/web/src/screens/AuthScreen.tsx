import { useState } from "react";
import { api } from "../lib/api";
import { errorMessage } from "../App";

type Mode = "sign-in" | "sign-up";

export function AuthScreen({
  configured,
  onSignedIn,
}: {
  configured: boolean;
  onSignedIn: () => void;
}) {
  const [mode, setMode] = useState<Mode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    if (!email.trim() || !password) {
      setError("An email address and a password are required.");
      return;
    }
    setBusy(true);
    setError(null);
    const call =
      mode === "sign-up" ? api.signUp(email.trim(), password, name.trim() || email.split("@")[0]!) : api.signIn(email.trim(), password);
    call
      .then(() => onSignedIn())
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setBusy(false));
  };

  if (!configured) {
    return (
      <div className="login-wrap">
        <div className="login-card">
          <h1>Relationship Manager</h1>
          <p>Accounts are not configured on this deployment yet.</p>
          <div className="banner">
            Set the auth secret and apply the auth migration:
            <br />
            <code>npx wrangler secret put BETTER_AUTH_SECRET</code>
            <br />
            <code>npm run db:migrate</code>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1>Relationship Manager</h1>
        <p>
          Your graph of the people you actually talk to — resolved across email, WhatsApp, LinkedIn, Instagram, calendar
          and calls. Agents reach it through MCP; this is the human side.
        </p>

        <div style={{ display: "flex", gap: "var(--space-2)", marginBottom: "var(--space-4)" }}>
          <button
            className={`button tiny ${mode === "sign-in" ? "" : "secondary"}`}
            onClick={() => {
              setMode("sign-in");
              setError(null);
            }}
            aria-pressed={mode === "sign-in"}
          >
            Sign in
          </button>
          <button
            className={`button tiny ${mode === "sign-up" ? "" : "secondary"}`}
            onClick={() => {
              setMode("sign-up");
              setError(null);
            }}
            aria-pressed={mode === "sign-up"}
          >
            Create account
          </button>
        </div>

        {mode === "sign-up" ? (
          <div className="field" style={{ marginBottom: "var(--space-3)" }}>
            <label className="field-label" htmlFor="name">
              Your name
            </label>
            <input
              id="name"
              className="input"
              autoComplete="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
        ) : null}

        <div className="field" style={{ marginBottom: "var(--space-3)" }}>
          <label className="field-label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            className="input"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
          />
        </div>

        <div className="field" style={{ marginBottom: "var(--space-4)" }}>
          <label className="field-label" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            className="input"
            type="password"
            autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
          />
          {mode === "sign-up" ? (
            <span style={{ fontSize: 11.5, color: "var(--gray-500)" }}>At least 10 characters.</span>
          ) : null}
        </div>

        {error ? (
          <div className="banner" style={{ marginBottom: "var(--space-4)" }} role="alert">
            {error}
          </div>
        ) : null}

        <button className="button" onClick={submit} disabled={busy} style={{ width: "100%", justifyContent: "center" }}>
          {busy ? "One moment…" : mode === "sign-up" ? "Create account" : "Sign in"}
        </button>

        {mode === "sign-up" ? (
          <p style={{ fontSize: 11.5, color: "var(--gray-500)", marginTop: "var(--space-3)" }}>
            This deployment is private: the first account becomes the owner, and after that only addresses on the
            allowlist can sign up.
          </p>
        ) : null}
      </div>
    </div>
  );
}
