#!/usr/bin/env bash
# Deploy this relationship graph to Cloudflare — one command, safe to re-run.
#
#   npm run deploy:cloudflare
#
# It finds (or creates) the D1 database, makes sure the Worker has a session
# secret, applies migrations, builds the UI, deploys, and prints what the human
# needs to do next. It never replaces a database that already holds a graph and
# never rotates a secret that already exists — re-running it is safe.
#
# Authentication — either:
#   npx wrangler login                                            # a human, once
#   export CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=…         # headless / CI
#
# Optional environment:
#   BETTER_AUTH_SECRET=…   set a specific session secret instead of a generated one
#   COMPOSIO_API_KEY=…     store the Composio key too (connects Gmail/Calendar/Fathom)

set -euo pipefail
cd "$(dirname "$0")/.."

CONFIG="wrangler.jsonc"

say() { printf '%s\n' "$*"; }
die() { printf '\n%s\n' "$*" >&2; exit 1; }

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

# ---- preflight -------------------------------------------------------------

command -v node >/dev/null 2>&1 || die "Node.js is required (>= 20). Install it, then re-run."
[ -f "$CONFIG" ] || die "No $CONFIG here — run this from the repository root."
[ -d node_modules ] || say "→ dependencies not installed yet; run: npm install"

say "→ checking Cloudflare access"
if ! WHOAMI="$(npx --no-install wrangler whoami 2>&1)"; then
  printf '%s\n' "$WHOAMI" >&2
  die "Not authenticated with Cloudflare. Do one of:
  • a human runs:      npx wrangler login
  • or export a token: CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=…"
fi
ACCOUNT="$(printf '%s\n' "$WHOAMI" | grep -oE '│ [^│]+Account[^│]*│' | head -1 | sed 's/│//g; s/^ *//; s/ *$//')"
[ -n "$ACCOUNT" ] || ACCOUNT="your Cloudflare account"
say "  $ACCOUNT"

# ---- the database ----------------------------------------------------------

read_config() {
  node -e "
const fs = require('fs');
const raw = fs.readFileSync(process.env.CONFIG, 'utf8').replace(/^[ \t]*\/\/.*\$/gm, '');
let cfg = {};
try { cfg = JSON.parse(raw); } catch (error) { console.error('could not parse ' + process.env.CONFIG); process.exit(1); }
const db = (cfg.d1_databases || [])[0] || {};
process.stdout.write((db.database_name || 'relationship-manager') + ' ' + (db.database_id || '-'));
"
}

read -r DB_NAME DB_ID <<EOF
$(CONFIG="$CONFIG" read_config)
EOF

lookup_db_id() {
  npx --no-install wrangler d1 list --json 2>/dev/null | DB_NAME="$DB_NAME" node -e "
let raw = '';
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let list = [];
  try { list = JSON.parse(raw); } catch {}
  const hit = (Array.isArray(list) ? list : []).find((entry) => entry && entry.name === process.env.DB_NAME);
  process.stdout.write(hit ? String(hit.uuid || hit.id || '') : '');
});
"
}

say "→ resolving D1 database '$DB_NAME'"
LIVE_ID="$(lookup_db_id)"
if [ -z "$LIVE_ID" ]; then
  say "  none in this account — creating it"
  npx --no-install wrangler d1 create "$DB_NAME" >/dev/null
  LIVE_ID="$(lookup_db_id)"
  [ -n "$LIVE_ID" ] || die "Created the database but could not read its id. Run: npx wrangler d1 list"
  say "  created $LIVE_ID"
else
  say "  found $LIVE_ID"
fi

if [ "$LIVE_ID" != "$DB_ID" ]; then
  CONFIG="$CONFIG" LIVE_ID="$LIVE_ID" node -e "
const fs = require('fs');
const path = process.env.CONFIG;
const next = fs.readFileSync(path, 'utf8').replace(/\"database_id\"\s*:\s*\"[^\"]*\"/, '\"database_id\": \"' + process.env.LIVE_ID + '\"');
fs.writeFileSync(path, next);
"
  say "  bound it in $CONFIG (commit that change in your fork)"
fi

# ---- secrets ---------------------------------------------------------------

SECRET_NAMES="$(npx --no-install wrangler secret list 2>/dev/null || true)"
has_secret() { printf '%s' "$SECRET_NAMES" | grep -q "$1"; }

if [ -n "${BETTER_AUTH_SECRET:-}" ]; then
  printf '%s' "$BETTER_AUTH_SECRET" | npx --no-install wrangler secret put BETTER_AUTH_SECRET >/dev/null
  say "→ session secret set from \$BETTER_AUTH_SECRET"
elif has_secret BETTER_AUTH_SECRET; then
  say "→ session secret already set — leaving it alone (sessions stay valid)"
else
  printf '%s' "$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")" \
    | npx --no-install wrangler secret put BETTER_AUTH_SECRET >/dev/null
  say "→ generated a session secret and stored it as a Worker secret (never printed)"
fi

if [ -n "${COMPOSIO_API_KEY:-}" ]; then
  if has_secret COMPOSIO_API_KEY; then
    say "→ Composio key already set — leaving it alone"
  else
    printf '%s' "$COMPOSIO_API_KEY" | npx --no-install wrangler secret put COMPOSIO_API_KEY >/dev/null
    say "→ Composio key stored — the Connections screen can sign in to Gmail, Calendar and Fathom"
  fi
fi

# ---- schema, build, deploy -------------------------------------------------

say "→ applying migrations"
npm run --silent db:migrate

say "→ building the UI and deploying"
DEPLOY_OUT="$(npm run --silent build >/dev/null 2>&1 && npx --no-install wrangler deploy 2>&1)" \
  || { printf '%s\n' "$DEPLOY_OUT" >&2; die "Deploy failed — the output above says why."; }

URL="$(printf '%s\n' "$DEPLOY_OUT" | grep -oE 'https://[A-Za-z0-9._-]+\.workers\.dev' | head -1)"
[ -n "$URL" ] || die "Deployed, but no workers.dev URL was printed. Check: npx wrangler deployments list"

# ---- what happens next -----------------------------------------------------

cat <<EOF

Deployed.  ${URL}
MCP endpoint for agents:  ${URL}/mcp

Three steps to make it yours:

  1. Open ${URL} and create the first account.
     It becomes the owner and sign-up closes behind you.

  2. Agents → New key → copy the config it prints (it carries your URL and the
     new key), or wire Claude Code / Codex from the CLI:

       REL_API=${URL} REL_KEY=rel_… ./skill/relationship-manager/scripts/rel-setup.sh

  3. Optional — fill the graph: add COMPOSIO_API_KEY under
     Settings → Variables and secrets, then connect Gmail, Google Calendar or
     Fathom on the Connections screen.

A key cannot be minted by an agent, on purpose: ${URL}/api/agents refuses
agent principals, so a human creates the first one.
EOF
