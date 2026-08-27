import { describe, expect, it, vi } from "vitest";

import type { PrismaService } from "../database/prisma.service";
import { AddressService } from "./address.service";

/**
 * Addresses and apartments over a fake database.
 *
 * The interesting behaviour is what this service REFUSES. An apartment is what
 * the member register and the apartment register hang off, so a delete that
 * cascaded into either would be an attempt to erase a record the law requires
 * the cooperative to keep (EFL 5 kap. via BRL 9 kap.).
 */

const ADDRESS = {
  id: "address-1",
  street: "Storgatan",
  number: "12",
  postalCode: "123 45",
  city: "Stockholm",
  sortOrder: 0,
  _count: { apartments: 0 },
};

interface Counts {
  residencies?: number;
  memberRegisterEntries?: number;
  transfers?: number;
  lienNotes?: number;
}

function build(
  options: {
    address?: (typeof ADDRESS & { _count: { apartments: number } }) | null;
    createdCount?: number;
    apartment?: { id: string; number: string; counts?: Counts } | null;
  } = {},
) {
  const address =
    options.address === undefined ? { ...ADDRESS } : options.address;

  const prisma = {
    address: {
      findMany: vi.fn().mockResolvedValue(address === null ? [] : [address]),
      findFirst: vi.fn().mockResolvedValue({ sortOrder: 2 }),
      findUnique: vi.fn().mockResolvedValue(address),
      createMany: vi
        .fn()
        .mockResolvedValue({ count: options.createdCount ?? 1 }),
      update: vi.fn().mockResolvedValue(address),
      delete: vi.fn().mockResolvedValue(address),
    },
    apartment: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(
        options.apartment == null
          ? null
          : {
              id: options.apartment.id,
              number: options.apartment.number,
              _count: {
                residencies: 0,
                memberRegisterEntries: 0,
                transfers: 0,
                lienNotes: 0,
                ...options.apartment.counts,
              },
            },
      ),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      delete: vi.fn().mockResolvedValue({ id: "apartment-1" }),
    },
  };

  return {
    service: new AddressService(prisma as unknown as PrismaService),
    prisma,
  };
}

describe("listing addresses", () => {
  it("carries the apartment count, so the house tabs can be built", async () => {
    const { service } = build({
      address: { ...ADDRESS, _count: { apartments: 28 } },
    });

    await expect(service.list()).resolves.toEqual([
      expect.objectContaining({ street: "Storgatan", apartmentCount: 28 }),
    ]);
  });
});

describe("adding an address", () => {
  it("places it after the addresses already there", async () => {
    const { service, prisma } = build();

    await service.create({
      street: "Storgatan",
      number: "14",
      postalCode: "123 45",
      city: "Stockholm",
    });

    expect(prisma.address.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ sortOrder: 3 })],
      }),
    );
  });

  it("starts at zero on an instance with no addresses", async () => {
    const { service, prisma } = build();
    prisma.address.findFirst.mockResolvedValue(null);

    await service.create({
      street: "Storgatan",
      number: "12",
      postalCode: "123 45",
      city: "Stockholm",
    });

    expect(prisma.address.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ sortOrder: 0 })],
      }),
    );
  });

  it("refuses the same entrance twice, decided by the database", async () => {
    // createMany with skipDuplicates writes nothing when the unique constraint
    // on street and number already holds, which is what makes two boards adding
    // the same entrance at once safe.
    const { service } = build({ createdCount: 0 });

    await expect(
      service.create({
        street: "Storgatan",
        number: "12",
        postalCode: "123 45",
        city: "Stockholm",
      }),
    ).rejects.toMatchObject({ reason: "address-exists" });
  });
});

describe("removing an address", () => {
  it("removes one with no apartments", async () => {
    const { service, prisma } = build();

    await service.remove("address-1");

    expect(prisma.address.delete).toHaveBeenCalledWith({
      where: { id: "address-1" },
    });
  });

  it("refuses while apartments remain, rather than cascading", async () => {
    const { service, prisma } = build({
      address: { ...ADDRESS, _count: { apartments: 28 } },
    });

    await expect(service.remove("address-1")).rejects.toMatchObject({
      reason: "has-apartments",
    });
    expect(prisma.address.delete).not.toHaveBeenCalled();
  });

  it("reports an address that is not there", async () => {
    const { service } = build({ address: null });

    await expect(service.remove("nope")).rejects.toMatchObject({
      reason: "not-found",
    });
  });
});

describe("adding apartments", () => {
  it("derives the floor from the Lantmateriet number", async () => {
    const { service, prisma } = build();

    await service.addApartments("address-1", [
      { number: "1001" },
      { number: "1101" },
      { number: "1203" },
      { number: "0901" },
    ]);

    expect(prisma.apartment.createMany).toHaveBeenCalledWith({
      data: [
        { addressId: "address-1", number: "1001", floor: 0 },
        { addressId: "address-1", number: "1101", floor: 1 },
        { addressId: "address-1", number: "1203", floor: 2 },
        { addressId: "address-1", number: "0901", floor: -1 },
      ],
      skipDuplicates: true,
    });
  });

  it("leaves the floor unset for a number that follows no convention", async () => {
    // An older cooperative may number its apartments 1, 2, 3. Inventing a
    // floor would file them under a physical grouping that does not exist.
    const { service, prisma } = build();

    await service.addApartments("address-1", [{ number: "7" }]);

    expect(prisma.apartment.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [{ addressId: "address-1", number: "7", floor: null }],
      }),
    );
  });

  it("keeps a floor the board stated by hand", async () => {
    const { service, prisma } = build();

    await service.addApartments("address-1", [{ number: "7", floor: 3 }]);

    expect(prisma.apartment.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [{ addressId: "address-1", number: "7", floor: 3 }],
      }),
    );
  });

  it("reports how many were skipped, so committing twice is harmless", async () => {
    const { service, prisma } = build();
    prisma.apartment.createMany.mockResolvedValue({ count: 1 });

    await expect(
      service.addApartments("address-1", [
        { number: "1001" },
        { number: "1002" },
        { number: "1003" },
      ]),
    ).resolves.toEqual({ created: 1, skipped: 2 });
  });

  it("refuses an address that is not there", async () => {
    const { service, prisma } = build({ address: null });

    await expect(
      service.addApartments("nope", [{ number: "1001" }]),
    ).rejects.toMatchObject({ reason: "not-found" });
    expect(prisma.apartment.createMany).not.toHaveBeenCalled();
  });
});

describe("removing an apartment", () => {
  it("removes one nothing in the register refers to", async () => {
    const { service, prisma } = build({
      apartment: { id: "apartment-1", number: "1101" },
    });

    await service.removeApartment("apartment-1");

    expect(prisma.apartment.delete).toHaveBeenCalledWith({
      where: { id: "apartment-1" },
    });
  });

  it.each([
    ["a residency", { residencies: 1 }],
    ["a member register entry", { memberRegisterEntries: 1 }],
    ["a transfer", { transfers: 1 }],
    ["a lien note", { lienNotes: 1 }],
  ])("refuses one with %s", async (_label, counts: Counts) => {
    const { service, prisma } = build({
      apartment: { id: "apartment-1", number: "1101", counts },
    });

    await expect(service.removeApartment("apartment-1")).rejects.toMatchObject({
      reason: "apartment-in-use",
    });
    expect(prisma.apartment.delete).not.toHaveBeenCalled();
  });

  it("reports an apartment that is not there", async () => {
    const { service } = build({ apartment: null });

    await expect(service.removeApartment("nope")).rejects.toMatchObject({
      reason: "not-found",
    });
  });
});
