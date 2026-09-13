#!/usr/bin/env node
/**
 * `rel` — the relationship graph from a terminal.
 *
 * Every command is a tool from the same contract the MCP server and the REST API
 * register from, so the CLI can never drift from what an agent sees.
 *
 * Config (env or flags):
 *   REL_API   base URL   (default http://127.0.0.1:8787)
 *   REL_KEY   agent key  (rel_…) — required for anything but a local dev server
 */

const API = (process.env.REL_API ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const KEY = process.env.REL_KEY ?? "";

type Args = { command: string; positional: string[]; flags: Record<string, string> };

function parse(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token.startsWith("--")) {
      const [name, inline] = token.slice(2).split("=");
      if (inline !== undefined) {
        flags[name!] = inline;
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          flags[name!] = next;
          i += 1;
        } else {
          flags[name!] = "true";
        }
      }
    } else {
      positional.push(token);
    }
  }
  return { command: positional.shift() ?? "help", positional, flags };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${API}/api/tools/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}) },
    body: JSON.stringify(args),
  });
  const payload = (await res.json()) as { ok?: boolean; result?: unknown; error?: string };
  if (!res.ok || payload.ok === false) {
    throw new Error(payload.error ?? `request failed (${res.status})`);
  }
  return payload.result;
}

const bold = (s: string) => `\u001b[1m${s}\u001b[0m`;
const dim = (s: string) => `\u001b[2m${s}\u001b[0m`;

function printPeople(result: unknown, json: boolean) {
  if (json) return console.log(JSON.stringify(result, null, 2));
  const people = (result as { people?: Array<Record<string, unknown>> }).people ?? [];
  if (people.length === 0) return console.log(dim("no matches"));
  for (const p of people) {
    const name = String(p.name || p.email || "");
    const meta = [p.title, p.company || p.company_domain].filter(Boolean).join(" · ");
    const counts = `${p.message_count ?? 0} msg / ${p.meeting_count ?? 0} mtg`;
    const review = p.proposed_count ? `  ${p.proposed_count} to review` : "";
    console.log(`${String(p.id).padStart(6)}  ${bold(name.padEnd(26))} ${dim(meta.padEnd(28))} ${dim(counts)}${review}`);
  }
}

function printReconnect(result: unknown, json: boolean) {
  if (json) return console.log(JSON.stringify(result, null, 2));
  const queue = (result as { queue?: Array<Record<string, unknown>> }).queue ?? [];
  if (queue.length === 0) return console.log(dim("nothing in this cohort"));
  for (const row of queue) {
    const name = String(row.name || row.email || row.phone || "");
    console.log(`${String(row.priority).padStart(3)}  ${bold(name.padEnd(28))} ${dim(String(row.cohort))}`);
    if (row.signal) console.log(`     ${dim(String(row.signal).slice(0, 140))}`);
  }
}

