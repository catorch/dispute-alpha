import { describe, expect, it } from "vitest";
import { ROLE_PERMISSIONS } from "@da/shared";
import { unauthorizedTarget } from "./api";
import {
  compareKey,
  formatSsnInput,
  groupBy,
  humanize,
  inAppPath,
  issuesToMap,
  letterActions,
  letterPathIndex,
  renderLetterHtml,
  reportStepIndex,
  todayIso,
} from "./format";

describe("formatSsnInput", () => {
  it("formats progressively and drops non-digits", () => {
    expect(formatSsnInput("12")).toBe("12");
    expect(formatSsnInput("1234")).toBe("123-4");
    expect(formatSsnInput("123456")).toBe("123-45-6");
    expect(formatSsnInput("123-45-6789")).toBe("123-45-6789");
    expect(formatSsnInput("12a3 45 67890")).toBe("123-45-6789");
  });
});

describe("status helpers", () => {
  it("humanizes enum values", () => expect(humanize("pending_approval")).toBe("Pending approval"));
  it("maps report steps", () => {
    expect(reportStepIndex("requested")).toBe(0);
    expect(reportStepIndex("complete")).toBe(4);
    expect(reportStepIndex("failed")).toBe(-1);
  });
  it("places side states on the letter path", () => {
    expect(letterPathIndex("render_failed")).toBe(letterPathIndex("rendering"));
    expect(letterPathIndex("overdue")).toBe(letterPathIndex("sent"));
  });
  it("offers letter actions by status and permission", () => {
    expect(letterActions("draft", ROLE_PERMISSIONS.staff)).toEqual(["edit", "submit"]);
    expect(letterActions("pending_approval", ROLE_PERMISSIONS.staff)).toEqual([]);
    expect(letterActions("pending_approval", ROLE_PERMISSIONS.approver)).toEqual(["approve", "reject"]);
    expect(letterActions("overdue", ROLE_PERMISSIONS.staff)).toEqual(["logResponse"]);
    expect(letterActions("sent", [])).toEqual([]);
  });
});

describe("grouping", () => {
  it("groups preserving order", () => {
    const m = groupBy([1, 2, 3, 4], (n) => n % 2);
    expect([...m.entries()]).toEqual([[1, [1, 3]], [0, [2, 4]]]);
  });
  it("matches the same account across bureaus", () => {
    const a = compareKey({ furnisher: "Capital One, N.A.", accountMask: "****1234", itemType: "tradeline" });
    const b = compareKey({ furnisher: "CAPITAL ONE NA", accountMask: "****1234", itemType: "tradeline" });
    expect(a).toBe(b);
    expect(compareKey({ furnisher: "Capital One", accountMask: "****9999", itemType: "tradeline" })).not.toBe(a);
  });
});

describe("misc", () => {
  it("maps issues to fields", () => {
    expect(issuesToMap([{ path: ["address", "zip"], message: "bad" }, { path: "email", message: "x" }, { path: ["email"], message: "y" }])).toEqual({ "address.zip": "bad", email: "x" });
    expect(issuesToMap(undefined)).toEqual({});
  });
  it("replaces deferred DOB tokens", () => {
    expect(renderLetterHtml("<p>DOB: {{ client.dob }}</p>")).toContain("DOB inserted at print");
    expect(renderLetterHtml("<p>{{client.first_name}}</p>")).toBe("<p>{{client.first_name}}</p>");
  });
  it("formats local dates", () => expect(todayIso(new Date(2026, 0, 5))).toBe("2026-01-05"));
  it("keeps only same-origin notification links", () => {
    expect(inAppPath("https://app.example.com/admin/letters/1", "https://app.example.com")).toBe("/admin/letters/1");
    expect(inAppPath("https://evil.example/x", "https://app.example.com")).toBeNull();
  });
  it("routes 401s by area", () => {
    expect(unauthorizedTarget("/auth/client/login", "invalid_credentials")).toBeNull();
    expect(unauthorizedTarget("/portal/me", "session_expired")).toBe("/login");
    expect(unauthorizedTarget("/clients", "session_expired")).toBe("/cdn-cgi/access/logout");
    expect(unauthorizedTarget("/clients", "other")).toBeNull();
  });
});
