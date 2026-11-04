import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  hasWorkOrderLinkTokenForm,
  mintWorkOrderLinkToken,
  WORK_ORDER_LINK_TOKEN_PREFIX,
  workOrderLinkDigest,
} from "./work-order-link-token";
import {
  hasReporterLinkTokenForm,
  mintReporterLinkToken,
} from "./issue-reporter-link-token";

/** A1, A3 and A4 of the link's threat review (ADR 0055). */
describe("a contractor's link token", () => {
  it("is 32 random bytes in base64url behind the contractor's prefix", () => {
    const tokens = new Set<string>();
    for (let n = 0; n < 50; n += 1) {
      const token = mintWorkOrderLinkToken();
      expect(token.startsWith(WORK_ORDER_LINK_TOKEN_PREFIX)).toBe(true);
      expect(
        Buffer.from(
          token.slice(WORK_ORDER_LINK_TOKEN_PREFIX.length),
          "base64url",
        ),
      ).toHaveLength(32);
      expect(hasWorkOrderLinkTokenForm(token)).toBe(true);
      tokens.add(token);
    }
    expect(tokens.size).toBe(50);
  });

  it("is minted by the operating system's generator and by nothing else", () => {
    const source = (file: string) =>
      readFileSync(join(process.cwd(), "src", "issues", file), "utf8");
    expect(source("link-token.ts")).toContain("randomBytes(LINK_TOKEN_BYTES)");
    expect(source("work-order-link-token.ts")).toContain(
      "mintLinkToken(WORK_ORDER_LINK_TOKEN_PREFIX)",
    );
    const service = source("work-order-link.service.ts");
    expect(service).toContain("mintWorkOrderLinkToken()");
    for (const other of [/randomUUID/, /Math\.random/, /\bcuid\(/, /nanoid/]) {
      expect(service).not.toMatch(other);
    }
  });

  it("refuses every value that is not a token's form", () => {
    const token = mintWorkOrderLinkToken();
    for (const value of [
      "",
      WORK_ORDER_LINK_TOKEN_PREFIX,
      token.slice(0, -1),
      `${token}A`,
      ` ${token}`,
      `${token}\n`,
      token.replace("obrf_wo_", "obrf_rl_"),
      token.replace(/.$/, "+"),
      token.replace(/.$/, "="),
      token.replace(/.$/, "/"),
    ]) {
      expect(hasWorkOrderLinkTokenForm(value)).toBe(false);
    }
  });

  it("is stored as its SHA-256 digest, which cannot be taken for a token", () => {
    const token = mintWorkOrderLinkToken();
    const digest = workOrderLinkDigest(token);
    expect(digest).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hasWorkOrderLinkTokenForm(digest)).toBe(false);
    expect(workOrderLinkDigest(token)).toBe(digest);
    // A known SHA-256 vector, and a different token gives a different digest.
    expect(workOrderLinkDigest("openbrf")).toBe(
      "Dw2IjKhXMqZmAQPb-7sHzcTMAl5w-M6-vjgoiaP5WP8",
    );
    expect(workOrderLinkDigest(mintWorkOrderLinkToken())).not.toBe(digest);
  });

  it("A4: has the form of no reporter's token, and a reporter's has not its form", () => {
    expect(hasReporterLinkTokenForm(mintWorkOrderLinkToken())).toBe(false);
    expect(hasWorkOrderLinkTokenForm(mintReporterLinkToken())).toBe(false);
  });
});
