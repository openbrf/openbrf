import { Injectable } from "@nestjs/common";

import { isMasked } from "../address-book/address-book-view";
import { AuditLogService } from "../audit/audit-log.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import {
  isCurrentMembership,
  type MembershipPeriod,
  membershipPeriods,
  recordedAt,
  resolveRegisterEvents,
} from "./membership-periods";

/**
 * The statutory member register (medlemsforteckning), EFL 5 kap. via
 * BRL 9 kap.
 *
 * This is not the address book and not the apartment register. It is its own
 * document with its own field list, fixed by statute and deliberately short:
 *
 *   name, postal address, membership entry and exit dates, apartment linkage
 *
 * and **never a personal identity number**. The extract from this register is
 * public on request - anyone may ask the cooperative for it - which is exactly
 * why the identity numbers that the apartment register does carry must not
 * appear here. There is no flag, no parameter and no privileged caller that
 * adds one: the query below does not select the column.
 */

/** What the register shows in place of a protected person's address. */
export type RegisterPostalAddress =
  | {
      state: "visible";
      street: string | null;
      postalCode: string | null;
      city: string | null;
    }
  | { state: "masked"; alternativePostalAddress: string | null };

/** One apartment a membership relates to. */
export interface MemberRegisterApartment {
  id: string;
  number: string;
  addressLabel: string;
}

export interface MemberRegisterRow {
  /** Stable key: a person may hold several memberships over time. */
  key: string;
  personId: string;
  name: string;
  postalAddress: RegisterPostalAddress;
  protectedPersonalData: boolean;
  /** Null only for an exit the archive holds with no entry before it. */
  enteredOn: string | null;
  /** Null while the membership is current. */
  exitedOn: string | null;
  apartments: MemberRegisterApartment[];
}

export type MemberRegisterScope = "current" | "all";

export interface MemberRegisterExtract {
  housingCooperative: { name: string; organizationNumber: string | null };
  scope: MemberRegisterScope;
  /** Date the extract was produced, for the register stamp. */
  generatedOn: string;
  rows: MemberRegisterRow[];
}

interface PersonRecord {
  id: string;
  firstName: string;
  lastName: string;
  postalStreet: string | null;
  postalCode: string | null;
  postalCity: string | null;
  alternativePostalAddress: string | null;
  protectedPersonalData: boolean;
  residencies: {
    movedInOn: Date;
    movedOutOn: Date | null;
    apartment: {
      id: string;
      number: string;
      address: { street: string; number: string };
    };
  }[];
}

