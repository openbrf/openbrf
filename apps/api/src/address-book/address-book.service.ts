import { Injectable } from "@nestjs/common";

import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { computePurgeDate } from "../retention/purge-date";
import {
  APARTMENT_FIELDS,
  BOARD_PERSON_FIELDS,
  RESIDENT_PERSON_FIELDS,
} from "./address-book-projection";
import {
  type AddressBookApartment,
  type AddressBookRecord,
  type AddressBookRow,
  hasMovedOut,
  isVisibleToResidents,
  type ResidentDirectoryRow,
  toAddressBookRow,
  toIsoDate,
  toResidentDirectoryRow,
} from "./address-book-view";

export class AddressBookError extends Error {
  constructor(
    message: string,
    readonly reason: "apartment-not-found",
  ) {
    super(message);
    this.name = "AddressBookError";
  }
}

/** The on-board filter tabs. */
export const ADDRESS_BOOK_FILTERS = [
  /** Everyone in scope, moved-out rows included and marked as such. */
  "all",
  /** Holds the tenant-ownership (medlem), residency current. */
  "members",
  /** Occupies without holding it (boende), residency current. */
  "residents",
  /** Holds a position of trust, with or without an apartment. */
  "board",
  /** Residency ended on or before today. */
  "movedOut",
] as const;

export type AddressBookFilter = (typeof ADDRESS_BOOK_FILTERS)[number];

export interface AddressBookQuery {
  /** Undefined selects every address, which is the default board view. */
  addressId?: string;
  filter: AddressBookFilter;
  /**
   * Free-text search. Name and apartment number match incrementally; email and
   * phone match only on a complete, normalized value, because a blind index
   * supports equality and nothing else (ADR 0002).
   */
  search?: string;
  /** 1-based. */
  page: number;
  pageSize: number;
}

/** One house tab. */
export interface AddressBookAddress {
  id: string;
  street: string;
  number: string;
  postalCode: string;
  city: string;
  apartments: number;
}

export interface AddressBookStats {
  /** Apartments in scope. */
  apartments: number;
  /** Distinct persons in scope, moved-out residencies excluded. */
  persons: number;
  /** Distinct persons holding a current tenant-ownership in scope. */
  members: number;
}

export interface AddressBookPage<TRow> {
  rows: TRow[];
  /** House tabs. The client shows them only when there is more than one. */
  addresses: AddressBookAddress[];
  /** Row count per filter, for the on-board filter tabs. */
  counts: Record<AddressBookFilter, number>;
  total: number;
  page: number;
  pageSize: number;
  stats: AddressBookStats;
  /** Date this view was produced, for the register stamp. */
  generatedOn: string;
}

/**
 * Reads the address book.
 *
 * Masking is applied here, server-side, and never left to the client: the
 * response for a resident does not contain contact data to hide. Two entry
 * points exist rather than one with a flag, because the audiences return
 * different shapes and the type system should be the thing that stops contact
 * data reaching a resident.
 *
 * The address book is not the member register and not the apartment register.
 * Those are statutory documents (EFL 5 kap. and BRL 9 kap.) with their own
 * views, field lists and access rules; this is the operational register the
 * board works in, and it deliberately carries neither lien notes nor initial
 * share capital nor a personal identity number.
 */
