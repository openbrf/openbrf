import { describe, expect, it } from "vitest";

import type { FieldEncryptionService } from "../crypto/field-encryption.service";
import type { PrismaService } from "../database/prisma.service";
import { PluginAddressBookService } from "./plugin-address-book.service";

/**
 * Exactly what a plugin receives from the register.
 *
 * The consent screen is the association's record of what it agreed to release
 * to a package, and this branch refuses a republished version that asks for
 * more than was granted - so the record has to be true of the projection, and
 * the projection has to stay what the record describes. A field added here
 * widens what every already-consented plugin receives without anybody
 * consenting to it, which is why the assertion is on the whole key set rather
 * than on the fields anyone happens to think of.
 *
 * Driven against a stubbed client: what is under test is the shape the service
 * projects, not the query that fills it.
 */

const ROW = {
  role: "MEMBER" as const,
  movedInOn: new Date("2026-01-15T00:00:00.000Z"),
  movedOutOn: null,
  apartment: {
    id: "apartment-1",
    number: "1101",
    floor: 11,
    address: { id: "address-1", street: "Kungsgatan", number: "4" },
  },
  person: {
    id: "person-1",
    firstName: "Anna",
    lastName: "Andersson",
    emailCipher: "cipher-email",
    phoneCipher: "cipher-phone",
  },
};

function serviceReturning(row: unknown = ROW): PluginAddressBookService {
  const prisma = {
    residency: { findMany: async () => [row] },
  } as unknown as PrismaService;
  const encryption = {
    decrypt: async (field: string) =>
      field === "person.email" ? "anna@exempel.se" : "070-1234567",
  } as unknown as FieldEncryptionService;

  return new PluginAddressBookService(prisma, encryption);
}

describe("what addressBook:read releases", () => {
  it("projects the fields the consent text names, and no others", async () => {
    const [resident] = await serviceReturning().residents({ contact: false });

    expect(Object.keys(resident ?? {}).sort()).toEqual([
      "apartment",
      "movedInOn",
      "movedOutOn",
      "name",
      "personId",
      "role",
    ]);
  });

  /**
   * Named rather than left to the key set above, because these are the three
   * the product's own rules turn on: contact data is board-only, a personal
   * identity number is granted by no permission at all, and who sits on the
   * board is a core capability that no host method a plugin holds can read.
   */
  it("releases no contact detail, identity number or board position", async () => {
    const [resident] = await serviceReturning().residents({ contact: false });
    const keys = Object.keys(resident ?? {});

    expect(keys).not.toContain("email");
    expect(keys).not.toContain("phone");
    expect(JSON.stringify(resident)).not.toContain("cipher");
    expect(
      keys.some((key) => /board|personalIdentity|personnummer/i.test(key)),
    ).toBe(false);
  });

  it("says whether the person is a member, and when they moved", async () => {
    // The half of the declaration that is easy to lose: the dates travel with
    // the role, so the consent text has to name them too.
    const [resident] = await serviceReturning().residents({ contact: false });

    expect(resident?.role).toBe("MEMBER");
    expect(resident?.movedInOn).toBe("2026-01-15");
    expect(resident?.movedOutOn).toBeNull();
  });

  it("adds only email and telephone for the wider permission", async () => {
    const [resident] = await serviceReturning().residents({ contact: true });

    expect(Object.keys(resident ?? {}).sort()).toEqual([
      "apartment",
      "email",
      "movedInOn",
      "movedOutOn",
      "name",
      "personId",
      "phone",
      "role",
    ]);
    expect(resident?.email).toBe("anna@exempel.se");
  });
});
