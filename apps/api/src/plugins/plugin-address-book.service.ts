import { Injectable } from "@nestjs/common";
import type {
  PluginAddressBookCaller,
  PluginApartment,
  PluginNonResident,
  PluginNonResidentCaller,
  PluginOccupancySummary,
  PluginResident,
  PluginResidentFilter,
} from "@openbrf/plugin-sdk";
import { formatDateColumn, type LocalDay, localDayOf } from "@openbrf/shared";

import { hasStandingConsent } from "../address-book/publication-consent";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { pluginProcessorKey } from "../data-protection/processor-key";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import {
  boardSeatHeldOn,
  residencyEndedBy,
  residencyHeldOn,
} from "../registers/held-on";
import { extensionHostOf } from "./extension-call";
import { servedNonResidentCallers } from "./resident-routes-consent";

/** The connection or a transaction, for a read that has to be true inside one. */
type PersonReadClient = Pick<
  Prisma.TransactionClient,
  "person" | "residency" | "installedPlugin"
>;

/**
 * The persons a plugin may read at all.
 *
 * Protected personal data has never reached a plugin. A restriction (GDPR art.
 * 18) is excluded for a narrower reason: handing the row to code the
 * association installed is a use, and art. 18(2) permits storage rather than
 * use. And a person whose objection to this plugin's processing the board
 * granted (art. 21, ADR 0035) is excluded because the association has stopped
 * that processing for them - absent rather than flagged, so the plugin is not
 * told that anybody objected and cannot list who did. While the plugin answers
 * a host plugin's extension point, what it reads goes on to the host plugin,
 * so an objection to the host plugin's processing leaves the person out too.
 *
 * One definition for every read, so the count in the summary and the rows in
 * the list cannot disagree about who is there.
 */
function readableBy(pluginId: string): Prisma.PersonWhereInput {
  const hostPlugin = extensionHostOf(pluginId);
  const objectedTo = (
    hostPlugin === null ? [pluginId] : [pluginId, hostPlugin]
  ).map(pluginProcessorKey);
  return {
    protectedPersonalData: false,
    processingRestrictedAt: null,
    dataSubjectRequests: {
      none: {
        kind: "OBJECTION",
        decision: "GRANTED",
        closedAt: null,
        processingActivity: { sourceKey: { in: objectedTo } },
      },
    },
  };
}

/**
 * The persons a plugin's resident routes are for, before the three refusals
 * (ADR 0053): who holds a residency today, and, unless they are a former
 * resident, who is in one of the classes the plugin serves, as the host's own
 * records say on the association's day.
 *
 * The second half of {@link servedBy}, and what the navigation asks alone: it
 * offers a plugin's view on it, and leaves the refusals to the routes.
 *
 * A former resident is a person with a residency that has ended and none held
 * today, and is in no class, whatever seat or role they keep. The move-out date
 * is the first day a residency is not held, so they are one from the start of
 * that day. A person whose only residency begins later has not had one, and is
 * not. `pluginAccess` matches nobody until the host keeps plugin accesses, and
 * an empty list of classes matches residents alone.
 *
 * Not exported: who a plugin serves is asked through the service's methods,
 * so the guard, `caller`, `nonResidents()` and the subject rule all ask it in
 * the same form.
 */
function offeredBy(
  classes: readonly PluginNonResidentCaller[],
  day: LocalDay,
): Prisma.PersonWhereInput {
  const holdsResidency: Prisma.PersonWhereInput = {
    residencies: { some: residencyHeldOn(day) },
  };
  const inClass = classes.flatMap((caller): Prisma.PersonWhereInput[] => {
    switch (caller) {
      case "board":
        return [{ boardPositions: { some: boardSeatHeldOn(day) } }];
      case "administrator":
        return [{ systemRoles: { some: { role: "ADMIN" } } }];
      case "propertyManager":
        return [{ systemRoles: { some: { role: "PROPERTY_MANAGER" } } }];
      case "pluginAccess":
        return [];
    }
  });
  if (inClass.length === 0) {
    return holdsResidency;
  }
  return {
    OR: [
      holdsResidency,
      {
        // Not a former resident: no residency has ended. A residency held
        // today is the arm above, so here the person holds none.
        residencies: { none: residencyEndedBy(day) },
        OR: inClass,
      },
    ],
  };
}

