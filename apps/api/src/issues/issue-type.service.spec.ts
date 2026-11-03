import { describe, expect, it, vi } from "vite-plus/test";

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
  const service = new IssueTypeService(prisma, {} as I18nService);
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
      // Never a type kept for the handlers: the board-only types come with
      // the change that holds a type to the board.
      expect(type.reporters).not.toContain("HANDLERS");
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
