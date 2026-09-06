import { Injectable } from "@nestjs/common";
import type {
  PluginApartment,
  PluginOccupancySummary,
  PluginResident,
} from "@openbrf/plugin-sdk";

import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";

/**
 * The register, as a plugin may read it.
 *
 * A separate service rather than a wrapper around AddressBookService, because
 * the two answer different questions. AddressBookService answers "what may
 * this signed-in person see", with filters, paging and the resident-facing
 * projection; this answers "what may this plugin see", which is a fixed and
 * much smaller shape. Sharing one service would mean a change made for the
 * board's screen could widen what a plugin receives.
 *
 * Three rules hold on every method regardless of the plugin's permissions,
 * because they are the product's own (plan section 4.4):
 *
 *   A person with protected personal data never appears. Not masked - absent.
 *   The core excludes them from resident-facing lists entirely, and a plugin
 *   is further from the board than a resident is, not closer.
 *
 *   A personal identity number is never returned. No permission grants it and
 *   there is no method that could.
 *
 *   Nothing is writable. A plugin that needs to change resident data is a core
 *   feature request.
 */
@Injectable()
export class PluginAddressBookService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: FieldEncryptionService,
  ) {}

  async apartments(): Promise<PluginApartment[]> {
    const rows = await this.prisma.apartment.findMany({
      orderBy: [{ address: { sortOrder: "asc" } }, { number: "asc" }],
      select: {
        id: true,
        number: true,
        floor: true,
        address: { select: { id: true, street: true, number: true } },
      },
    });

    return rows.map((row) => ({
      id: row.id,
      number: row.number,
      floor: row.floor,
      address: row.address,
    }));
  }

  /**
   * Current residencies only.
   *
   * A move-out date in the future is a scheduled move-out and does not end the
   * residency yet, which is the same definition the authorization layer and
   * the board's own screen use. Moved-out rows carry a computed purge date and
   * belong to the retention story; they are not plugin business.
   */
  async residents(
    options: { contact: boolean },
    now: Date = new Date(),
  ): Promise<PluginResident[]> {
    const rows = await this.prisma.residency.findMany({
      where: {
        OR: [{ movedOutOn: null }, { movedOutOn: { gt: now } }],
        /*
         * Protected personal data has never reached a plugin. A restriction
         * (GDPR art. 18) is excluded here for a narrower reason: handing the
         * row to code the association installed is a use, and art. 18(2)
         * permits storage rather than use.
         */
        person: { protectedPersonalData: false, processingRestrictedAt: null },
      },
      orderBy: [
        { apartment: { address: { sortOrder: "asc" } } },
        { apartment: { number: "asc" } },
        { id: "asc" },
      ],
      select: {
        role: true,
        movedInOn: true,
        movedOutOn: true,
        apartment: {
          select: {
            id: true,
            number: true,
            floor: true,
            address: { select: { id: true, street: true, number: true } },
          },
        },
        person: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            emailCipher: options.contact,
            phoneCipher: options.contact,
            /*
             * A standing objection (art. 21). The row still travels - the
             * plugin is entitled to know who lives here - but the contact
             * details do not, because the association has decided not to defend
             * a legitimate interest in messaging this person, and a plugin
             * given the address could message them anyway.
             */
            communicationObjectionAt: true,
          },
        },
      },
    });

    return Promise.all(
      rows.map(async (row) => {
        const base: PluginResident = {
          personId: row.person.id,
          name: `${row.person.firstName} ${row.person.lastName}`.trim(),
          role: row.role,
          apartment: row.apartment,
          movedInOn: toIsoDate(row.movedInOn),
          movedOutOn: toIsoDate(row.movedOutOn),
        };

        if (!options.contact) {
          // The keys are absent rather than null: a plugin without the
          // permission should not be able to tell "no email on file" from
          // "not allowed to see the email".
          return base;
        }

        // Nullish rather than strict: a row read without the column selected
        // means "nothing recorded", not "objecting".
        if (row.person.communicationObjectionAt != null) {
          // Null rather than absent, and the difference is deliberate: the
          // plugin holds the permission, so it may tell "objected or nothing on
          // file" from "not allowed to see it".
          return { ...base, email: null, phone: null };
        }

        const [email, phone] = await Promise.all([
          row.person.emailCipher == null
            ? null
            : this.encryption.decrypt("person.email", row.person.emailCipher),
          row.person.phoneCipher == null
            ? null
            : this.encryption.decrypt("person.phone", row.person.phoneCipher),
        ]);

        return { ...base, email, phone };
      }),
    );
  }

  async summary(now: Date = new Date()): Promise<PluginOccupancySummary> {
    const active: Prisma.ResidencyWhereInput = {
      OR: [{ movedOutOn: null }, { movedOutOn: { gt: now } }],
    };

    const [apartments, residents, members] = await Promise.all([
      this.prisma.apartment.count(),
      this.prisma.person.count({
        where: {
          protectedPersonalData: false,
          processingRestrictedAt: null,
          residencies: { some: active },
        },
      }),
      this.prisma.person.count({
        where: {
          protectedPersonalData: false,
          processingRestrictedAt: null,
          residencies: { some: { ...active, role: "MEMBER" } },
        },
      }),
    ]);

    return { apartments, residents, members };
  }
}

function toIsoDate(value: Date | null): string | null {
  return value === null ? null : (value.toISOString().split("T")[0] ?? null);
}
