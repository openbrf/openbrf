import { describe, expect, it, vi } from "vite-plus/test";

import type { AuditLogService } from "../audit/audit-log.service";
import type { PrismaService } from "../database/prisma.service";
import type { I18nService } from "../i18n/i18n.service";
import { IssueTypeService } from "./issue-type.service";

/**
 * The set of issue types a new instance starts with (ADR 0054), over a fake
 * database: what is written, and that nothing is written to an instance that
 * already has a type.
 */

function build(existingTypes: number) {
  const created: unknown[] = [];
  const tx = {
    $executeRaw: vi.fn(async () => 0),
    issueType: {
      count: vi.fn(async () => existingTypes),
      create: vi.fn(async (args: { data: unknown }) => {
        created.push(args.data);
        return {};
      }),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) =>
      work(tx),
    ),
  } as unknown as PrismaService;
  const service = new IssueTypeService(
    prisma,
    {} as I18nService,
    {} as AuditLogService,
  );
  return { service, tx, created };
}

/** A translator that answers with the key, so the test reads what was asked. */
const keys = ((key: string) => `[${key}]`) as never;

describe("the issue types a new instance starts with", () => {
  it("writes the set, each type with one default status of each meaning", async () => {
    const { service, tx, created } = build(0);

    const answer = await service.seedDefaultTypes(keys);

    expect(answer.created).toBe(created.length);
    // Under a lock of its own, so two completions cannot both find it empty.
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    const types = created as {
      name: string;
      reporters: string[];
      sortOrder: number;
      handledBy?: string;
      statuses: {
        create: { meaning: string; label: string; isDefault: boolean }[];
      };
    }[];
    expect(types[0]).toMatchObject({
      name: "[issues.seededTypes.waterLeak]",
      reporters: ["PUBLIC", "RESIDENTS"],
      sortOrder: 0,
    });
    expect(types.map((type) => type.sortOrder)).toEqual(
      types.map((_, index) => index),
    );
    for (const type of types) {
      expect(type.statuses.create).toEqual([
        { meaning: "NEW", label: "[issues.status.NEW]", isDefault: true },
        {
          meaning: "IN_PROGRESS",
          label: "[issues.status.IN_PROGRESS]",
          isDefault: true,
        },
        {
          meaning: "WAITING",
          label: "[issues.status.WAITING]",
          isDefault: true,
        },
        { meaning: "DONE", label: "[issues.status.DONE]", isDefault: true },
      ]);
    }
    // A water leak files at Akut (decision 11).
    expect(types[0]).toMatchObject({ defaultPriority: "URGENT" });
    // The one type kept for the handlers is the board's own, handled by the
    // board only (decision 13); every other type is offered to a reporter and
    // handled by every handler.
    const internal = types.filter((type) =>
      type.reporters.includes("HANDLERS"),
    );
    expect(internal).toEqual([
      expect.objectContaining({
        name: "[issues.seededTypes.insurance]",
        reporters: ["HANDLERS"],
        handledBy: "BOARD",
      }),
    ]);
    for (const type of types.filter((entry) => !internal.includes(entry))) {
      expect(type).not.toHaveProperty("handledBy");
    }
    // The website's form has something to offer from the first day.
    expect(types.some((type) => type.reporters.includes("PUBLIC"))).toBe(true);
  });

  it("writes nothing to an instance that has any type", async () => {
    const { service, created } = build(1);

    expect(await service.seedDefaultTypes(keys)).toEqual({ created: 0 });
    expect(created).toEqual([]);
  });
});
