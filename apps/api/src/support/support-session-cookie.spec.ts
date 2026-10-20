import { describe, expect, it } from "vite-plus/test";

import { SupportSessionCookie } from "./support-session-cookie";

describe("the support session's cookie", () => {
  it("is __Host- prefixed and Secure on an instance served over https", () => {
    const cookie = new SupportSessionCookie("https://brf.example");

    expect(cookie.name).toBe("__Host-openbrf-support");
    expect(cookie.set("abc", new Date("2026-10-20T20:00:00.000Z"))).toBe(
      "__Host-openbrf-support=abc; Path=/; Expires=Tue, 20 Oct 2026 20:00:00 GMT; HttpOnly; SameSite=Strict; Secure",
    );
    expect(cookie.clear()).toBe(
      "__Host-openbrf-support=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict; Secure",
    );
  });

  it("is neither on an instance served over http, which no browser would keep", () => {
    const cookie = new SupportSessionCookie("http://localhost:3000");

    expect(cookie.name).toBe("openbrf-support");
    expect(cookie.clear()).not.toContain("Secure");
  });

  it.each([
    ["no Cookie header", undefined, { kind: "none" }],
    ["other cookies only", "a=1; b=2", { kind: "none" }],
    [
      "the cookie among others",
      "a=1; __Host-openbrf-support=tok; b=2",
      { kind: "token", token: "tok" },
    ],
    [
      "the cookie twice",
      "__Host-openbrf-support=one; __Host-openbrf-support=two",
      { kind: "unreadable" },
    ],
    ["an empty value", "__Host-openbrf-support=", { kind: "unreadable" }],
    [
      "a name that merely ends the same",
      "x__Host-openbrf-support=tok",
      { kind: "none" },
    ],
  ] as const)("reads %s", (_what, header, expected) => {
    const cookie = new SupportSessionCookie("https://brf.example");

    expect(cookie.presented(header)).toEqual(expected);
  });
});
