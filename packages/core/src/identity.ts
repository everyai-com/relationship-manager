/**
 * Identity resolution — one human, many handles.
 *
 * The authoritative index is `person_identifiers` (kind + value). Everything an
 * agent or an importer supplies goes through these normalisers first, so the
 * same person never forks into two rows because one source wrote a "+" in front
 * of the number and another did not.
 */

export type IdentifierKind = "email" | "phone" | "wa_jid" | "fathom_attendee";

const ADDRESS_RE = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/;

/** Free/consumer domains never become a company signal. */
export const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
  "yahoo.com", "yahoo.in", "ymail.com", "icloud.com", "me.com", "mac.com", "aol.com",
  "proton.me", "protonmail.com", "pm.me", "zoho.com", "gmx.com", "gmx.net", "mail.com",
  "yandex.com", "hey.com", "fastmail.com", "rediffmail.com", "163.com", "qq.com",
]);

/** Software, not people. Conservative on purpose: a false person row is cheap, a dropped human is not. */
const ROBOT_HINTS = /no-?reply|notification|mailer|newsletter|billing@|receipts?@|support@|updates?@|hello@|info@|team@|bounce|invite@|calendar-notification/i;

export function parseAddress(raw: string): { name: string; email: string } {
  const value = (raw ?? "").trim();
  if (!value) return { name: "", email: "" };
  const m = value.match(ADDRESS_RE);
  if (m) return { name: (m[1] ?? "").trim().replace(/^["']|["']$/g, ""), email: normalizeEmail(m[2] ?? "") };
  return { name: "", email: normalizeEmail(value) };
}

/**
 * Pull the address out of whatever a mail source handed us. Real inboxes contain
 * `Name <a@b.com>`, `"Name" <a@b.com>`, a bare `a@b.com`, and — often enough to
 * matter — truncated forms like `Name <a@b.com` with no closing bracket. All of
 * them must resolve to the same human, or the graph forks.
 */
export function normalizeEmail(raw: string): string {
  const value = String(raw ?? "").trim();
  if (!value) return "";

  const angled = value.match(/<([^>\s]*@[^>\s]*)>?/);
  if (angled?.[1]) return angled[1].trim().toLowerCase();

  const tokens = value.split(/[\s,;<>"']+/).filter((token) => token.includes("@"));
  if (tokens.length > 0) return tokens[tokens.length - 1]!.trim().toLowerCase().replace(/[.,;:]$/, "");

  return value.toLowerCase().replace(/^mailto:/, "");
}

/** Digits only — matches how the WhatsApp side stores a number (`919900822910`). */
export function normalizePhone(raw: string): string {
  return (raw ?? "").replace(/[^\d]/g, "");
}

export interface DecodedJid {
  /** Who the chat is with. */
  jid: string;
  /** Digits, or null for a LID (privacy handle) that carries no phone number. */
  phone: string | null;
  isGroup: boolean;
  isLid: boolean;
}

/** `919900822910@c.us` and `…@s.whatsapp.net` are the same human; `@lid` has no phone. */
export function decodeJid(raw: string): DecodedJid | null {
  const value = (raw ?? "").trim();
  if (!value.includes("@")) return null;
  const [local = "", serverRaw = ""] = value.split("@");
  const server = serverRaw === "c.us" ? "s.whatsapp.net" : serverRaw;
  const isGroup = server === "g.us";
  const isLid = server === "lid";
  const digits = local.replace(/[^\d]/g, "");
  return {
    jid: `${local}@${server}`,
    phone: isGroup || isLid || !digits ? null : digits,
    isGroup,
    isLid,
  };
}

export function isRobotAddress(addr: string): boolean {
  const email = normalizeEmail(addr);
  if (!email) return false;
  return ROBOT_HINTS.test(email);
}

export function domainOf(email: string): string {
  const at = normalizeEmail(email).lastIndexOf("@");
  return at === -1 ? "" : normalizeEmail(email).slice(at + 1);
}

export function companyDomainOf(email: string): string {
  const d = domainOf(email);
  if (!d || FREE_EMAIL_DOMAINS.has(d)) return "";
  return d;
}

/** Loose name/handle comparison used for the weakest ("handle.name-form") evidence. */
export function nameFormMatches(name: string, handle: string): boolean {
  const clean = (s: string) => (s ?? "").toLowerCase().replace(/[^a-z]/g, "");
  const n = clean(name);
  const h = clean(handle);
  if (!n || !h) return false;
  return h.includes(n) || n.includes(h);
}

/** Title-cases a WhatsApp push-name that arrived as an email local part. */
export function titleFromHandle(handle: string): string {
  return (handle ?? "")
    .split(/[._\-+]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

export function identityKey(kind: IdentifierKind, value: string): string {
  switch (kind) {
    case "email":
      return `email:${normalizeEmail(value)}`;
    case "phone":
      return `phone:${normalizePhone(value)}`;
    case "wa_jid": {
      const d = decodeJid(value);
      return `wa_jid:${d ? d.jid : value.trim().toLowerCase()}`;
    }
    default:
      return `fathom_attendee:${(value ?? "").trim().toLowerCase()}`;
  }
}
