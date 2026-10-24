import { Injectable } from "@nestjs/common";
import type {
  PluginApartment,
  PluginOccupancySummary,
  PluginResident,
  PluginResidentFilter,
} from "@openbrf/plugin-sdk";
import { formatDateColumn, localDayOf } from "@openbrf/shared";

import { hasStandingConsent } from "../address-book/publication-consent";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { pluginProcessorKey } from "../data-protection/processor-key";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { residencyHeldOn } from "../registers/held-on";

/**
 * The persons a plugin may read at all.
 *
 * Protected personal data has never reached a plugin. A restriction (GDPR art.
 * 18) is excluded for a narrower reason: handing the row to code the
 * association installed is a use, and art. 18(2) permits storage rather than
 * use. And a person whose objection to this plugin's processing the board
 * granted (art. 21, ADR 0035) is excluded because the association has stopped
 * that processing for them - absent rather than flagged, so the plugin is not
 * told that anybody objected and cannot list who did.
 *
 * One definition for every read, so the count in the summary and the rows in
 * the list cannot disagree about who is there.
 */
function readableBy(pluginId: string): Prisma.PersonWhereInput {
  return {
    protectedPersonalData: false,
    processingRestrictedAt: null,
    dataSubjectRequests: {
      none: {
        kind: "OBJECTION",
        decision: "GRANTED",
        closedAt: null,
        processingActivity: { sourceKey: pluginProcessorKey(pluginId) },
      },
    },
  };
}

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
 * because they are the product's own (plan section 4.4), and a fourth is the
 * association's answer to an objection (ADR 0035):
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
 *
 *   A person with a standing objection to the reading plugin's processing
 *   never appears to that plugin. Which plugin is reading is the host's to
 *   say, never the plugin's: every method takes the id the host object was
 *   built for.
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
   * The residencies held today, and only those.
   *
   * A move-out date in the future is a scheduled move-out and does not end the
   * residency yet, and a move-in date in the future has not begun it: the same
   * definition the authorization layer and the board's own screen use.
   * Moved-out rows carry a computed purge date and belong to the retention
   * story, and a household that has not moved in is not living here yet;
   * neither is plugin business.
   */
  async residents(
    pluginId: string,
    options: { contact: boolean; filter?: PluginResidentFilter },
    now: Date = new Date(),
  ): Promise<PluginResident[]> {
    const addressId = options.filter?.addressId;
    const rows = await this.prisma.residency.findMany({
      where: {
        ...residencyHeldOn(localDayOf(now)),
        ...(addressId === undefined ? {} : { apartment: { addressId } }),
        person: readableBy(pluginId),
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
            /*
             * The one scope a plugin is told about, and only as a yes or a
             * no: whether the name may be shown on screens in the building.
             */
            publicationConsents: {
              where: { scope: "NAME_IN_BUILDING" },
              select: { scope: true, grantedAt: true, withdrawnAt: true },
            },
          },
        },
      },
    });

    return Promise.all(
      rows.map(async (row) => {
        const base: PluginResident = {
          personId: row.person.id,
          name: `${row.person.firstName} ${row.person.lastName}`.trim(),
          lastName: row.person.lastName,
          role: row.role,
          apartment: row.apartment,
          movedInOn: formatDateColumn(row.movedInOn),
          movedOutOn: formatDateColumn(row.movedOutOn),
          nameInBuilding: hasStandingConsent(
            row.person.publicationConsents,
            "NAME_IN_BUILDING",
          ),
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

  async summary(
    pluginId: string,
    now: Date = new Date(),
  ): Promise<PluginOccupancySummary> {
    const active: Prisma.ResidencyWhereInput = residencyHeldOn(localDayOf(now));

    const [apartments, residents, members] = await Promise.all([
      this.prisma.apartment.count(),
      this.prisma.person.count({
        where: {
          ...readableBy(pluginId),
          residencies: { some: active },
        },
      }),
      this.prisma.person.count({
        where: {
          ...readableBy(pluginId),
          residencies: { some: { ...active, role: "MEMBER" } },
        },
      }),
    ]);

    return { apartments, residents, members };
  }
}
