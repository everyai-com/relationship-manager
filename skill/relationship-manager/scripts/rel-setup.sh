#!/usr/bin/env bash
# Wire this relationship graph into Claude Code and Codex.
#
#   REL_API=https://<your-worker> REL_KEY=rel_... ./scripts/rel-setup.sh
#
# The key comes from the Agents screen in the web app (or POST /api/agents).

set -euo pipefail

API="${REL_API:-}"
KEY="${REL_KEY:-}"

if [[ -z "$API" || -z "$KEY" ]]; then
  echo "usage: REL_API=https://<worker> REL_KEY=rel_... $0" >&2
  exit 1
fi

if command -v claude >/dev/null 2>&1; then
  claude mcp remove relationship-manager >/dev/null 2>&1 || true
  claude mcp add --transport http relationship-manager "${API%/}/mcp" --header "Authorization: Bearer ${KEY}"
  echo "claude: added relationship-manager"
else
  echo "claude CLI not found — skipping (add ${API%/}/mcp as an HTTP MCP server)"
fi

CODEX_CONFIG="${HOME}/.codex/config.toml"
if [[ -f "$CODEX_CONFIG" ]]; then
  if grep -q "^\[mcp_servers.relationship-manager\]" "$CODEX_CONFIG"; then
    echo "codex: already configured"
  else
    cat >>"$CODEX_CONFIG" <<EOF

[mcp_servers.relationship-manager]
url = "${API%/}/mcp"
http_headers = { Authorization = "Bearer ${KEY}" }
EOF
    echo "codex: appended to ${CODEX_CONFIG}"
  fi
else
  echo "codex config not found — skipping"
fi

echo
echo "Try: \"who should I reconnect with this week, and why?\""
