import { describe, expect, it } from "vite-plus/test";

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
    publicationConsents: [] as {
      scope: "NAME_IN_BUILDING";
      grantedAt: Date;
      withdrawnAt: Date | null;
    }[],
  },
};

function serviceReturning(
  row: unknown = ROW,
  queries: unknown[] = [],
): PluginAddressBookService {
  const prisma = {
    residency: {
      findMany: async (query: unknown) => {
        queries.push(query);
        return [row];
      },
    },
  } as unknown as PrismaService;
  const encryption = {
    decrypt: async (field: string) =>
      field === "person.email" ? "anna@exempel.se" : "070-1234567",
  } as unknown as FieldEncryptionService;

  return new PluginAddressBookService(prisma, encryption);
}

describe("what addressBook:read releases", () => {
  it("projects the fields the consent text names, and no others", async () => {
    const [resident] = await serviceReturning().residents("occupancy", {
      contact: false,
    });

    expect(Object.keys(resident ?? {}).sort()).toEqual([
      "apartment",
      "lastName",
      "movedInOn",
      "movedOutOn",
      "name",
      "nameInBuilding",
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
    const [resident] = await serviceReturning().residents("occupancy", {
      contact: false,
    });
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
    const [resident] = await serviceReturning().residents("occupancy", {
      contact: false,
    });

    expect(resident?.role).toBe("MEMBER");
    expect(resident?.movedInOn).toBe("2026-01-15");
    expect(resident?.movedOutOn).toBeNull();
  });

  it("adds only email and telephone for the wider permission", async () => {
    const [resident] = await serviceReturning().residents("occupancy", {
      contact: true,
    });

    expect(Object.keys(resident ?? {}).sort()).toEqual([
      "apartment",
      "email",
      "lastName",
      "movedInOn",
      "movedOutOn",
      "name",
      "nameInBuilding",
      "personId",
      "phone",
      "role",
    ]);
    expect(resident?.email).toBe("anna@exempel.se");
  });

  it("withholds the contact details of somebody who has objected", async () => {
    /*
     * The row still travels - a plugin is entitled to know who lives here - but
     * the address does not. A news mailing rests on a legitimate interest the
     * person has objected to under GDPR art. 21 and that the association has
     * decided not to defend, and a plugin handed the address could send the
     * message the association just agreed not to send.
     */
    const objecting = {
      ...ROW,
      person: {
        ...ROW.person,
        communicationObjectionAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    };

    const [resident] = await serviceReturning(objecting).residents(
      "occupancy",
      { contact: true },
    );

    expect(resident?.name).toBe("Anna Andersson");
    // Null rather than absent: the plugin holds the permission, so it may tell
    // "nothing to give" from "not allowed to see it".
    expect(resident?.email).toBeNull();
    expect(resident?.phone).toBeNull();
  });
});

describe("what ADR 0035 narrows", () => {
  it("gives the family name alone beside the full name", async () => {
    const [resident] = await serviceReturning().residents("occupancy", {
      contact: false,
    });

    expect(resident?.lastName).toBe("Andersson");
    expect(resident?.name).toBe("Anna Andersson");
  });

  it("reads a name on screens in the building from its own consent scope", async () => {
    const consenting = {
      ...ROW,
      person: {
        ...ROW.person,
        publicationConsents: [
          {
            scope: "NAME_IN_BUILDING" as const,
            grantedAt: new Date("2026-02-01T09:00:00.000Z"),
            withdrawnAt: null,
          },
        ],
      },
    };
    const withdrawn = {
      ...consenting,
      person: {
        ...consenting.person,
        publicationConsents: [
          {
            scope: "NAME_IN_BUILDING" as const,
            grantedAt: new Date("2026-02-01T09:00:00.000Z"),
            withdrawnAt: new Date("2026-03-01T09:00:00.000Z"),
          },
        ],
      },
    };

    const [never] = await serviceReturning().residents("occupancy", {
      contact: false,
    });
    const [granted] = await serviceReturning(consenting).residents(
      "occupancy",
      { contact: false },
    );
    const [gone] = await serviceReturning(withdrawn).residents("occupancy", {
      contact: false,
    });

    expect(never?.nameInBuilding).toBe(false);
    expect(granted?.nameInBuilding).toBe(true);
    expect(gone?.nameInBuilding).toBe(false);
  });

  it("leaves out whoever objected to the reading plugin's processing, by its own row", async () => {
    const queries: unknown[] = [];
    await serviceReturning(ROW, queries).residents("occupancy", {
      contact: false,
    });

    expect(queries[0]).toMatchObject({
      where: {
        person: {
          protectedPersonalData: false,
          processingRestrictedAt: null,
          dataSubjectRequests: {
            none: {
              kind: "OBJECTION",
              decision: "GRANTED",
              closedAt: null,
              processingActivity: { sourceKey: "plugin:occupancy" },
            },
          },
        },
      },
    });
  });

  it("reads one entrance when asked for one, and every entrance otherwise", async () => {
    const queries: unknown[] = [];
    const service = serviceReturning(ROW, queries);

    await service.residents("occupancy", {
      contact: false,
      filter: { addressId: "address-1" },
    });
    await service.residents("occupancy", { contact: false });

    expect(queries[0]).toMatchObject({
      where: { apartment: { addressId: "address-1" } },
    });
    expect(
      (queries[1] as { where: Record<string, unknown> }).where,
    ).not.toHaveProperty("apartment");
  });
});
