import { describe, expect, it, vi } from "vite-plus/test";
import type { PrismaService } from "../database/prisma.service";
import { associationDefaultLocale } from "./default-locale";

function prismaReading(
  row: { defaultLocale: string } | null,
): [PrismaService, ReturnType<typeof vi.fn>] {
  const findUnique = vi.fn(() => Promise.resolve(row));
  return [
    { association: { findUnique } } as unknown as PrismaService,
    findUnique,
  ];
}

describe("associationDefaultLocale", () => {
  it("reads the language the association chose from its own row", async () => {
    const [prisma, findUnique] = prismaReading({ defaultLocale: "en" });

    await expect(associationDefaultLocale(prisma)).resolves.toBe("en");
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 1 },
      select: { defaultLocale: true },
    });
  });

  it("falls back to Swedish before there is an association row", async () => {
    const [prisma] = prismaReading(null);

    await expect(associationDefaultLocale(prisma)).resolves.toBe("sv");
  });
});