async function main() {
  const { command, positional, flags } = parse(process.argv.slice(2));
  const json = flags.json === "true";

  switch (command) {
    case "people": {
      const result = await callTool("search_people", { query: positional.join(" "), limit: Number(flags.limit ?? 25) });
      return printPeople(result, json);
    }
    case "person": {
      const result = await callTool("get_person", { person_id: Number(positional[0]) });
      if (json) return console.log(JSON.stringify(result, null, 2));
      const detail = result as {
        person: Record<string, unknown>;
        facts: Array<Record<string, unknown>>;
        identifiers: Record<string, string[]>;
      };
      console.log(bold(String(detail.person.name || detail.person.email)));
      for (const [kind, values] of Object.entries(detail.identifiers ?? {})) {
        if (values.length) console.log(dim(`  ${kind}: ${values.join(", ")}`));
      }
      if (detail.facts.length) {
        console.log("\n" + bold("Facts"));
        for (const fact of detail.facts) {
          const status = String(fact.status) === "APPLIED" ? "✓" : "?";
          console.log(`  ${status} ${fact.field}: ${fact.value}  ${dim(`[${fact.band}] ${fact.rationale}`)}`);
        }
      }
      return;
    }
    case "prep": {
      const result = (await callTool("prep_brief", { person_id: Number(positional[0]) })) as { brief: string };
      return console.log(json ? JSON.stringify(result, null, 2) : result.brief);
    }
    case "timeline": {
      const result = await callTool("person_timeline", {
        person_id: Number(positional[0]),
        limit: Number(flags.limit ?? 25),
      });
      if (json) return console.log(JSON.stringify(result, null, 2));
      const entries = (result as { timeline?: Array<Record<string, unknown>> }).timeline ?? [];
      for (const entry of entries) {
        console.log(`${String(entry.at ?? "").slice(0, 10)}  ${String(entry.kind).padEnd(9)} ${String(entry.title).slice(0, 70)}`);
      }
      return;
    }
    case "facts": {
      const result = await callTool("list_facts", {
        status: flags.status,
        person_id: flags.person ? Number(flags.person) : undefined,
        limit: Number(flags.limit ?? 50),
      });
      if (json) return console.log(JSON.stringify(result, null, 2));
      const facts = (result as { facts?: Array<Record<string, unknown>> }).facts ?? [];
      for (const fact of facts) {
        console.log(`${String(fact.status).padEnd(9)} ${String(fact.person_name ?? "").padEnd(22)} ${fact.field}: ${fact.value}`);
        if (fact.status === "PROPOSED") console.log(dim(`          ${fact.rationale}`));
      }
      return;
    }
    case "reconnect": {
      const result = await callTool("reconnect_queue", {
        cohort: flags.cohort,
        limit: Number(flags.limit ?? 25),
        include_suppressed: flags.suppressed === "true",
      });
      return printReconnect(result, json);
    }
    case "connections": {
      const result = await callTool("connection_status", {});
      if (json) return console.log(JSON.stringify(result, null, 2));
      for (const row of (result as { connections?: Array<Record<string, unknown>> }).connections ?? []) {
        console.log(`${String(row.status).padEnd(15)} ${String(row.label).padEnd(22)} ${String(row.item_count).padStart(7)} items  ${dim(String(row.last_sync_at ?? "never"))}`);
      }
      return;
    }
    case "decide": {
      const result = await callTool("decide_fact", {
        fact_id: Number(positional[0]),
        decision: positional[1] ?? "accept",
      });
      return console.log(JSON.stringify(result, null, 2));
    }
    case "log": {
      const result = await callTool("log_outreach", {
        person_id: Number(positional[0]),
        channel: flags.channel ?? "email",
        subject: flags.subject,
        body: flags.body ?? "",
        followup_at: flags.followup,
      });
      return console.log(JSON.stringify(result, null, 2));
    }
    case "propose": {
      const result = await callTool("propose_outreach", {
        person_id: Number(positional[0]),
        channel: flags.channel ?? "email",
        subject: flags.subject,
        body: flags.body ?? "",
        rationale: flags.rationale,
      });
      return console.log(JSON.stringify(result, null, 2));
    }
    default:
      return console.log(
        [
          bold("rel") + " — your relationship graph",
          "",
          `  ${bold("people")} [query]                 who you talk to`,
          `  ${bold("person")} <id>                    the full record`,
          `  ${bold("prep")} <id>                      brief before you talk to someone`,
          `  ${bold("timeline")} <id>                  email, meetings, calls, WhatsApp`,
          `  ${bold("facts")} [--status PROPOSED]      what is settled, what needs your call`,
          `  ${bold("reconnect")} [--cohort X]         who is worth a second conversation`,
          `  ${bold("connections")}                    how fresh each source is`,
          `  ${bold("decide")} <factId> accept|dismiss`,
          `  ${bold("log")} <id> --channel email --body "..." [--followup YYYY-MM-DD]`,
          `  ${bold("propose")} <id> --channel email --subject "..." --body "..."`,
          "",
          dim(`  API ${API}${KEY ? " · key set" : " · no key (REL_KEY unset)"}`),
          dim("  add --json for raw output"),
        ].join("\n"),
      );
  }
}

main().catch((err: unknown) => {
  console.error(`rel: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