@Injectable()
export class MemberRegisterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * Produces the extract, writing its audit entry in the same transaction.
   *
   * Reading the statutory register is itself an audited act (plan section 4.2):
   * the log has to be able to answer who took a copy of the member list and
   * when, which is a question a supervisory authority asks and a board member
   * asks after a leak.
   */
  async extract(input: {
    actorPersonId: string;
    scope: MemberRegisterScope;
    now?: Date;
  }): Promise<MemberRegisterExtract> {
    const now = input.now ?? new Date();

    return this.audit.withAuditedRead<MemberRegisterExtract>(
      {
        action: "MEMBER_REGISTER_EXTRACT_GENERATED",
        actorPersonId: input.actorPersonId,
        context: { scope: input.scope },
      },
      async (tx) => this.build(tx, input.scope, now),
    );
  }

  private async build(
    tx: Prisma.TransactionClient,
    scope: MemberRegisterScope,
    now: Date,
  ): Promise<MemberRegisterExtract> {
    const association = await tx.association.findUnique({
      where: { id: 1 },
      select: { name: true, organizationNumber: true },
    });

    const archive = await tx.memberRegisterEntry.findMany({
      orderBy: [{ eventOn: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        personId: true,
        apartmentId: true,
        eventType: true,
        eventOn: true,
        recordedFirstName: true,
        recordedLastName: true,
        recordedPostalStreet: true,
        recordedPostalCode: true,
        recordedPostalCity: true,
        correctsEntryId: true,
        createdAt: true,
      },
    });

    const periods = membershipPeriods(resolveRegisterEvents(archive)).filter(
      (period) => scope === "all" || isCurrentMembership(period, now),
    );

    const personIds = [...new Set(periods.map((period) => period.personId))];
    const persons = await tx.person.findMany({
      where: { id: { in: personIds } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        postalStreet: true,
        postalCode: true,
        postalCity: true,
        alternativePostalAddress: true,
        protectedPersonalData: true,
        // Only tenant-ownerships: the register's apartment linkage is the
        // apartment the membership is tied to, not everywhere the person has
        // ever lived.
        residencies: {
          where: { role: "MEMBER" },
          orderBy: [{ movedInOn: "asc" }],
          select: {
            movedInOn: true,
            movedOutOn: true,
            apartment: {
              select: {
                id: true,
                number: true,
                address: { select: { street: true, number: true } },
              },
            },
          },
        },
      },
    });
    const byPerson = new Map(persons.map((person) => [person.id, person]));

    const rows = periods
      .map((period) => this.toRow(period, byPerson.get(period.personId), now))
      .filter((row): row is MemberRegisterRow => row !== null)
      .sort(byNameThenEntry);

    return {
      housingCooperative: {
        name: association?.name ?? "",
        organizationNumber: association?.organizationNumber ?? null,
      },
      scope,
      generatedOn: isoDate(now) ?? "",
      rows,
    };
  }

  /**
   * One line of the extract.
   *
   * Name and postal address come from two different places on purpose. A
   * current membership shows what the register holds today, because the
   * register has to be kept up to date; an ended one shows what was recorded at
   * the time, because the archive is the truthful record of a membership that
   * no longer exists and the person may since have moved.
   */
  private toRow(
    period: MembershipPeriod,
    person: PersonRecord | undefined,
    now: Date,
  ): MemberRegisterRow | null {
    const archived = recordedAt(period);
    if (person === undefined || archived === null) {
      return null;
    }

    const current = isCurrentMembership(period, now);
    const protectedData = person.protectedPersonalData;

    const name = current
      ? `${person.firstName} ${person.lastName}`.trim()
      : `${archived.recordedFirstName} ${archived.recordedLastName}`.trim();

    // Protection is about where the person is now, so it masks the archived
    // address as well as the current one.
    const postalAddress: RegisterPostalAddress = isMasked("postalAddress", {
      protectedPersonalData: protectedData,
    })
      ? {
          state: "masked",
          alternativePostalAddress: person.alternativePostalAddress,
        }
      : current
        ? {
            state: "visible",
            street: person.postalStreet,
            postalCode: person.postalCode,
            city: person.postalCity,
          }
        : {
            state: "visible",
            street: archived.recordedPostalStreet,
            postalCode: archived.recordedPostalCode,
            city: archived.recordedPostalCity,
          };

    return {
      key: `${period.personId}:${archived.id}`,
      personId: person.id,
      name,
      postalAddress,
      protectedPersonalData: protectedData,
      enteredOn: isoDate(period.entry?.eventOn ?? null),
      exitedOn: isoDate(period.exit?.eventOn ?? null),
      apartments: apartmentsFor(period, person, current),
    };
  }
}

/**
 * The apartments a membership relates to.
 *
 * For a current membership these are the tenant-ownerships held today, which is
 * what the register is supposed to state. For an ended one they are the
 * tenant-ownerships that overlapped the membership, so a member who sold one
 * apartment and later left still shows both against the right period.
 */
function apartmentsFor(
  period: MembershipPeriod,
  person: PersonRecord,
  current: boolean,
): MemberRegisterApartment[] {
  const from = period.entry?.eventOn ?? null;
  const until = period.exit?.eventOn ?? null;

  return person.residencies
    .filter((residency) => {
      if (current) {
        return residency.movedOutOn === null;
      }
      const startedBeforeExit =
        until === null || residency.movedInOn.getTime() <= until.getTime();
      const endedAfterEntry =
        residency.movedOutOn === null ||
        from === null ||
        residency.movedOutOn.getTime() >= from.getTime();
      return startedBeforeExit && endedAfterEntry;
    })
    .map((residency) => ({
      id: residency.apartment.id,
      number: residency.apartment.number,
      addressLabel: `${residency.apartment.address.street} ${residency.apartment.address.number}`,
    }));
}

function byNameThenEntry(
  left: MemberRegisterRow,
  right: MemberRegisterRow,
): number {
  const byName = left.name.localeCompare(right.name, "sv");
  if (byName !== 0) {
    return byName;
  }
  return (left.enteredOn ?? "").localeCompare(right.enteredOn ?? "");
}

/** ISO calendar date (YYYY-MM-DD), which is what the mono grid prints. */
function isoDate(value: Date | null): string | null {
  if (value === null) {
    return null;
  }
  const iso = value.toISOString();
  return iso.slice(0, iso.indexOf("T"));
}
