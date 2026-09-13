import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { signaturePreamble, TOOLS, type AiBinding, type D1Like } from "@rel/core";
import type { ZodRawShape } from "zod";
import { agentsPaused, type Principal } from "./auth";
import type { Env } from "./env";
import { callTool } from "./tools/dispatch";

/**
 * The agent surface. Every tool in the contract is registered here from the same
 * definition the REST router and the CLI use — a tool cannot exist on one surface
 * and not the others.
 */
export async function handleMcp(req: Request, env: Env, principal: Principal, ai: AiBinding | null): Promise<Response> {
  const paused = await agentsPaused(env);

  const server = new McpServer(
    { name: "relationship-manager", version: "0.1.0" },
    {
      instructions:
        "Your relationship graph: the people the user actually talks to, resolved across email, WhatsApp, LinkedIn, " +
        "Instagram, calendar and recorded calls. " +
        signaturePreamble() +
        " Read freely. Facts are earned — call record_fact with honest evidence observations and let the ledger score " +
        "them. You cannot send anything: propose_outreach queues a draft for the user to approve. If a source is stale, " +
        "say so.",
    },
  );

  // The SDK's generic inference over a heterogenous tool list is deeper than the
  // compiler will follow, so registration goes through one narrow signature.
  const register = server.tool.bind(server) as unknown as (
    name: string,
    description: string,
    shape: ZodRawShape,
    cb: (args: Record<string, unknown>) => Promise<{
      content: Array<{ type: "text"; text: string }>;
      isError?: boolean;
    }>,
  ) => void;

  for (const tool of TOOLS) {
    register(tool.name, tool.description, tool.input, async (args) => {
      const res = await callTool({
        db: env.DB as unknown as D1Like,
        principal,
        name: tool.name,
        args,
        paused,
        ai,
      });
      const payload = res.ok ? { ok: true, ...(res.result as object), _meta: res.meta } : { ok: false, error: res.error };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
        isError: !res.ok,
      };
    });
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless: each request carries its own key, so there is no session to keep.
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);
  return transport.handleRequest(req);
}
