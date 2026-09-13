import { useState } from "react";
import { api } from "../lib/api";
import { errorMessage } from "../App";

export function LoginScreen({ configured, onSignedIn }: { configured: boolean; onSignedIn: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    if (!password.trim()) {
      setError("Enter the password for this workspace.");
      return;
    }
    setBusy(true);
    setError(null);
    api
      .login(password)
      .then(() => onSignedIn())
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1>Relationship Manager</h1>
        <p>
          Your graph of the people you actually talk to — resolved across email, WhatsApp, calendar and calls. Agents
          reach it through MCP; this is the human side.
        </p>

        {configured ? (
          <>
            <div className="field" style={{ marginBottom: "var(--space-4)" }}>
              <label className="field-label" htmlFor="password">
                Workspace password
              </label>
              <input
                id="password"
                className="input"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") submit();
                }}
              />
            </div>
            {error ? (
              <div className="banner" style={{ marginBottom: "var(--space-4)" }} role="alert">
                {error}
              </div>
            ) : null}
            <button className="button" onClick={submit} disabled={busy} style={{ width: "100%", justifyContent: "center" }}>
              {busy ? "Checking…" : "Open the graph"}
            </button>
          </>
        ) : (
          <div className="banner">
            This deployment has no password yet. Set it with{" "}
            <code>npx wrangler secret put LOGIN_PASSWORD</code> and reload.
          </div>
        )}
      </div>
    </div>
  );
}