/**
 * The persons a plugin serves on its resident routes (ADR 0053): the three
 * refusals, and then a residency held today or a class the plugin serves.
 *
 * `readable AND (resident OR class)`, never `(resident AND readable) OR
 * class`: no seat, role or access lifts one of the refusals. One `where`, so
 * the refusals and the classes are decided in the one query that reads the
 * person, and nothing combines two answers.
 */
function servedBy(
  pluginId: string,
  classes: readonly PluginNonResidentCaller[],
  day: LocalDay,
): Prisma.PersonWhereInput {
  return { AND: [readableBy(pluginId), offeredBy(classes, day)] };
}

/** What a plugin reads of a residency `residents()` lists. */
const listedResidency = {
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
} as const satisfies Prisma.ResidencySelect;

/** The order `residents()` lists residencies in, so `caller` gives its first. */
const listedResidencyOrder = [
  { apartment: { address: { sortOrder: "asc" } } },
  { apartment: { number: "asc" } },
  { id: "asc" },
] as const satisfies Prisma.ResidencyOrderByWithRelationInput[];

/** What a plugin reads of a person `residents()` lists. */
function listedPerson(contact: boolean) {
  return {
    id: true,
    firstName: true,
    lastName: true,
    emailCipher: contact,
    phoneCipher: contact,
    /*
     * A standing objection (art. 21). The row still travels - the plugin is
     * entitled to know who lives here - but the contact details do not,
     * because the association has decided not to defend a legitimate interest
     * in messaging this person, and a plugin given the address could message
     * them anyway.
     */
    communicationObjectionAt: true,
    /*
     * The one scope a plugin is told about, and only as a yes or a no:
     * whether the name may be shown on screens in the building.
     */
    publicationConsents: {
      where: { scope: "NAME_IN_BUILDING" },
      select: { scope: true, grantedAt: true, withdrawnAt: true },
    },
  } as const satisfies Prisma.PersonSelect;
}

/** A person as read with {@link listedPerson}, whether or not contact was. */
type ListedPersonRow = Prisma.PersonGetPayload<{
  select: ReturnType<typeof listedPerson>;
}>;

