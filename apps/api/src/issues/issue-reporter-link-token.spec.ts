import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  hasReporterLinkTokenForm,
  mintReporterLinkToken,
  REPORTER_LINK_TOKEN_PREFIX,
  reporterLinkDigest,
} from "./issue-reporter-link-token";

/** A1 and A3 of the link's threat review (ADR 0055). */
describe("a reporter's link token", () => {
  it("is 32 random bytes in base64url behind the reporter's prefix", () => {
    const tokens = new Set<string>();
    for (let n = 0; n < 50; n += 1) {
      const token = mintReporterLinkToken();
      expect(token.startsWith(REPORTER_LINK_TOKEN_PREFIX)).toBe(true);
      expect(
        Buffer.from(
          token.slice(REPORTER_LINK_TOKEN_PREFIX.length),
          "base64url",
        ),
      ).toHaveLength(32);
      expect(hasReporterLinkTokenForm(token)).toBe(true);
      tokens.add(token);
    }
    expect(tokens.size).toBe(50);
  });

  it("is minted by the operating system's generator and by nothing else", () => {
    const source = (file: string) =>
      readFileSync(join(process.cwd(), "src", "issues", file), "utf8");
    expect(source("link-token.ts")).toContain("randomBytes(LINK_TOKEN_BYTES)");
    expect(source("issue-reporter-link-token.ts")).toContain(
      "mintLinkToken(REPORTER_LINK_TOKEN_PREFIX)",
    );
    const service = source("issue-reporter-link.service.ts");
    expect(service).toContain("mintReporterLinkToken()");
    for (const other of [/randomUUID/, /Math\.random/, /\bcuid\(/, /nanoid/]) {
      expect(service).not.toMatch(other);
    }
  });

  it("refuses every value that is not a token's form", () => {
    const token = mintReporterLinkToken();
    for (const value of [
      "",
      REPORTER_LINK_TOKEN_PREFIX,
      token.slice(0, -1),
      `${token}A`,
      ` ${token}`,
      `${token}\n`,
      token.replace("obrf_rl_", "obrf_dt_"),
      token.replace(/.$/, "+"),
      token.replace(/.$/, "="),
      token.replace(/.$/, "/"),
    ]) {
      expect(hasReporterLinkTokenForm(value)).toBe(false);
    }
  });

  it("is stored as its SHA-256 digest, which cannot be taken for a token", () => {
    const token = mintReporterLinkToken();
    const digest = reporterLinkDigest(token);
    expect(digest).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hasReporterLinkTokenForm(digest)).toBe(false);
    expect(reporterLinkDigest(token)).toBe(digest);
  });
});
