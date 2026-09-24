import { Injectable } from "@nestjs/common";
import {
  dateColumnOf,
  formatLocalDay,
  type LocalDay,
  localDayOf,
  localDayOfColumn,
  scanForPersonalIdentityNumbers,
} from "@openbrf/shared";

import { AuditLogService } from "../audit/audit-log.service";
import type { Principal } from "../authorization/capabilities";
import { authorViewOf, type ChatAuthorView } from "../chat/chat.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import type {
  ApartmentDocumentAudience,
  ApartmentDocumentFiler,
  ApartmentDocumentKind,
} from "../generated/prisma/enums";
import { MediaService, mediaUrl } from "../media/media.service";
import { residencyHeldOn } from "../registers/held-on";
import {
  ApartmentBinderError,
  type BinderTextLocation,
} from "./apartment-binder.error";

/**
 * The longest title an entry may carry.
 *
 * A title is what the entry is called on the screen - "Ritning badrum 2019",
 * "Tillstand stambyte" - so it is a line rather than a description, on the
 * archive's own bound for the same field.
 */
export const BINDER_TITLE_MAX_LENGTH = 200;

/**
 * How many bytes of papers one apartment's binder may hold.
 *
 * A bound rather than a product rule, and it exists because nothing else bounds
 * it: an upload is capped at the instance's own limit, which is ten megabytes by
 * default, and one household filing all day would otherwise fill the
 * association's disk ten megabytes at a time. Counted from the stored byte
 * sizes of the apartment's entries on every filing rather than kept as a
 * running total, so it cannot drift away from what is actually there.
 *
 * A quarter of a gigabyte is far past what a home generates - drawings, a
 * handful of permissions, the manuals for what is installed - and a long way
 * below what makes a disk a problem.
 */
export const BINDER_BYTES_PER_APARTMENT = 256 * 1024 * 1024;

/**
 * The kinds only the board may file.
 *
 * What the binder is worth to the next holder is that "tillstand" means the
 * board said so. A tenant-owner able to file a document of that kind would put
 * two things on the screen that look alike and mean different things, and the
 * entry would say it was filed by a tenant-owner while claiming to be a
 * decision of the board's. The database refuses the combination as well.
 */
const KINDS_THE_BOARD_FILES_ALONE: readonly ApartmentDocumentKind[] = [
  "ALTERATION_PERMISSION",
];

/**
 * The kinds that must carry their day.
 *
 * A permission under BRL 7 kap. 7 § is a decision, and a decision has the day
 * it was taken: without it the entry could not be read against an alteration
 * the association later has to judge under 7 kap. 12 a § or 18 § 9. The other
 * kinds carry a date where there is one to carry.
 */
const KINDS_THAT_CARRY_THEIR_DAY: readonly ApartmentDocumentKind[] = [
  "ALTERATION_PERMISSION",
];

/**
 * Who an entry is shown to, as the serving path enforces it.
 *
 * Two records of one decision, like the archive's audience and visibility: the
 * audience is what the binder shows, and the visibility is what decides the
 * bytes. Both are written in one act, and `apartmentBinder:manage` is named on
 * the file either way - it widens rather than narrows here, which is what puts
 * every board read of a household's papers in the audit log.
 */
function transportFor(audience: ApartmentDocumentAudience): {
  visibility: "TENANT_OWNERS" | "HOUSEHOLD";
} {
  return {
    visibility: audience === "TENANT_OWNERS" ? "TENANT_OWNERS" : "HOUSEHOLD",
  };
}

