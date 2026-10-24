import { MAX_WITHHELD_IDS } from "@openbrf/shared";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  capabilitiesFor,
  type PrincipalRoles,
} from "../authorization/capabilities";
import { CLOSED_TO_SUPPORT } from "../authorization/closed-to-support.decorator";
import { REQUIRED_CAPABILITIES } from "../authorization/require-capability.decorator";
import type { PrismaService } from "../database/prisma.service";
import { HOUSE_NEWS } from "../news/news-audience";
import type {
  CheckedItem,
  RegisterCheckService,
} from "./register-check.service";
import {
  WithheldBookableResourcesController,
  WithheldEventsController,
  WithheldMeetingsController,
  WithheldNewsController,
} from "./withheld-from-devices.controller";
import {
  WithheldFromDevicesService,
  withheldIdsSchema,
} from "./withheld-from-devices.service";

/**
 * The mark the board's editors show (ADR 0032): which items the register
 * check withholds from devices, to whom, and with which words.
 */

function serviceOver(rows: Record<string, unknown[]>) {
  const findMany = (table: string) => vi.fn(async () => rows[table] ?? []);
  const prisma = {
    news: { findMany: findMany("news") },
    event: { findMany: findMany("event") },
    meeting: { findMany: findMany("meeting") },
    bookableResource: { findMany: findMany("bookableResource") },
  } as unknown as PrismaService;
  // Withholds whatever mentions Svensson, and Hemligsson without showing it.
  const matches = vi.fn(async (items: readonly CheckedItem[]) =>
    items.map((item) =>
      item.flatMap((text) => [
        ...(text?.includes("Svensson")
          ? [{ words: "Svensson", protectedOnly: false }]
          : []),
        ...(text?.includes("Hemligsson")
          ? [{ words: "Hemligsson", protectedOnly: true }]
          : []),
      ]),
    ),
  );
  const check = { matches } as unknown as RegisterCheckService;
  return {
    service: new WithheldFromDevicesService(prisma, check),
    prisma,
    matches,
  };
}

describe("WithheldFromDevicesService", () => {
  it("answers the withheld news items, checking their prose as a device's read does", async () => {
    const { service, matches } = serviceOver({
      news: [
        { id: "a", title: "Städdag", content: { version: 1, blocks: [] } },
        {
          id: "b",
          title: "Tack",
          content: {
            version: 1,
            blocks: [
              { type: "heading", level: 2, runs: [{ text: "Hej" }] },
              { type: "paragraph", runs: [{ text: "Tack, Svensson!" }] },
            ],
          },
        },
      ],
    });

    await expect(service.news(["a", "b"])).resolves.toEqual([
      {
        id: "b",
        withheldFromDevices: { words: ["Svensson"], unshownWords: false },
      },
    ]);
    expect(matches.mock.calls[0]?.[0]).toEqual([
      ["Städdag"],
      ["Tack", "Hej", "Tack, Svensson!"],
    ]);
  });

  it("asks only for the house's news, so a confined item is not looked up", async () => {
    const findMany = vi.fn(async (_args: { where: unknown }) => []);
    const { service } = serviceOver({});
    const prisma = (service as unknown as { prisma: { news: unknown } }).prisma;
    prisma.news = { findMany };

    await service.news(["house", "board"]);

    // That the filter hides a confined item is held on the database, in
    // withheld-from-devices.int-spec.ts.
    expect(findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: { in: ["house", "board"] }, ...HOUSE_NEWS },
    });
  });

  it("checks an event's four strings and a meeting's notice and agenda", async () => {
    const { service } = serviceOver({
      event: [
        {
          id: "e",
          title: "Grill",
          description: null,
          category: null,
          location: "Hos Hemligsson",
        },
      ],
      meeting: [
        {
          id: "m",
          agendaItems: [{ title: "Svenssons motion" }],
          notice: null,
        },
      ],
    });

    await expect(service.events(["e"])).resolves.toEqual([
      {
        id: "e",
        withheldFromDevices: { words: [], unshownWords: true },
      },
    ]);
    await expect(service.meetings(["m"])).resolves.toMatchObject([
      { id: "m", withheldFromDevices: { words: ["Svensson"] } },
    ]);
  });

  it("reads nothing for an editor that asked about no item", async () => {
    const { service, matches } = serviceOver({});

    await expect(service.bookableResources([])).resolves.toEqual([]);
    expect(matches).not.toHaveBeenCalled();
  });
});

describe("withheldIdsSchema", () => {
  it("reads a comma-separated list, each id once", () => {
    expect(withheldIdsSchema.parse("a,b,a")).toEqual(["a", "b"]);
    expect(withheldIdsSchema.parse(undefined)).toEqual([]);
    expect(withheldIdsSchema.parse("")).toEqual([]);
  });

  it.each([
    ["free text", "Anna Svensson"],
    ["an empty id", "a,,b"],
    [
      "too many ids",
      Array.from({ length: MAX_WITHHELD_IDS + 1 }, (_, index) =>
        String(index),
      ).join(","),
    ],
  ])("refuses %s", (_what, ids) => {
    expect(() => withheldIdsSchema.parse(ids)).toThrow();
  });
});

describe("the editors' routes", () => {
  it.each([
    [WithheldNewsController, "site:manage"],
    [WithheldEventsController, "events:manage"],
    [WithheldMeetingsController, "meetings:manage"],
    [WithheldBookableResourcesController, "bookings:configure"],
  ] as const)(
    "%o answers the editor's own capability, and no support session",
    (controller, capability) => {
      expect(Reflect.getMetadata(REQUIRED_CAPABILITIES, controller)).toEqual([
        capability,
      ]);
      expect(Reflect.getMetadata(CLOSED_TO_SUPPORT, controller)).toBe(true);
    },
  );

  /*
   * A route answers whether a word is the name of a person with protected
   * personal data. That tells its caller nothing while every editor may read
   * the address book, which shows those names and tests an email address or a
   * phone number against the register as well. A role that may edit one of
   * these without reading the address book would make the route a register
   * oracle: gate it on `addressBook:read` too before granting such a role.
   */
  it("are open only to roles that may read the address book", () => {
    const flags = [
      "isAdmin",
      "isBoardMember",
      "isPropertyManager",
      "isResident",
      "isMember",
    ] as const;
    const editors = [
      "site:manage",
      "events:manage",
      "meetings:manage",
      "bookings:configure",
    ] as const;
    for (let mask = 0; mask < 2 ** flags.length; mask += 1) {
      const roles = Object.fromEntries(
        flags.map((flag, bit) => [flag, (mask & (1 << bit)) !== 0]),
      ) as unknown as PrincipalRoles;
      const granted = capabilitiesFor(roles);
      if (editors.some((capability) => granted.has(capability))) {
        expect(granted.has("addressBook:read"), JSON.stringify(roles)).toBe(
          true,
        );
      }
    }
  });
});