@Injectable()
export class AddressBookService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: FieldEncryptionService,
  ) {}

  /** The board and admin view: contact data included, protected rows masked. */
  async boardView(
    query: AddressBookQuery,
    now: Date = new Date(),
  ): Promise<AddressBookPage<AddressBookRow>> {
    const retentionDays = await this.retentionDays();
    return this.page(query, now, {
      audience: "board",
      viewerPersonId: null,
      toRow: (record) =>
        toAddressBookRow(record, {
          today: now,
          purgeOn: toIsoDate(
            computePurgeDate(record.movedOutOn, retentionDays),
          ),
        }),
    });
  }

  /**
   * The resident-facing view: names, apartments, roles and dates.
   *
   * Persons with protected personal data are excluded entirely rather than
   * masked, and the viewer's own entry is the single exception - a protected
   * resident has to be able to find themselves.
   */
  async residentDirectory(
    query: AddressBookQuery,
    viewerPersonId: string,
    now: Date = new Date(),
  ): Promise<AddressBookPage<ResidentDirectoryRow>> {
    return this.page(query, now, {
      audience: "resident",
      viewerPersonId,
      toRow: (record) => toResidentDirectoryRow(record, { today: now }),
    });
  }

  /**
   * One apartment, as the address book shows it.
   *
   * Carries residents, residency history and the participation share
   * (andelstal). It deliberately carries NO lien notes and NO initial share
   * capital: those are apartment register content (lagenhetsforteckning,
   * BRL 9 kap.), which is confidential and reachable only through the apartment
   * register view, by the board and by the holder of that apartment. Putting
   * them on this screen would blend two statutory registers into one.
   */
  async apartmentDetail(
    apartmentId: string,
    now: Date = new Date(),
  ): Promise<ApartmentDetail> {
    const apartment = await this.prisma.apartment.findUnique({
      where: { id: apartmentId },
      select: {
        ...APARTMENT_FIELDS,
        participationShare: true,
        address: {
          select: {
            id: true,
            street: true,
            number: true,
            postalCode: true,
            city: true,
          },
        },
        residencies: {
          orderBy: [{ movedInOn: "desc" }],
          select: {
            id: true,
            role: true,
            movedInOn: true,
            movedOutOn: true,
            person: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                protectedPersonalData: true,
              },
            },
          },
        },
      },
    });

    if (apartment === null) {
      throw new AddressBookError("No such apartment.", "apartment-not-found");
    }

    const residencies = apartment.residencies.map((residency) => ({
      view: {
        residencyId: residency.id,
        personId: residency.person.id,
        name: `${residency.person.firstName} ${residency.person.lastName}`.trim(),
        protectedPersonalData: residency.person.protectedPersonalData,
        role: residency.role,
        movedInOn: toIsoDate(residency.movedInOn),
        movedOutOn: toIsoDate(residency.movedOutOn),
      },
      ended: hasMovedOut(residency.movedOutOn, now),
    }));

    return {
      id: apartment.id,
      number: apartment.number,
      floor: apartment.floor,
      participationShare: apartment.participationShare?.toString() ?? null,
      address: apartment.address,
      residents: residencies
        .filter((residency) => !residency.ended)
        .map((residency) => residency.view),
      history: residencies
        .filter((residency) => residency.ended)
        .map((residency) => residency.view),
    };
  }

  /** House tabs, in presentation order. */
  async addresses(): Promise<AddressBookAddress[]> {
    const rows = await this.prisma.address.findMany({
      orderBy: [{ sortOrder: "asc" }, { street: "asc" }, { number: "asc" }],
      select: {
        id: true,
        street: true,
        number: true,
        postalCode: true,
        city: true,
        _count: { select: { apartments: true } },
      },
    });

    return rows.map((row) => ({
      id: row.id,
      street: row.street,
      number: row.number,
      postalCode: row.postalCode,
      city: row.city,
      apartments: row._count.apartments,
    }));
  }

  private async retentionDays(): Promise<number> {
    const association = await this.prisma.association.findUnique({
      where: { id: 1 },
      select: { retentionDaysAfterMoveOut: true },
    });
    // A fresh instance starts at 365 days; the same default applies before the
    // setup wizard has written the association row.
    return association?.retentionDaysAfterMoveOut ?? 365;
  }

  /**
   * The shared paging engine.
   *
   * Rows come from two sources: residencies, ordered by apartment number so the
   * board reads like the physical name board, and persons with no residency at
   * all - external board members and admins, who cannot be grouped by floor and
   * therefore sort after every apartment. Paging spans both, which is why the
   * slice arithmetic below splits the requested window between them rather than
   * querying each independently.
   */
  private async page<TRow>(
    query: AddressBookQuery,
    now: Date,
    options: {
      audience: "board" | "resident";
      viewerPersonId: string | null;
      toRow: (record: AddressBookRecord) => TRow;
    },
  ): Promise<AddressBookPage<TRow>> {
    const searchTerms = await this.searchTerms(query.search);

    const residencyWhere = this.residencyWhere(
      query,
      now,
      searchTerms,
      options,
    );
    const withoutApartmentWhere = this.withoutApartmentWhere(
      query,
      now,
      searchTerms,
      options,
    );

    const [residencyTotal, withoutApartmentTotal] = await Promise.all([
      this.prisma.residency.count({ where: residencyWhere }),
      withoutApartmentWhere === null
        ? Promise.resolve(0)
        : this.prisma.person.count({ where: withoutApartmentWhere }),
    ]);

    const total = residencyTotal + withoutApartmentTotal;
    const skip = (query.page - 1) * query.pageSize;

    const residencySkip = Math.min(skip, residencyTotal);
    const residencyTake = Math.max(
      0,
      Math.min(query.pageSize, residencyTotal - skip),
    );
    const extraSkip = Math.max(0, skip - residencyTotal);
    const extraTake = query.pageSize - residencyTake;

    const personFields =
      options.audience === "board"
        ? BOARD_PERSON_FIELDS
        : RESIDENT_PERSON_FIELDS;
    const boardPositionFilter = {
      where: activeBoardPosition(now),
      select: { position: true },
    } as const;

    const [residencies, withoutApartment] = await Promise.all([
      residencyTake === 0
        ? Promise.resolve([])
        : this.prisma.residency.findMany({
            where: residencyWhere,
            orderBy: [
              { apartment: { address: { sortOrder: "asc" } } },
              { apartment: { number: "asc" } },
              { person: { lastName: "asc" } },
              { person: { firstName: "asc" } },
              { id: "asc" },
            ],
            skip: residencySkip,
            take: residencyTake,
            select: {
              id: true,
              role: true,
              movedInOn: true,
              movedOutOn: true,
              apartment: { select: APARTMENT_FIELDS },
              person: {
                select: {
                  ...personFields,
                  boardPositions: boardPositionFilter,
                },
              },
            },
          }),
      extraTake === 0 || withoutApartmentWhere === null
        ? Promise.resolve([])
        : this.prisma.person.findMany({
            where: withoutApartmentWhere,
            orderBy: [{ lastName: "asc" }, { firstName: "asc" }, { id: "asc" }],
            skip: extraSkip,
            take: extraTake,
            select: {
              ...personFields,
              boardPositions: boardPositionFilter,
            },
          }),
    ]);

    const records: AddressBookRecord[] = [
      ...residencies.map((residency) =>
        this.toRecord({
          residencyId: residency.id,
          role: residency.role,
          movedInOn: residency.movedInOn,
          movedOutOn: residency.movedOutOn,
          apartment: residency.apartment,
          person: residency.person,
        }),
      ),
      ...withoutApartment.map((person) =>
        this.toRecord({
          residencyId: null,
          role: null,
          movedInOn: null,
          movedOutOn: null,
          apartment: null,
          person,
        }),
      ),
    ];

    const visible =
      options.audience === "resident" && options.viewerPersonId !== null
        ? // Second line of defence. The query already excludes protected
          // persons; this makes a future change to that query fail closed
          // rather than start leaking.
          records.filter((record) =>
            isVisibleToResidents(record, options.viewerPersonId ?? ""),
          )
        : records;

    const decrypted =
      options.audience === "board"
        ? await Promise.all(visible.map((record) => this.decrypt(record)))
        : visible;

    const [counts, stats, addresses] = await Promise.all([
      this.counts(query, now, searchTerms, options),
      this.stats(query, now, options),
      this.addresses(),
    ]);

    return {
      rows: decrypted.map((record) => options.toRow(record)),
      addresses,
      counts,
      total,
      page: query.page,
      pageSize: query.pageSize,
      stats,
      generatedOn: toIsoDate(now) ?? "",
    };
  }

  private toRecord(input: {
    residencyId: string | null;
    role: AddressBookRecord["role"];
    movedInOn: Date | null;
    movedOutOn: Date | null;
    apartment: AddressBookApartment | null;
    person: {
      id: string;
      firstName: string;
      lastName: string;
      protectedPersonalData: boolean;
      emailCipher?: string | null;
      phoneCipher?: string | null;
      boardPositions: {
        position: AddressBookRecord["boardPositions"][number];
      }[];
    };
  }): AddressBookRecord & {
    emailCipher?: string | null;
    phoneCipher?: string | null;
  } {
    return {
      personId: input.person.id,
      residencyId: input.residencyId,
      firstName: input.person.firstName,
      lastName: input.person.lastName,
      protectedPersonalData: input.person.protectedPersonalData,
      apartment: input.apartment,
      role: input.role,
      movedInOn: input.movedInOn,
      movedOutOn: input.movedOutOn,
      boardPositions: input.person.boardPositions.map(
        (position) => position.position,
      ),
      email: null,
      phone: null,
      hasEmail: input.person.emailCipher != null,
      hasPhone: input.person.phoneCipher != null,
      emailCipher: input.person.emailCipher ?? null,
      phoneCipher: input.person.phoneCipher ?? null,
    };
  }

  /**
   * Decrypts contact data for a board row.
   *
   * A person with protected personal data is skipped entirely: the ciphertext is
   * not decrypted, so the plaintext never exists in this process and cannot be
   * serialised by mistake. Whether a value exists is still reported, because
   * that is what tells the board a reveal is worth requesting.
   */
  private async decrypt(
    record: AddressBookRecord & {
      emailCipher?: string | null;
      phoneCipher?: string | null;
    },
  ): Promise<AddressBookRecord> {
    if (record.protectedPersonalData) {
      return { ...record, email: null, phone: null };
    }

    const [email, phone] = await Promise.all([
      record.emailCipher == null
        ? null
        : this.encryption.decrypt("person.email", record.emailCipher),
      record.phoneCipher == null
        ? null
        : this.encryption.decrypt("person.phone", record.phoneCipher),
    ]);

    return { ...record, email, phone };
  }

  /**
   * Turns the search box into where-clause fragments.
   *
   * Name and apartment number are plaintext and match incrementally, which is
   * what a board member expects from a search field. Email and phone are
   * encrypted, and a blind index answers equality only: "070-123" finds nothing,
   * the complete number finds the row. The index is computed through the
   * encryption service rather than by normalizing here, because a hand-rolled
   * normalization silently misses rows that exist.
   */
  private async searchTerms(search: string | undefined): Promise<{
    tokens: string[];
    digits: string | null;
    emailIndex: string | null;
    phoneIndex: string | null;
  } | null> {
    const trimmed = search?.trim() ?? "";
    if (trimmed === "") {
      return null;
    }

    const tokens = trimmed.split(/\s+/).filter((token) => token !== "");
    const digits = /\d/.test(trimmed) ? trimmed.replace(/\D/g, "") : null;

    const emailIndex = trimmed.includes("@")
      ? await this.encryption.computeIndex("person.email", trimmed)
      : null;
    // A phone number needs enough digits to be a whole number rather than a
    // fragment. Below that the index would be computed from something that was
    // never a phone number and could only ever match by accident.
    const phoneIndex =
      digits !== null && digits.length >= 6
        ? await this.encryption.computeIndex("person.phone", trimmed)
        : null;

    return { tokens, digits, emailIndex, phoneIndex };
  }

  private personSearchWhere(
    terms: NonNullable<Awaited<ReturnType<AddressBookService["searchTerms"]>>>,
  ): Prisma.PersonWhereInput {
    const alternatives: Prisma.PersonWhereInput[] = [];

    // Every token has to match a name part, so "anna lind" finds Anna Lindqvist
    // and "lind anna" finds her too.
    alternatives.push({
      AND: terms.tokens.map((token) => ({
        OR: [
          { firstName: { contains: token, mode: "insensitive" as const } },
          { lastName: { contains: token, mode: "insensitive" as const } },
        ],
      })),
    });

    if (terms.emailIndex !== null) {
      alternatives.push({ emailIndex: terms.emailIndex });
    }
    if (terms.phoneIndex !== null) {
      alternatives.push({ phoneIndex: terms.phoneIndex });
    }

    return { OR: alternatives };
  }

  private residencyWhere(
    query: AddressBookQuery,
    now: Date,
    terms: Awaited<ReturnType<AddressBookService["searchTerms"]>>,
    options: { audience: "board" | "resident"; viewerPersonId: string | null },
  ): Prisma.ResidencyWhereInput {
    const conditions: Prisma.ResidencyWhereInput[] = [];

    if (query.addressId !== undefined) {
      conditions.push({ apartment: { addressId: query.addressId } });
    }

    switch (query.filter) {
      case "all":
        break;
      case "members":
        conditions.push({ role: "MEMBER" }, activeResidency(now));
        break;
      case "residents":
        conditions.push({ role: "RESIDENT" }, activeResidency(now));
        break;
      case "board":
        conditions.push({
          person: { boardPositions: { some: activeBoardPosition(now) } },
        });
        break;
      case "movedOut":
        conditions.push(movedOutResidency(now));
        break;
    }

    if (terms !== null) {
      const alternatives: Prisma.ResidencyWhereInput[] = [
        { person: this.personSearchWhere(terms) },
      ];
      if (terms.digits !== null && terms.digits !== "") {
        alternatives.push({
          apartment: { number: { startsWith: terms.digits } },
        });
      }
      conditions.push({ OR: alternatives });
    }

    if (options.audience === "resident") {
      conditions.push({
        person: residentVisibilityWhere(options.viewerPersonId),
      });
    }

    return conditions.length === 0 ? {} : { AND: conditions };
  }

  /**
   * Persons with no residency: external board members, admins, and anyone the
   * board has entered but not yet moved in.
   *
   * Returns null when the filter cannot match such a person - a member, a
   * resident and a moved-out row all require a residency by definition - and
   * when a single house is selected, since a person with no apartment belongs to
   * no house.
   */
  private withoutApartmentWhere(
    query: AddressBookQuery,
    now: Date,
    terms: Awaited<ReturnType<AddressBookService["searchTerms"]>>,
    options: { audience: "board" | "resident"; viewerPersonId: string | null },
  ): Prisma.PersonWhereInput | null {
    if (query.addressId !== undefined) {
      return null;
    }
    if (query.filter !== "all" && query.filter !== "board") {
      return null;
    }

    const conditions: Prisma.PersonWhereInput[] = [
      { residencies: { none: {} } },
    ];

    if (query.filter === "board") {
      conditions.push({ boardPositions: { some: activeBoardPosition(now) } });
    }
    if (terms !== null) {
      conditions.push(this.personSearchWhere(terms));
    }
    if (options.audience === "resident") {
      conditions.push(residentVisibilityWhere(options.viewerPersonId));
    }

    return { AND: conditions };
  }

  /** Row count per filter tab, within the current scope and search. */
  private async counts(
    query: AddressBookQuery,
    now: Date,
    terms: Awaited<ReturnType<AddressBookService["searchTerms"]>>,
    options: { audience: "board" | "resident"; viewerPersonId: string | null },
  ): Promise<Record<AddressBookFilter, number>> {
    const entries = await Promise.all(
      ADDRESS_BOOK_FILTERS.map(async (filter) => {
        const scoped = { ...query, filter };
        const withoutApartment = this.withoutApartmentWhere(
          scoped,
          now,
          terms,
          options,
        );
        const [residencies, persons] = await Promise.all([
          this.prisma.residency.count({
            where: this.residencyWhere(scoped, now, terms, options),
          }),
          withoutApartment === null
            ? Promise.resolve(0)
            : this.prisma.person.count({ where: withoutApartment }),
        ]);
        return [filter, residencies + persons] as const;
      }),
    );

    return Object.fromEntries(entries) as Record<AddressBookFilter, number>;
  }

  /**
   * The header stats line.
   *
   * Counts distinct persons rather than rows, so a member holding two
   * apartments counts once - "68 persons" has to mean sixty-eight people.
   */
  private async stats(
    query: AddressBookQuery,
    now: Date,
    options: { audience: "board" | "resident"; viewerPersonId: string | null },
  ): Promise<AddressBookStats> {
    const scope: Prisma.ResidencyWhereInput =
      query.addressId === undefined
        ? {}
        : { apartment: { addressId: query.addressId } };

    // The head count follows the same visibility rule as the rows below it. A
    // resident whose board lists three names must not read "four persons" in the
    // line above them: the difference would count the protected people the
    // register is hiding from them.
    const visible: Prisma.PersonWhereInput[] =
      options.audience === "resident"
        ? [residentVisibilityWhere(options.viewerPersonId)]
        : [];

    const [apartments, persons, members] = await Promise.all([
      this.prisma.apartment.count({
        where:
          query.addressId === undefined ? {} : { addressId: query.addressId },
      }),
      this.prisma.person.count({
        where: {
          AND: [
            ...visible,
            { residencies: { some: { AND: [scope, activeResidency(now)] } } },
          ],
        },
      }),
      this.prisma.person.count({
        where: {
          AND: [
            ...visible,
            {
              residencies: {
                some: {
                  AND: [scope, activeResidency(now), { role: "MEMBER" }],
                },
              },
            },
          ],
        },
      }),
    ]);

    return { apartments, persons, members };
  }
}

