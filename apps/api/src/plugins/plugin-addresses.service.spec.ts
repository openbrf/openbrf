import { describe, expect, it, vi } from "vite-plus/test";

import type { PrismaService } from "../database/prisma.service";
import { PluginAddressesService } from "./plugin-addresses.service";

/**
 * What addresses:read releases: the street and the number of each entrance,
 * and nothing about who lives at it (ADR 0032).
 */

function serviceReading(rows: unknown[]) {
  const findMany = vi.fn(async (_query: unknown) => rows);
  const prisma = { address: { findMany } } as unknown as PrismaService;
  return { service: new PluginAddressesService(prisma), findMany };
}

describe("list", () => {
  it("reads the id, the street and the number, and nothing else", async () => {
    const rows = [{ id: "address-1", street: "Storgatan", number: "12 B" }];
    const { service, findMany } = serviceReading(rows);

    await expect(service.list()).resolves.toEqual(rows);

    const query = findMany.mock.calls[0]?.[0] as {
      select: Record<string, unknown>;
      where?: unknown;
    };
    // The select is the boundary: no apartment, and so nobody living in one.
    expect(query.select).toEqual({ id: true, street: true, number: true });
    expect(query.where).toBeUndefined();
  });

  it("keeps the order of the address book's house tabs", async () => {
    const { service, findMany } = serviceReading([]);

    await service.list();

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ sortOrder: "asc" }, { street: "asc" }, { number: "asc" }],
      }),
    );
  });
});
