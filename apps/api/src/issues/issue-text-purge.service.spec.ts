import { Logger } from "@nestjs/common";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import type { Env } from "../config/env";
import type { FieldEncryptionService } from "../crypto/field-encryption.service";
import type { PrismaService } from "../database/prisma.service";
import type { JobQueueService } from "../jobs/job-queue.service";
import type { IssueFreeTextService } from "./issue-free-text.service";
import { IssueTextPurgeService } from "./issue-text-purge.service";

/**
 * How far one night's run of the issue text purge goes, over a scan and a
 * removal of the test's own: it stops at 500 removals, and at 1000 attempts
 * whatever became of them, so a backlog that fails throughout cannot keep the
 * run going to its end.
 */

const NOW = new Date("2026-11-04T03:21:00Z");

/**
 * A scan that never runs dry, in pages of 500 issues whose ids say which page
 * they came from, and a removal that does what `outcome` says.
 */
function build(outcome: (id: string) => "removed" | "fail") {
  const service = new IssueTextPurgeService(
    { NODE_ENV: "test" } as Env,
    {} as PrismaService,
    {} as FieldEncryptionService,
    {} as IssueFreeTextService,
    {} as JobQueueService,
  );
  let page = 0;
  const eligiblePage = vi
    .spyOn(service, "eligiblePage")
    .mockImplementation(async () => {
      page += 1;
      return Array.from({ length: 500 }, (_, index) => ({
        id: `p${String(page)}-${String(index)}`,
        closedAt: new Date(NOW.getTime() - (10_000 - page) * 86_400_000),
      }));
    });
  const purgeIssue = vi
    .spyOn(service, "purgeIssue")
    .mockImplementation(async (id: string) => {
      if (outcome(id) === "fail") {
        throw new Error("storage refused");
      }
      return "removed";
    });
  return { service, eligiblePage, purgeIssue };
}

describe("one run of the issue text purge", () => {
  // A thousand failures logged one by one would bury the test's own output.
  beforeEach(() => {
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stops at 500 removals", async () => {
    const { service, purgeIssue } = build(() => "removed");

    const summary = await service.run(NOW, 2);

    expect(summary).toEqual({ considered: 500, purged: 500, failed: 0 });
    expect(purgeIssue).toHaveBeenCalledTimes(500);
  });

  it("stops at 1000 attempts when every removal fails", async () => {
    const { service, eligiblePage, purgeIssue } = build(() => "fail");
    const error = vi
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);

    const summary = await service.run(NOW, 2);

    expect(summary).toEqual({ considered: 1000, purged: 0, failed: 1000 });
    expect(purgeIssue).toHaveBeenCalledTimes(1000);
    // Two pages read, and no third: the bound ends the scan, not a page that
    // came back empty.
    expect(eligiblePage).toHaveBeenCalledTimes(2);
    // The run says that the issues behind the failures wait, as an error.
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("issues behind the ones that did not succeed"),
    );
    error.mockRestore();
  });

  it("reads past failing old issues to newer ones", async () => {
    const { service } = build((id) =>
      id.startsWith("p1-") ? "fail" : "removed",
    );

    const summary = await service.run(NOW, 2);

    expect(summary).toEqual({ considered: 1000, purged: 500, failed: 500 });
  });
});
