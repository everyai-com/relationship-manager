import { describe, expect, it } from "vitest";
import {
  companyDomainOf,
  decodeJid,
  identityKey,
  isRobotAddress,
  normalizeEmail,
  normalizePhone,
  parseAddress,
  titleFromHandle,
} from "./identity";

describe("normalizeEmail", () => {
  it("handles the forms a real inbox produces", () => {
    expect(normalizeEmail("david.rice@lucidway.ai")).toBe("david.rice@lucidway.ai");
    expect(normalizeEmail("David Rice <david.rice@lucidway.ai>")).toBe("david.rice@lucidway.ai");
    expect(normalizeEmail('"Rice, David" <David.Rice@LucidWay.ai>')).toBe("david.rice@lucidway.ai");
    expect(normalizeEmail("  DAVID@X.COM  ")).toBe("david@x.com");
  });

  it("rescues a truncated display-name form instead of forking the person", () => {
    // Seen in production: a missing closing bracket made a second David Rice.
    expect(normalizeEmail("david rice <david.rice@lucidway.ai")).toBe("david.rice@lucidway.ai");
    expect(normalizeEmail("david rice david.rice@lucidway.ai")).toBe("david.rice@lucidway.ai");
  });

  it("keeps the last address when a header carries several", () => {
    expect(normalizeEmail("a@x.com, b@y.com")).toBe("b@y.com");
  });
});

describe("parseAddress", () => {
  it("splits a display name from the address", () => {
    expect(parseAddress("Pat @ Starter Story <pat@starterstory.com>")).toEqual({
      name: "Pat @ Starter Story",
      email: "pat@starterstory.com",
    });
  });
});

describe("normalizePhone and decodeJid", () => {
  it("keeps digits only", () => {
    expect(normalizePhone("+91 99008 22910")).toBe("919900822910");
  });

  it("treats @c.us and @s.whatsapp.net as the same human", () => {
    expect(decodeJid("919900822910@c.us")?.jid).toBe("919900822910@s.whatsapp.net");
    expect(decodeJid("919900822910@s.whatsapp.net")?.phone).toBe("919900822910");
  });

  it("knows a LID carries no phone number", () => {
    const lid = decodeJid("200325998891024@lid");
    expect(lid?.isLid).toBe(true);
    expect(lid?.phone).toBeNull();
  });

  it("flags groups", () => {
    expect(decodeJid("120363000000000000@g.us")?.isGroup).toBe(true);
  });
});

describe("identityKey", () => {
  it("collapses the same human across identifier kinds", () => {
    expect(identityKey("phone", "+91 99008 22910")).toBe("phone:919900822910");
    expect(identityKey("wa_jid", "919900822910@c.us")).toBe("wa_jid:919900822910@s.whatsapp.net");
  });
});

describe("companyDomainOf", () => {
  it("refuses to call a consumer mailbox a company", () => {
    expect(companyDomainOf("someone@gmail.com")).toBe("");
    expect(companyDomainOf("david.rice@lucidway.ai")).toBe("lucidway.ai");
  });
});

describe("isRobotAddress", () => {
  it("keeps software out of the graph", () => {
    expect(isRobotAddress("no-reply@github.com")).toBe(true);
    expect(isRobotAddress("notifications@x.com")).toBe(true);
    expect(isRobotAddress("david.rice@lucidway.ai")).toBe(false);
  });
});

describe("titleFromHandle", () => {
  it("makes a readable name from a handle", () => {
    expect(titleFromHandle("david.rice")).toBe("David Rice");
  });
});