/** One entry, as whoever lives in the apartment is shown it. */
export interface BinderEntryView {
  id: string;
  kind: ApartmentDocumentKind;
  audience: ApartmentDocumentAudience;
  title: string;
  /** The day on the entry, as a calendar date. Null where it carries none. */
  datedOn: string | null;
  /**
   * In what capacity it was filed.
   *
   * All a household is ever shown about who filed an entry. A binder names
   * nobody: one rule for every household is simpler to keep true than a rule
   * with an exception for people who live together, and it is the rule that
   * protects a tenant-owner with protected personal data without a branch for
   * them.
   */
  filedAs: ApartmentDocumentFiler;
  /** Whether the reader filed it themselves, which is what offers "Ta ut". */
  filedByYou: boolean;
  fileName: string;
  contentType: string;
  byteSize: number;
  /**
   * Where the file is fetched: a path on this instance's own origin, served by
   * the media route, which decides for itself whether the caller may have it.
   */
  url: string;
  /** ISO instant. */
  filedAt: string;
}

/** One entry, as the board is shown it. */
export interface BoardBinderEntryView extends Omit<
  BinderEntryView,
  "filedByYou"
> {
  /**
   * Who filed it, through the same named-to-nobody shape the chat exports: a
   * person with protected personal data is named to nobody, and a link the
   * purge has detached is reported as unknown rather than as an empty name.
   */
  filedBy: ChatAuthorView;
}

/** One apartment's binder, as whoever lives there is shown it. */
export interface BinderView {
  apartmentId: string;
  apartment: string;
  /** Whether the reader holds the apartment, which is what offers the form. */
  isTenantOwner: boolean;
  entries: BinderEntryView[];
}

/** One apartment on the board's chooser. */
export interface BoardBinderSummaryView {
  apartmentId: string;
  apartment: string;
  entries: number;
}

/** One apartment's binder, as the board is shown it. */
export interface BoardBinderView {
  apartmentId: string;
  apartment: string;
  /**
   * How many people the binder is shown to today, as two counts.
   *
   * What lets a board see that a household it believes has left still reads
   * the binder: a move-out ends one residency and leaves the rest of the
   * household as it was, and only the board knows the partner has gone.
   */
  tenantOwners: number;
  otherResidents: number;
  entries: BoardBinderEntryView[];
}

export interface FileEntryInput {
  apartmentId: string;
  kind: ApartmentDocumentKind;
  audience: ApartmentDocumentAudience;
  title: string;
  /** A calendar date as YYYY-MM-DD, already parsed by the controller. */
  datedOn: LocalDay | null;
  bytes: Buffer;
  fileName: string;
  actor: Principal;
}

/**
 * The papers about one apartment, kept with the apartment.
 *
 * A binder (lagenhetsparm) belongs to the apartment and not to anybody who
 * lived there: its drawings, the board's alteration permissions under BRL 7 kap.
 * 7 §, what was done in it and when, inspections and manuals. Nothing
 * happens when the apartment changes hands - the next household reads it from
 * the day its residency begins, and the last one stops on the day its residency
 * ends, both decided by `residencyHeldOn` on the association's own calendar
 * (ADR 0014, ADR 0017).
 *
 * Two audiences, because a partner and a second-hand tenant are one residency
 * role in the register: an entry is for the tenant-owners (bostadsrattshavare)
 * or for the household (hushall). The service decides what is on somebody's
 * shelf; the bytes are decided again, on the same rule, by the media route,
 * which is the one route in the product that streams a stored file.
 */
