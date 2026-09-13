/**
 * Parsers for the official social exports.
 *
 * LinkedIn gives CSV with quoted fields that contain commas and newlines;
 * Instagram gives JSON. Neither offers an API for a personal account's own
 * connections, so an export is the only honest source — and re-exporting is the
 * only way to refresh.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export interface ImportPerson {
  name?: string;
  email?: string;
  linkedin?: string;
  instagram?: string;
  company?: string;
  title?: string;
  connected_on?: string;
  evidence_kind?: string;
  note?: string;
}

export interface ImportMessage {
  conversation_id: string;
  from_handle?: string;
  to_handle?: string;
  from_name?: string;
  at: string;
  text: string;
}

export interface SocialExport {
  source: "linkedin" | "instagram";
  label: string;
  exported_at?: string;
  self_handles: string[];
  people: ImportPerson[];
  messages: ImportMessage[];
  notes: string[];
}

/** RFC4180-ish CSV: quotes, escaped quotes, embedded newlines, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "07 May 2026" → "2026-05-07" (the format LinkedIn writes in Connections.csv). */
export function parseLinkedInDate(value: string): string {
  const v = (value ?? "").trim();
  if (!v) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  const match = v.match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/);
  if (match) {
    const month = MONTHS.indexOf(match[2]!.toLowerCase()) + 1;
    if (month > 0) return `${match[3]}-${String(month).padStart(2, "0")}-${String(Number(match[1])).padStart(2, "0")}`;
  }
  return "";
}

/** "2026-05-18 00:37:27 UTC" → ISO 8601. */
export function parseLinkedInTimestamp(value: string): string {
  const v = (value ?? "").trim();
  const match = v.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  if (!match) return "";
  return `${match[1]}T${match[2]}Z`;
}

/** LinkedIn's Connections.csv carries two preamble lines before the header. */
function findHeader(rows: string[][], firstColumn: string): number {
  return rows.findIndex((row) => row[0]?.trim().toLowerCase() === firstColumn);
}

function toObjects(rows: string[][], headerIndex: number): Array<Record<string, string>> {
  const header = rows[headerIndex]!.map((h) => h.trim());
  return rows.slice(headerIndex + 1).map((row) => {
    const out: Record<string, string> = {};
    header.forEach((key, index) => {
      out[key] = (row[index] ?? "").trim();
    });
    return out;
  });
}

/** Read a file that may live inside a real .zip (Instagram exports arrive zipped).
 *  A directory whose name merely ends in ".zip" — which is what an extracted
 *  LinkedIn export looks like — is read directly. */
function readMaybeZipped(path: string, name: string): string | null {
  let isDirectory = false;
  try {
    isDirectory = statSync(path).isDirectory();
  } catch {
    return null;
  }

  if (!isDirectory) {
    if (!/\.zip$/i.test(path)) return null;
    try {
      return execFileSync("unzip", ["-p", path, name], { maxBuffer: 512 * 1024 * 1024 }).toString("utf8");
    } catch {
      return null;
    }
  }

  const direct = join(path, name);
  if (existsSync(direct)) return readFileSync(direct, "utf8");
  // Instagram nests its export one level down (instagram-<user>-<date>/...).
  try {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const nested = join(path, entry.name, name);
      if (existsSync(nested)) return readFileSync(nested, "utf8");
    }
  } catch {
    /* not a directory */
  }
  return null;
}

// ---------------------------------------------------------------------------
// LinkedIn
// ---------------------------------------------------------------------------