export interface ApartmentResidencyView {
  residencyId: string;
  personId: string;
  name: string;
  protectedPersonalData: boolean;
  role: AddressBookRecord["role"];
  movedInOn: string | null;
  movedOutOn: string | null;
}

export interface ApartmentDetail {
  id: string;
  number: string;
  floor: number | null;
  /** Participation share (andelstal) as a decimal string, or null. */
  participationShare: string | null;
  address: {
    id: string;
    street: string;
    number: string;
    postalCode: string;
    city: string;
  };
  residents: ApartmentResidencyView[];
  history: ApartmentResidencyView[];
}

/**
 * A residency that still grants access.
 *
 * A move-out date in the future is a scheduled move-out and does not end the
 * residency yet. Kept identical to PrincipalService's definition: the register
 * and the authorization layer must agree on who lives here.
 */
function activeResidency(now: Date): Prisma.ResidencyWhereInput {
  return { OR: [{ movedOutOn: null }, { movedOutOn: { gt: now } }] };
}

function movedOutResidency(now: Date): Prisma.ResidencyWhereInput {
  return { movedOutOn: { not: null, lte: now } };
}

function activeBoardPosition(now: Date): Prisma.BoardPositionWhereInput {
  return { OR: [{ endedOn: null }, { endedOn: { gt: now } }] };
}

/**
 * What a resident may see of other people.
 *
 * Protected persons are excluded from resident-facing lists entirely (plan
 * 4.4), with the viewer's own entry as the single exception.
 */
function residentVisibilityWhere(
  viewerPersonId: string | null,
): Prisma.PersonWhereInput {
  if (viewerPersonId === null) {
    return { protectedPersonalData: false };
  }
  return {
    OR: [{ protectedPersonalData: false }, { id: viewerPersonId }],
  };
}