@Injectable()
export class ApartmentBinderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * Every binder this person reads today, with the entries their role allows.
   *
   * Almost always one apartment. The audience filter is part of the query
   * rather than applied to what came back: an entry for the tenant-owners of an
   * apartment where this person is a lodger is one the database never hands
   * over, so there is no filtered-in-memory list to get wrong later.
   */
  async mine(viewer: Principal): Promise<BinderView[]> {
    const today = localDayOf(new Date());
    const residencies = await this.prisma.residency.findMany({
      where: { personId: viewer.personId, ...residencyHeldOn(today) },
      select: {
        role: true,
        apartmentId: true,
        apartment: {
          select: { number: true, address: { select: FULL_ADDRESS } },
        },
      },
    });

    if (residencies.length === 0) {
      return [];
    }

    const apartments = new Map<
      string,
      { apartment: string; isTenantOwner: boolean }
    >();
    for (const residency of residencies) {
      const existing = apartments.get(residency.apartmentId);
      apartments.set(residency.apartmentId, {
        apartment: apartmentLabel(residency.apartment),
        isTenantOwner:
          (existing?.isTenantOwner ?? false) || residency.role === "MEMBER",
      });
    }

    const held: string[] = [];
    const livedIn: string[] = [];
    for (const [apartmentId, entry] of apartments) {
      (entry.isTenantOwner ? held : livedIn).push(apartmentId);
    }

    const rows = await this.prisma.apartmentDocument.findMany({
      where: {
        OR: [
          { apartmentId: { in: held } },
          { apartmentId: { in: livedIn }, audience: "HOUSEHOLD" },
        ],
      },
      orderBy: ENTRY_ORDER,
      select: ENTRY_SELECT,
    });

    return [...apartments].map(([apartmentId, entry]) => ({
      apartmentId,
      apartment: entry.apartment,
      isTenantOwner: entry.isTenantOwner,
      entries: rows
        .filter((row) => row.apartmentId === apartmentId)
        .map((row) => ({
          ...toEntryView(row),
          filedByYou: row.filedByPersonId === viewer.personId,
        })),
    }));
  }

  /**
   * Files one entry for a tenant-owner.
   *
   * Every refusal comes before a byte is stored, and the last of them is the
   * room in the binder: an upload that was going to be refused should not have
   * cost the disk it was refused for.
   */
  async file(input: FileEntryInput): Promise<BinderEntryView> {
    const today = localDayOf(new Date());
    const holds = await this.prisma.residency.count({
      where: {
        personId: input.actor.personId,
        apartmentId: input.apartmentId,
        role: "MEMBER",
        ...residencyHeldOn(today),
      },
    });
    if (holds === 0) {
      // An apartment that is not there and one that is not this person's are
      // one answer: a refusal naming the difference would confirm which
      // apartments exist and who holds them.
      throw new ApartmentBinderError("No such apartment binder.", "not-found");
    }

    if (KINDS_THE_BOARD_FILES_ALONE.includes(input.kind)) {
      throw new ApartmentBinderError(
        "That kind of entry is filed by the board.",
        "kind-is-the-boards",
      );
    }

    return this.store(input, "TENANT_OWNER");
  }

  /**
   * Takes out an entry this person filed, on an apartment they still hold.
   *
   * A tenant-owner may take out what they filed for as long as they hold the
   * apartment, and not afterwards: what is left stays with the apartment, which
   * is what the form says when they file it. Anything else is the same
   * not-found as an entry that does not exist.
   */
  async takeOut(id: string, viewer: Principal): Promise<void> {
    const today = localDayOf(new Date());
    const entry = await this.prisma.apartmentDocument.findFirst({
      where: {
        id,
        filedByPersonId: viewer.personId,
        filedAs: "TENANT_OWNER",
        apartment: {
          residencies: {
            some: {
              personId: viewer.personId,
              role: "MEMBER",
              ...residencyHeldOn(today),
            },
          },
        },
      },
      select: { mediaFileId: true },
    });
    if (entry === null) {
      throw new ApartmentBinderError("No such entry.", "not-found");
    }

    await this.media.remove(entry.mediaFileId, viewer.personId, "WEB", {
      recordFileName: false,
    });
  }

  /** Every apartment, with how many entries its binder holds. */
  async binders(): Promise<BoardBinderSummaryView[]> {
    const apartments = await this.prisma.apartment.findMany({
      orderBy: [
        { address: { street: "asc" } },
        { address: { number: "asc" } },
        { number: "asc" },
      ],
      select: {
        id: true,
        number: true,
        address: { select: FULL_ADDRESS },
        _count: { select: { apartmentDocuments: true } },
      },
    });

    return apartments.map((apartment) => ({
      apartmentId: apartment.id,
      apartment: apartmentLabel(apartment),
      entries: apartment._count.apartmentDocuments,
    }));
  }

  /**
   * One apartment's whole binder, with who reads it today.
   *
   * Audited, and audited here rather than only where the bytes leave. The
   * listing is the sensitive read: a title states what was done in somebody's
   * home - "Tillstand badrum anpassat for rullstol" - which is the health
   * category the record of processing activities declares for this activity,
   * and it is answered whether or not a file is then opened. Without an entry
   * here a board member could walk every apartment's binder and leave no trace,
   * and the glossary's promise that every board read of a binder is audited
   * would be true of the files and false of the listing.
   *
   * This is not the members' shelf, whose serves `MediaService.open`
   * deliberately does not log. That argument is about volume burying the
   * entries the law needs - members read the bylaws and the annual report as a
   * matter of course. A board opening one home's papers is the opposite: rare,
   * and precisely the access that has to be accountable.
   *
   * `withAuditedRead` rather than a `record` afterwards, so the answer and the
   * entry commit together: a read that was served without its entry being
   * written is the one outcome this cannot have.
   *
   * The chooser, {@link binders}, is not audited. It answers apartment
   * designations and a count each, and reads nobody's papers.
   */
  async binder(
    apartmentId: string,
    actorPersonId: string,
  ): Promise<BoardBinderView> {
    const apartment = await this.prisma.apartment.findUnique({
      where: { id: apartmentId },
      select: { id: true, number: true, address: { select: FULL_ADDRESS } },
    });
    if (apartment === null) {
      // Before the audited read, so an apartment that does not exist writes no
      // entry: the log records disclosures, and nothing was disclosed.
      throw new ApartmentBinderError("No such apartment binder.", "not-found");
    }

    const today = localDayOf(new Date());

    return this.audit.withAuditedRead(
      {
        action: "APARTMENT_BINDER_READ",
        channel: "WEB",
        actorPersonId,
        targetKind: "apartmentBinder",
        targetId: apartmentId,
        // How much was disclosed, never what. The log is append-only and
        // exempt from every purge, so a title copied here would outlive the
        // entry it described and the household that filed it.
        context: { entries: await this.entryCount(apartmentId) },
      },
      async (tx) => {
        const [rows, residencies] = await Promise.all([
          tx.apartmentDocument.findMany({
            where: { apartmentId },
            orderBy: ENTRY_ORDER,
            select: ENTRY_SELECT,
          }),
          tx.residency.findMany({
            where: { apartmentId, ...residencyHeldOn(today) },
            select: { role: true },
          }),
        ]);

        const filers = await this.filersOf(rows, tx);

        return {
          apartmentId: apartment.id,
          apartment: apartmentLabel(apartment),
          tenantOwners: residencies.filter((row) => row.role === "MEMBER")
            .length,
          otherResidents: residencies.filter((row) => row.role !== "MEMBER")
            .length,
          entries: rows.map((row) => ({
            ...toEntryView(row),
            filedBy:
              row.filedByPersonId === null
                ? { kind: "unknown" }
                : authorViewOf(
                    row.filedByPersonId,
                    filers.get(row.filedByPersonId),
                  ),
          })),
        };
      },
    );
  }

  /** How many entries the apartment's binder holds, for the audit entry. */
  private async entryCount(apartmentId: string): Promise<number> {
    return this.prisma.apartmentDocument.count({ where: { apartmentId } });
  }

  /** Files one entry as the board, into any apartment's binder. */
  async fileAsBoard(input: FileEntryInput): Promise<BinderEntryView> {
    const apartment = await this.prisma.apartment.count({
      where: { id: input.apartmentId },
    });
    if (apartment === 0) {
      throw new ApartmentBinderError("No such apartment binder.", "not-found");
    }

    return this.store(input, "BOARD");
  }

  /** Takes out any entry, which is how an art. 17 request about one is met. */
  async takeOutAsBoard(id: string, actorPersonId: string): Promise<void> {
    const entry = await this.prisma.apartmentDocument.findUnique({
      where: { id },
      select: { mediaFileId: true },
    });
    if (entry === null) {
      throw new ApartmentBinderError("No such entry.", "not-found");
    }

    await this.media.remove(entry.mediaFileId, actorPersonId, "WEB", {
      recordFileName: false,
    });
  }

  /**
   * The checks every filing shares, then the file and then the row.
   *
   * The file is stored before the entry and removed again if the entry cannot
   * be written, for the reason the media service gives about bytes and rows:
   * this order can only ever leave an unreferenced object, while the other
   * would leave an entry pointing at nothing.
   */
  private async store(
    input: FileEntryInput,
    filedAs: ApartmentDocumentFiler,
  ): Promise<BinderEntryView> {
    if (
      KINDS_THAT_CARRY_THEIR_DAY.includes(input.kind) &&
      input.datedOn === null
    ) {
      throw new ApartmentBinderError(
        "That kind of entry carries the day it was decided.",
        "date-required",
      );
    }

    refusePersonalIdentityNumbers(input.title, input.fileName);

    /*
     * Counted from what is stored rather than from a running total, and counted
     * before the upload: the refusal is about the room the binder has, and an
     * upload refused for room should not have cost the room first.
     */
    const used = await this.bytesInBinder(input.apartmentId);
    if (used + input.bytes.length > BINDER_BYTES_PER_APARTMENT) {
      throw new ApartmentBinderError(
        "The binder for that apartment is full.",
        "binder-full",
      );
    }

    const transport = transportFor(input.audience);
    const file = await this.media.upload({
      bytes: input.bytes,
      fileName: input.fileName,
      accept: "document",
      visibility: transport.visibility,
      requiredCapability: "apartmentBinder:manage",
      apartmentId: input.apartmentId,
      uploadedByPersonId: input.actor.personId,
      // The household's own words about its own home, in a table the purge
      // cannot reach. The name is on the row and in the disposition either way.
      recordFileName: false,
      channel: "WEB",
      prefix: "binder",
    });

    try {
      const entry = await this.prisma.apartmentDocument.create({
        data: {
          apartmentId: input.apartmentId,
          kind: input.kind,
          audience: input.audience,
          title: input.title.trim(),
          datedOn: input.datedOn === null ? null : dateColumnOf(input.datedOn),
          filedAs,
          filedByPersonId: input.actor.personId,
          mediaFileId: file.id,
        },
        select: ENTRY_SELECT,
      });

      return { ...toEntryView(entry), filedByYou: true };
    } catch (cause) {
      // The upload is already in the audit log, and so is this removal. That
      // pair is the honest record of what happened.
      await this.media
        .remove(file.id, input.actor.personId, "WEB", {
          recordFileName: false,
        })
        .catch(() => {
          /* Reported by the media service; the original failure is the one to
             raise. */
        });
      throw cause;
    }
  }

  /** How many bytes of files the apartment's entries already hold. */
  private async bytesInBinder(apartmentId: string): Promise<number> {
    const total = await this.prisma.mediaFile.aggregate({
      where: { apartmentDocument: { apartmentId } },
      _sum: { byteSize: true },
    });
    return total._sum.byteSize ?? 0;
  }

  /** The people the entries name, for the board's view of who filed what. */
  private async filersOf(
    rows: readonly { filedByPersonId: string | null }[],
    client: PrismaService | Prisma.TransactionClient = this.prisma,
  ): Promise<Map<string, FilerRecord>> {
    const ids = [
      ...new Set(
        rows
          .map((row) => row.filedByPersonId)
          .filter((id): id is string => id !== null),
      ),
    ];
    if (ids.length === 0) {
      return new Map();
    }

    const persons = await client.person.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        protectedPersonalData: true,
      },
    });

    return new Map(persons.map((person) => [person.id, person]));
  }
}