export function parseLinkedInExport(path: string, options: { skipMessages?: boolean; messageLimit?: number } = {}): SocialExport {
  const notes: string[] = [];
  const people: ImportPerson[] = [];
  const messages: ImportMessage[] = [];
  const selfHandles = new Set<string>();

  const connectionsCsv = readMaybeZipped(path, "Connections.csv");
  if (connectionsCsv) {
    const rows = parseCsv(connectionsCsv);
    const headerIndex = findHeader(rows, "first name");
    if (headerIndex >= 0) {
      for (const row of toObjects(rows, headerIndex)) {
        const name = [row["First Name"], row["Last Name"]].filter(Boolean).join(" ").trim();
        const url = row.URL ?? "";
        if (!name && !url) continue;
        people.push({
          name,
          linkedin: url,
          email: row["Email Address"] || undefined,
          company: row.Company || undefined,
          title: row.Position || undefined,
          connected_on: parseLinkedInDate(row["Connected On"] ?? "") || undefined,
          evidence_kind: "linkedin.connection",
        });
      }
      notes.push(`${people.length} connections`);
    }
  } else {
    notes.push("Connections.csv not found — skipping");
  }

  const invitationsCsv = readMaybeZipped(path, "Invitations.csv");
  if (invitationsCsv) {
    const rows = parseCsv(invitationsCsv);
    const headerIndex = findHeader(rows, "from");
    if (headerIndex >= 0) {
      let count = 0;
      for (const row of toObjects(rows, headerIndex)) {
        const outgoing = (row.Direction ?? "").toUpperCase().startsWith("OUT");
        const selfUrl = outgoing ? row.inviterProfileUrl : row.inviteeProfileUrl;
        if (selfUrl) selfHandles.add(selfUrl);
        const counterpart = outgoing ? row.inviteeProfileUrl : row.inviterProfileUrl;
        const name = outgoing ? row.To : row.From;
        if (!counterpart && !name) continue;
        people.push({
          name,
          linkedin: counterpart,
          connected_on: parseLinkedInTimestamp(row["Sent At"] ?? "") || undefined,
          evidence_kind: outgoing ? "linkedin.invitation-sent" : "linkedin.invitation-received",
          note: row.Message || undefined,
        });
        count += 1;
      }
      notes.push(`${count} invitations (with your own message where you sent one)`);
    }
  }

  if (!options.skipMessages) {
    const messagesCsv = readMaybeZipped(path, "messages.csv");
    if (messagesCsv) {
      const rows = parseCsv(messagesCsv);
      const headerIndex = findHeader(rows, "conversation id");
      if (headerIndex >= 0) {
        for (const row of toObjects(rows, headerIndex)) {
          const at = parseLinkedInTimestamp(row.DATE ?? "");
          const text = row.CONTENT ?? "";
          if (!at || !text) continue;
          const recipients = (row["RECIPIENT PROFILE URLS"] ?? "").split(/[,\s]+/).filter(Boolean);
          messages.push({
            conversation_id: row["CONVERSATION ID"] ?? "thread",
            from_handle: row["SENDER PROFILE URL"] || undefined,
            to_handle: recipients[0],
            from_name: row.FROM || undefined,
            at,
            text,
          });
        }

        // A limit keeps the *most recent* conversation, not the first page of
        // whatever order the export happened to use.
        const total = messages.length;
        if (options.messageLimit && total > options.messageLimit) {
          messages.sort((a, b) => b.at.localeCompare(a.at));
          messages.splice(options.messageLimit);
          notes.push(`${messages.length} most recent direct messages (of ${total})`);
        } else {
          notes.push(`${total} direct messages`);
        }
      }
    }
  }

  // Profile.csv tells us the user's own name and headline; the self handle comes
  // from the invitations (who sent them).
  const profileCsv = readMaybeZipped(path, "Profile.csv");
  if (profileCsv) {
    const rows = parseCsv(profileCsv);
    const headerIndex = findHeader(rows, "first name");
    if (headerIndex >= 0) {
      const profile = toObjects(rows, headerIndex)[0];
      if (profile) notes.push(`profile: ${[profile["First Name"], profile["Last Name"]].filter(Boolean).join(" ")} — ${profile.Headline ?? ""}`);
    }
  }

  return {
    source: "linkedin",
    label: "LinkedIn",
    exported_at: exportDateFromPath(path),
    self_handles: [...selfHandles],
    people,
    messages,
    notes,
  };
}

function exportDateFromPath(path: string): string | undefined {
  const match = basename(path).match(/(\d{2})-(\d{2})-(\d{4})/);
  return match ? `${match[3]}-${match[1]}-${match[2]}` : undefined;
}

// ---------------------------------------------------------------------------
// Instagram
// ---------------------------------------------------------------------------

interface IgEntry {
  string_list_data?: Array<{ href?: string; value?: string; timestamp?: number }>;
  title?: string;
}

function igRows(raw: string | null): IgEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed as IgEntry[];
    const following = (parsed as { relationships_following?: IgEntry[] }).relationships_following;
    return Array.isArray(following) ? following : [];
  } catch {
    return [];
  }
}

export function parseInstagramExport(path: string): SocialExport {
  const notes: string[] = [];
  const people: ImportPerson[] = [];
  const selfHandles = new Set<string>();

  const followersRaw = readMaybeZipped(path, "followers_1.json") ?? readMaybeZipped(path, "followers.json");
  const followingRaw = readMaybeZipped(path, "following.json");

  for (const entry of igRows(followersRaw)) {
    const data = entry.string_list_data?.[0];
    const handle = data?.value ?? entry.title ?? "";
    if (!handle) continue;
    people.push({
      instagram: handle,
      name: handle,
      connected_on: data?.timestamp ? new Date(data.timestamp * 1000).toISOString().slice(0, 10) : undefined,
      evidence_kind: "instagram.follows-you",
    });
  }
  if (people.length) notes.push(`${people.length} followers`);

  const following = igRows(followingRaw);
  for (const entry of following) {
    const data = entry.string_list_data?.[0];
    const handle = data?.value ?? entry.title ?? "";
    if (!handle) continue;
    people.push({
      instagram: handle,
      name: handle,
      connected_on: data?.timestamp ? new Date(data.timestamp * 1000).toISOString().slice(0, 10) : undefined,
      evidence_kind: "instagram.you-follow",
    });
  }
  if (following.length) notes.push(`${following.length} accounts you follow`);

  const personal = readMaybeZipped(path, "personal_information.json");
  if (personal) {
    try {
      const parsed = JSON.parse(personal) as { profile_user?: Array<{ string_map_data?: Record<string, { value?: string }> }> };
      const username = parsed.profile_user?.[0]?.string_map_data?.Username?.value;
      if (username) {
        selfHandles.add(username);
        notes.push(`your account: @${username}`);
      }
    } catch {
      /* ignore */
    }
  }

  return {
    source: "instagram",
    label: "Instagram",
    self_handles: [...selfHandles],
    people,
    messages: [],
    notes,
  };
}
