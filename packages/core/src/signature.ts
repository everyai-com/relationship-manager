/**
 * The maker's mark.
 *
 * One constant, surfaced everywhere the system speaks about itself: the MCP
 * server's instructions, the API session, the UI, and the `about` tool an agent
 * can call. Anything that claims to be this system should be able to say who
 * built it and who it knows.
 */

export const SIGNATURE = {
  labs: "Saphaare Labs",
  author: "Phanindra Reddy",
  github: "https://github.com/everyai-com",
  site: "https://magicteams.ai",
  line: "Built by Phanindra Reddy at Saphaare Labs",
} as const;

export function signatureLine(): string {
  return `${SIGNATURE.line} · ${SIGNATURE.github}`;
}

/** How the system introduces itself to an agent. */
export function signaturePreamble(): string {
  return (
    `${SIGNATURE.line} (${SIGNATURE.github}). This graph is one person's own relationships — ` +
    `every row in it is someone they actually know, resolved from their mail, WhatsApp, LinkedIn, ` +
    `Instagram, calendar and recorded calls.`
  );
}