/** What the board's view needs of a person to attribute an entry to them. */
interface FilerRecord {
  id: string;
  firstName: string;
  lastName: string;
  protectedPersonalData: boolean;
}

const FULL_ADDRESS = {
  street: true,
  number: true,
} satisfies Prisma.AddressSelect;

/**
 * The order a binder is read in: by kind, then newest first within a kind.
 *
 * The kind order is the enum's own, which is the order the kinds are offered
 * in. Entries with no day sort after the dated ones rather than before them,
 * because a day is what a reader looks for first.
 */
const ENTRY_ORDER: Prisma.ApartmentDocumentOrderByWithRelationInput[] = [
  { kind: "asc" },
  { datedOn: { sort: "desc", nulls: "last" } },
  { createdAt: "desc" },
];

const ENTRY_SELECT = {
  id: true,
  apartmentId: true,
  kind: true,
  audience: true,
  title: true,
  datedOn: true,
  filedAs: true,
  filedByPersonId: true,
  createdAt: true,
  mediaFile: {
    select: {
      id: true,
      fileName: true,
      contentType: true,
      byteSize: true,
    },
  },
} satisfies Prisma.ApartmentDocumentSelect;

/** One entry row, in the shape every reader is answered in. */
interface EntryRow {
  id: string;
  kind: ApartmentDocumentKind;
  audience: ApartmentDocumentAudience;
  title: string;
  datedOn: Date | null;
  filedAs: ApartmentDocumentFiler;
  filedByPersonId: string | null;
  createdAt: Date;
  mediaFile: {
    id: string;
    fileName: string;
    contentType: string;
    byteSize: number;
  };
}

