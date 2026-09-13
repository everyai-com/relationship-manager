#!/usr/bin/env node
/**
 * stdio ⇄ remote MCP bridge.
 *
 * Desktop clients that only speak stdio (Claude Desktop, Cursor's older config)
 * run this instead of talking HTTP directly:
 *
 *   {
 *     "mcpServers": {
 *       "relationship-manager": {
 *         "command": "npx",
 *         "args": ["tsx", "/path/to/packages/cli/src/mcp-stdio.ts"],
 *         "env": { "REL_API": "https://<worker>", "REL_KEY": "rel_..." }
 *       }
 *     }
 *   }
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const API = (process.env.REL_API ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const KEY = process.env.REL_KEY ?? "";

async function main() {
  if (!KEY) {
    console.error("rel-mcp: REL_KEY is required (create one in the Agents screen).");
    process.exit(1);
  }

  const remote = new Client({ name: "rel-stdio-bridge", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${API}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${KEY}` } },
  });
  await remote.connect(transport);

  const server = new Server(
    { name: "relationship-manager", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => remote.listTools());
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    remote.callTool(request.params as { name: string; arguments?: Record<string, unknown> }),
  );

  await server.connect(new StdioServerTransport());
  console.error(`rel-mcp: bridged stdio → ${API}/mcp`);
}

main().catch((err: unknown) => {
  console.error(`rel-mcp: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
