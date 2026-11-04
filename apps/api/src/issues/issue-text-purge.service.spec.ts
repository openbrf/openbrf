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
function build(
  outcome: (id: string) => "removed" | "kept" | "fail" | "unfinished",
) {
  const service = new IssueTextPurgeService(
    { NODE_ENV: "test" } as Env,
    {} as PrismaService,
    {} as FieldEncryptionService,
    {} as IssueFreeTextService,
    {} as JobQueueService,
  );
  const eligiblePage = vi
    .spyOn(service, "eligiblePage")
    .mockImplementation(async (_now, _years, after) => {
      // The first page has no cursor; each later one follows the last row of
      // the page before it, so a run that drops its cursor is read as page 1
      // again.
      const page =
        after === undefined ? 1 : Number(/^p(\d+)-/.exec(after.id)?.[1]) + 1;
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
      const result = outcome(id);
      return result === "kept" || result === "unfinished" ? result : "removed";
    });
  return { service, eligiblePage, purgeIssue };
}

describe("one run of the issue text purge", () => {
  // A thousand failures logged one by one would bury the test's own output.
  let logged: ReturnType<typeof vi.spyOn>;
  let logLevel: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logged = vi
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);
    logLevel = vi
      .spyOn(Logger.prototype, "log")
      .mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stops at 500 removals", async () => {
    const { service, purgeIssue } = build(() => "removed");

    const summary = await service.run(NOW, 2);

    expect(summary).toEqual({ considered: 500, purged: 500, failed: 0 });
    expect(purgeIssue).toHaveBeenCalledTimes(500);
    // A run that reached its removals was not held back by failures: it says
    // so at the log level and raises no error.
    expect(logged).not.toHaveBeenCalled();
    expect(logLevel).toHaveBeenCalledWith(
      expect.stringContaining("per-run bound of 500 removals"),
    );
  });

  it("stops at 1000 attempts when every removal fails", async () => {
    const { service, eligiblePage, purgeIssue } = build(() => "fail");

    const summary = await service.run(NOW, 2);

    expect(summary).toEqual({ considered: 1000, purged: 0, failed: 1000 });
    expect(purgeIssue).toHaveBeenCalledTimes(1000);
    // Two pages read, and no third: the bound ends the scan, not a page that
    // came back empty.
    expect(eligiblePage).toHaveBeenCalledTimes(2);
    // The run says that the issues behind the failures wait, as an error.
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining(
        "1000 of which removed nothing (1000 failed removals, 0 unfinished issues, the rest kept)",
      ),
    );
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining("issues behind the ones that did not succeed"),
    );
  });

  it("counts only the attempts that removed nothing when some removals succeed", async () => {
    const { service } = build((id) => (id === "p1-0" ? "removed" : "fail"));

    const summary = await service.run(NOW, 2);

    // One removal succeeded, so the figure is the attempts less that one,
    // not the attempts as a whole.
    expect(summary).toEqual({ considered: 1000, purged: 1, failed: 999 });
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining(
        "999 of which removed nothing (999 failed removals, 0 unfinished issues, the rest kept)",
      ),
    );
  });

  it("reads past failing old issues to newer ones", async () => {
    const { service, eligiblePage } = build((id) =>
      id.startsWith("p1-") ? "fail" : "removed",
    );

    const summary = await service.run(NOW, 2);

    expect(summary).toEqual({ considered: 1000, purged: 500, failed: 500 });
    expect(eligiblePage.mock.calls[1]?.[2]).toEqual({
      closedAt: expect.any(Date),
      id: "p1-499",
    });
  });

  it("stops inside a page once 500 removals are reached", async () => {
    const { service, purgeIssue } = build((id) =>
      id === "p1-0" ? "fail" : "removed",
    );

    const summary = await service.run(NOW, 2);

    // Page 1 gives 499 removals and one failure; the 500th removal is the
    // first issue of page 2, and the other 499 on that page are not taken.
    expect(summary).toEqual({ considered: 501, purged: 500, failed: 1 });
    expect(purgeIssue).toHaveBeenCalledTimes(501);
  });

  it("counts issues that stay unfinished in the error at the bound", async () => {
    const { service } = build(() => "unfinished");

    const summary = await service.run(NOW, 2);

    // An unfinished issue is neither a removal nor a throw, and it stays due,
    // so a run of them ends on the attempt bound and says how many it met.
    expect(summary).toEqual({ considered: 1000, purged: 0, failed: 0 });
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining(
        "1000 of which removed nothing (0 failed removals, 1000 unfinished issues, the rest kept)",
      ),
    );
  });

  it("leaves kept issues out of the unfinished count", async () => {
    const { service } = build(() => "kept");

    const summary = await service.run(NOW, 2);

    // A kept issue (a hold or a restriction stands) is neither removed nor
    // unfinished, so a run of them ends on the attempt bound and counts none.
    expect(summary).toEqual({ considered: 1000, purged: 0, failed: 0 });
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining(
        "1000 of which removed nothing (0 failed removals, 0 unfinished issues, the rest kept)",
      ),
    );
  });
});