function toEntryView(row: EntryRow): Omit<BinderEntryView, "filedByYou"> {
  return {
    id: row.id,
    kind: row.kind,
    audience: row.audience,
    title: row.title,
    datedOn:
      row.datedOn === null
        ? null
        : formatLocalDay(localDayOfColumn(row.datedOn)),
    filedAs: row.filedAs,
    fileName: row.mediaFile.fileName,
    contentType: row.mediaFile.contentType,
    byteSize: row.mediaFile.byteSize,
    url: mediaUrl(row.mediaFile.id),
    filedAt: row.createdAt.toISOString(),
  };
}

function apartmentLabel(apartment: {
  number: string;
  address: { street: string; number: string };
}): string {
  return `${apartment.address.street} ${apartment.address.number} ${apartment.number}`;
}

/**
 * Refuses a filing whose text carries a Swedish personal identity number.
 *
 * The same rule a message, a page, a news item and a comment live under. A
 * binder is read by whoever holds the apartment next, so a number written into
 * one would be a copy of register content in a service-tier record the
 * register's own rules do not reach - and one the next household would read.
 *
 * The title and the file name both. The file name is not decoration: it is
 * stored on the row, answered in every listing and echoed in the download
 * disposition, so `19811218-9876_besiktning.pdf` discloses exactly what a title
 * carrying the same digits would, with no retention clock on it.
 * `safeFileName` strips characters and looks at nothing.
 *
 * The file's own contents cannot be scanned: nothing in the product reads a
 * PDF's text. The form says so, which is the honest version of a guarantee the
 * platform cannot give.
 *
 * Exported so the rule can be asserted directly rather than only through a
 * filing.
 */
export function refusePersonalIdentityNumbers(
  title: string,
  fileName = "",
): void {
  const locations = [
    ...scanForPersonalIdentityNumbers(title).map((hit): BinderTextLocation => ({
      part: "title",
      offset: hit.index,
    })),
    ...scanForPersonalIdentityNumbers(fileName).map(
      (hit): BinderTextLocation => ({ part: "fileName", offset: hit.index }),
    ),
  ];

  if (locations.length > 0) {
    throw new ApartmentBinderError(
      "The filing carries a personal identity number and cannot be written.",
      "personal-identity-number",
      locations,
    );
  }
}