/** A residency as read with {@link listedResidency}. */
type ListedResidencyRow = Prisma.ResidencyGetPayload<{
  select: typeof listedResidency;
}>;

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
 *   never appears to that plugin, nor, while the plugin answers a host
 *   plugin's extension point, one with a standing objection to the host
 *   plugin's. Which plugin is reading is the host's to say, never the
 *   plugin's: every method takes the id the host object was built for, and
 *   the call it answers is the scope the host ran its handler in.
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
    options: {
      contact: boolean;
      filter?: PluginResidentFilter;
      /** Only this person's residencies: the host's, never the plugin's. */
      personId?: string;
    },
    now: Date = new Date(),
  ): Promise<PluginResident[]> {
    const addressId = options.filter?.addressId;
    const rows = await this.prisma.residency.findMany({
      where: {
        ...residencyHeldOn(localDayOf(now)),
        ...(addressId === undefined ? {} : { apartment: { addressId } }),
        ...(options.personId === undefined
          ? {}
          : { personId: options.personId }),
        person: readableBy(pluginId),
      },
      orderBy: [...listedResidencyOrder],
      select: {
        ...listedResidency,
        person: { select: listedPerson(options.contact) },
      },
    });

    return Promise.all(
      rows.map((row) => this.residentOf(row, row.person, options)),
    );
  }

  /** A residency and its person as `residents()` gives them to a plugin. */
  private async residentOf(
    residency: ListedResidencyRow,
    person: ListedPersonRow,
    options: { contact: boolean },
  ): Promise<PluginResident> {
    const base: PluginResident = {
      personId: person.id,
      name: `${person.firstName} ${person.lastName}`.trim(),
      lastName: person.lastName,
      role: residency.role,
      apartment: residency.apartment,
      movedInOn: formatDateColumn(residency.movedInOn),
      movedOutOn: formatDateColumn(residency.movedOutOn),
      nameInBuilding: hasStandingConsent(
        person.publicationConsents,
        "NAME_IN_BUILDING",
      ),
    };

    return { ...base, ...(await this.contactOf(person, options)) };
  }

  /** A person as `nonResidents()` gives them to a plugin: no apartment. */
  private async nonResidentOf(
    person: {
      id: string;
      firstName: string;
      lastName: string;
      emailCipher?: string | null;
      phoneCipher?: string | null;
      communicationObjectionAt: Date | null;
    },
    options: { contact: boolean },
  ): Promise<PluginNonResident> {
    return {
      personId: person.id,
      name: `${person.firstName} ${person.lastName}`.trim(),
      lastName: person.lastName,
      ...(await this.contactOf(person, options)),
    };
  }

  /**
   * The persons this plugin serves who hold no residency today (ADR 0053):
   * `host.addressBook.nonResidents()`, and the person `caller` answers as
   * `nonResident`.
   *
   * The same predicate the guard asks ({@link servedBy}), the three refusals
   * and the former residents included, with the residents taken out, so no
   * person is both here and in `residents()`. None where the plugin serves no
   * class. The classes are the host's to pass, as for {@link isServed}.
   * Contact details on the terms of `residents()`.
   */
  async nonResidents(
    pluginId: string,
    classes: readonly PluginNonResidentCaller[],
    options: {
      contact: boolean;
      /** Only this person: the host's, never the plugin's. */
      personId?: string;
    },
    now: Date = new Date(),
  ): Promise<PluginNonResident[]> {
    if (classes.length === 0) {
      return [];
    }
    const day = localDayOf(now);
    const rows = await this.prisma.person.findMany({
      where: {
        ...(options.personId === undefined ? {} : { id: options.personId }),
        AND: [
          servedBy(pluginId, classes, day),
          { residencies: { none: residencyHeldOn(day) } },
        ],
      },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }, { id: "asc" }],
      select: {
        id: true,
        firstName: true,
        lastName: true,
        emailCipher: options.contact,
        phoneCipher: options.contact,
        communicationObjectionAt: true,
      },
    });

    return Promise.all(rows.map((row) => this.nonResidentOf(row, options)));
  }

  /**
   * A person's contact details as a plugin reads them, or no keys at all
   * without addressBook:readContact.
   */
  private async contactOf(
    person: {
      emailCipher?: string | null;
      phoneCipher?: string | null;
      communicationObjectionAt: Date | null;
    },
    options: { contact: boolean },
  ): Promise<{ email?: string | null; phone?: string | null }> {
    if (!options.contact) {
      // The keys are absent rather than null: a plugin without the
      // permission should not be able to tell "no email on file" from
      // "not allowed to see the email".
      return {};
    }

    // Nullish rather than strict: a row read without the column selected
    // means "nothing recorded", not "objecting".
    if (person.communicationObjectionAt != null) {
      // Null rather than absent, and the difference is deliberate: the
      // plugin holds the permission, so it may tell "objected or nothing on
      // file" from "not allowed to see it".
      return { email: null, phone: null };
    }

    const [email, phone] = await Promise.all([
      person.emailCipher == null
        ? null
        : this.encryption.decrypt("person.email", person.emailCipher),
      person.phoneCipher == null
        ? null
        : this.encryption.decrypt("person.phone", person.phoneCipher),
    ]);

    return { email, phone };
  }

  /**
   * The person the host marked on a request: as `residents()` lists them to
   * this plugin, as `nonResidents()` does, or `notListed` (ADR 0047, ADR
   * 0053).
   *
   * A person served with a residency today is `listed`, whatever class they
   * also hold. One served in a class the plugin serves, with no residency
   * today, is `nonResident`, and the answer does not name the class. Whoever
   * neither list holds is `notListed` alike - a former resident, a person in
   * no class the plugin serves, a person with protected personal data, under a
   * restriction or objecting to this plugin - so the answer tells the plugin
   * nothing the lists do not. A person with two residencies today is answered
   * with the first the list would give.
   *
   * One query: the person as {@link servedBy} serves them, with the residency
   * held today that `residents()` would list first. Whether they are `listed`
   * or `nonResident` is read off that one row, so a residency that begins or
   * ends during the request cannot fall between two reads and leave a person
   * served before and after it `notListed` (ADR 0053).
   */
  async caller(
    pluginId: string,
    personId: string | null,
    classes: readonly PluginNonResidentCaller[],
    options: { contact: boolean },
    now: Date = new Date(),
  ): Promise<PluginAddressBookCaller> {
    if (personId === null) {
      return { kind: "notListed" };
    }
    const day = localDayOf(now);
    const person = await this.prisma.person.findFirst({
      where: { id: personId, ...servedBy(pluginId, classes, day) },
      select: {
        ...listedPerson(options.contact),
        residencies: {
          where: residencyHeldOn(day),
          orderBy: [...listedResidencyOrder],
          take: 1,
          select: listedResidency,
        },
      },
    });
    if (person === null) {
      return { kind: "notListed" };
    }
    const [residency] = person.residencies;
    if (residency !== undefined) {
      return {
        kind: "listed",
        resident: await this.residentOf(residency, person, options),
      };
    }
    return {
      kind: "nonResident",
      person: await this.nonResidentOf(person, options),
    };
  }

  /**
   * The classes of caller this plugin's resident routes serve (ADR 0053): the
   * ones its installed manifest declares that the install's consent approved,
   * read on each request, so a class stops being served as soon as the
   * approved set loses it. None for a plugin that is not installed.
   */
  async servedClasses(
    pluginId: string,
    declared: readonly PluginNonResidentCaller[],
    client: PersonReadClient = this.prisma,
  ): Promise<PluginNonResidentCaller[]> {
    if (declared.length === 0) {
      return [];
    }
    const install = await client.installedPlugin.findUnique({
      where: { id: pluginId },
      select: { consentedNonResidentCallers: true },
    });
    return servedNonResidentCallers(
      declared,
      install?.consentedNonResidentCallers ?? [],
    );
  }

  /**
   * Whether this plugin serves this person at this moment (ADR 0053): what
   * the guard asks before any of the plugin's code runs, and the subject rule
   * of a record or an audit entry about a person (ADR 0047 as amended).
   *
   * The three refusals first, then a residency held today or one of the
   * classes the plugin serves, which a former resident is in none of. The
   * classes are the host's to pass, from the manifest and the install's
   * consent (`servedNonResidentCallers`), never the plugin's. Asked on the
   * client a write runs on, so the answer is the one true where the record is
   * written.
   */
  async isServed(
    pluginId: string,
    personId: string,
    classes: readonly PluginNonResidentCaller[],
    now: Date = new Date(),
    client: PersonReadClient = this.prisma,
  ): Promise<boolean> {
    const served = await client.person.findFirst({
      where: {
        id: personId,
        ...servedBy(pluginId, classes, localDayOf(now)),
      },
      select: { id: true },
    });
    return served !== null;
  }

  /**
   * Whether the navigation offers this person a view of a plugin with
   * resident routes (ADR 0053): a residency held today, or one of the classes
   * the plugin serves and not a former resident.
   *
   * The second half of what {@link isServed} asks, without the three
   * refusals: the navigation is not where access is decided, and a refused
   * person is offered the entry and told by the view, as a refused resident
   * is (ADR 0051).
   */
  async isOffered(
    personId: string,
    classes: readonly PluginNonResidentCaller[],
    now: Date = new Date(),
  ): Promise<boolean> {
    const offered = await this.prisma.person.findFirst({
      where: { id: personId, ...offeredBy(classes, localDayOf(now)) },
      select: { id: true },
    });
    return offered !== null;
  }

  /**
   * The people this plugin may not read: those with protected personal data,
   * under a restriction, or whose objection to its processing stands.
   *
   * What decides which of its records about a person a plugin reads (ADR
   * 0047): a record about one of them is absent. Residency is not part of it,
   * so a former resident's records stay readable until their erase date. A
   * short list on any association, read whole rather than joined, because a
   * record's subject is a plain column with no relation to the person.
   */
  async withheldFrom(
    pluginId: string,
    client: PersonReadClient = this.prisma,
  ): Promise<Set<string>> {
    const persons = await client.person.findMany({
      where: { NOT: readableBy(pluginId) },
      select: { id: true },
    });
    return new Set(persons.map((person) => person.id));
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
