import { Injectable, Logger } from "@nestjs/common";

import type { Principal } from "../authorization/capabilities";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import type { IssueAudience, IssueStatus } from "../generated/prisma/enums";
import { mediaUrl, MediaService } from "../media/media.service";
import { IssueTypeService } from "./issue-type.service";
import { IssueError } from "./issue.error";

/**
 * How many photographs one report may carry.
 *
 * A bound on one report, and only on one report: every file is held in memory
 * while it is identified and checksummed, and a hundred images on a single
 * issue report are neither readable by whoever has to work it nor free to
 * serve.
 *
 * It is deliberately not a defence against filling the data volume, and reading
 * it as one would be a mistake: nothing caps how many reports an account may
 * file, so a resident who wanted the space could take it six photographs at a
 * time without ever meeting this number.
 */
export const MAX_PHOTOS_PER_ISSUE = 6;

export interface IssuePhotoView {
  id: string;
  /** A path on this instance's own origin, never an address at a bucket. */
  url: string;
  fileName: string;
  width: number | null;
  height: number | null;
}

export interface IssueApartmentView {
  id: string;
  number: string;
  /** "Storgatan 12", so a handler knows which entrance without a second call. */
  address: string;
}

/**
 * Who reported an issue, as whoever handles it may be told.
 *
 * Four cases, and the two that are not a plain name are the point of the type.
 *
 * `protected` is a person with protected personal data (skyddade
 * personuppgifter). Their name is withheld here even though the board's own
 * address book prints it: that register has a statutory reason to, and an issue
 * queue - which an external property manager reads - has none. A handler who
 * has to reach them goes through the board.
 *
 * `unknown` is a reporter reference that no longer resolves to a person. Issue
 * data is service tier and a person can be purged out from under it, so the
 * queue has to be able to say "we no longer know" rather than break.
 */
export type IssueReporterView =
  | { kind: "resident"; personId: string; name: string }
  | { kind: "protected"; personId: string }
  | { kind: "external"; name: string | null; email: string | null }
  | { kind: "unknown" };

export interface OwnIssueView {
  id: string;
  status: IssueStatus;
  typeId: string;
  typeName: string;
  location: string | null;
  description: string;
  apartment: IssueApartmentView | null;
  photos: IssuePhotoView[];
  createdAt: string;
  updatedAt: string;
}

export interface QueuedIssueView extends OwnIssueView {
  audience: IssueAudience;
  reporter: IssueReporterView;
}

export interface ReportIssueInput {
  typeId: string;
  /** The reporter's own apartment, when the issue is in one. */
  apartmentId?: string | null;
  location?: string | null;
  description: string;
}

/**
 * A report filed from the association's public website, by nobody in
 * particular.
 *
 * No apartment: the form is served before any sign-in and must not offer a
 * picker that enumerates the building to whoever loads the page (decision 28).
 * The free-text location covers everything an apartment number would have.
 *
 * No photograph either, and that is the same argument one step further: an
 * anonymous upload surface is a place to put files on somebody else's server,
 * and a passer-by reporting a broken door does not need one.
 *
 * The contact details are optional. Somebody who reports a fault in the street
 * owes the association nothing, and a form that refused the report without a
 * name would collect fewer reports rather than better ones.
 */
export interface ReportPublicIssueInput {
  typeId: string;
  location?: string | null;
  description: string;
  reporterName?: string | null;
  reporterEmail?: string | null;
}

/**
 * Reported issues: filing one, reading one's own, and the triage queue.
 *
 * Two properties are enforced here rather than left to the screens.
 *
 * The audience filter decides which type a report may be filed under, and it is
 * the same filter that decided which types to offer - a caller who posts an
 * identifier they were never shown is answered as if that type did not exist.
 *
 * A reporter reads their own reports and nobody else's. Everything else about
 * an issue - who else reported what, the internal ones - needs issues:handle,
 * which is the external property manager's single capability besides their own
 * account (decision 11).
 *
 * The description is free text and is deliberately neither scanned nor refused.
 * An issue report is exactly where health data and a third party's details turn
 * up without anyone intending it - a leak in a bathroom, a neighbour's
 * behaviour - and the answer to that is the warning the form carries, not a
 * refusal that would turn away the reports the module exists for. Nothing here
 * is published, and the publication guardrails that scan text apply to the
 * association's website, not to its private queue.
 */
@Injectable()
export class IssueService {
  private readonly logger = new Logger(IssueService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly types: IssueTypeService,
    private readonly media: MediaService,
    private readonly encryption: FieldEncryptionService,
  ) {}

  /** Files a report for a signed-in resident. */
  async report(
    principal: Principal,
    input: ReportIssueInput,
  ): Promise<{ id: string }> {
    const type = await this.types.requireReportable(principal, input.typeId);

    const apartmentId =
      input.apartmentId == null
        ? null
        : await this.requireOwnApartment(principal.personId, input.apartmentId);

    const issue = await this.prisma.issue.create({
      data: {
        typeId: type.id,
        reporterPersonId: principal.personId,
        apartmentId,
        location: input.location ?? null,
        description: input.description,
      },
      select: { id: true },
    });

    // The identifier and the type only. The description is the resident's own
    // account of their home and has no business in a log line.
    this.logger.log(`Reported issue ${issue.id} as ${type.audience}`);
    return issue;
  }

  /**
   * Files a report that arrived through the public website.
   *
   * The type is resolved through the same filter that decided which types to
   * offer the form, called with no principal: a caller posting an identifier
   * that was never on the page is answered as if that type did not exist, and
   * an association with public reporting switched off is refused here rather
   * than merely not shown a form. The switch is the rule; the missing form is
   * its consequence.
   *
   * The reporter's details are encrypted exactly as a sign-up request's are,
   * and the address carries a blind index so a second report from the same
   * person is recognisable as theirs.
   */
  async reportPublicly(input: ReportPublicIssueInput): Promise<{ id: string }> {
    const type = await this.types.requireReportable(null, input.typeId);

    const name =
      input.reporterName == null || input.reporterName === ""
        ? null
        : await this.encryption.encrypt(
            "issue.reporterName",
            input.reporterName,
          );
    const email =
      input.reporterEmail == null || input.reporterEmail === ""
        ? null
        : await this.encryption.encrypt(
            "issue.reporterEmail",
            input.reporterEmail,
          );

    const issue = await this.prisma.issue.create({
      data: {
        typeId: type.id,
        // No account behind it. The reporter reference stays null and the
        // contact fields carry whatever the person chose to leave.
        reporterPersonId: null,
        reporterNameCipher: name?.cipher ?? null,
        reporterEmailCipher: email?.cipher ?? null,
        reporterEmailIndex: email?.index ?? null,
        // Empty is nothing, exactly as it is for the name and the address
        // above: the form's location field is optional, so a visitor who
        // touched it and thought better of it must not leave the board an
        // issue whose location is present and blank.
        location:
          input.location == null || input.location === ""
            ? null
            : input.location,
        description: input.description,
      },
      select: { id: true },
    });

    // The identifier and the type. What a passer-by wrote about the building,
    // and who they said they were, has no business in a log line.
    this.logger.log(`Reported issue ${issue.id} from the public form`);
    return issue;
  }

  /** The reporter's own issues, newest first. */
  async listOwn(personId: string): Promise<OwnIssueView[]> {
    const issues = await this.prisma.issue.findMany({
      where: { reporterPersonId: personId },
      orderBy: { createdAt: "desc" },
      include: ISSUE_INCLUDE,
    });

    return issues.map((issue) => toOwnView(issue));
  }

  /**
   * The triage queue. Reached with issues:handle.
   *
   * Open issues first and oldest first within a status, because the queue is
   * worked from the top and the thing that has been waiting longest is the
   * thing to look at.
   */
  async listQueue(filter?: {
    status?: IssueStatus;
  }): Promise<QueuedIssueView[]> {
    const issues = await this.prisma.issue.findMany({
      where: filter?.status === undefined ? {} : { status: filter.status },
      orderBy: [{ status: "asc" }, { createdAt: "asc" }],
      include: ISSUE_INCLUDE,
    });

    const personIds = [
      ...new Set(
        issues
          .map((issue) => issue.reporterPersonId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const persons = await this.prisma.person.findMany({
      where: { id: { in: personIds } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        protectedPersonalData: true,
      },
    });
    const byId = new Map(persons.map((person) => [person.id, person]));

    return Promise.all(
      issues.map(async (issue) => ({
        ...toOwnView(issue),
        audience: issue.type.audience,
        reporter: await this.reporterOf(issue, byId),
      })),
    );
  }

  /** Moves an issue between the three states. Reached with issues:handle. */
  async setStatus(
    issueId: string,
    status: IssueStatus,
  ): Promise<QueuedIssueView> {
    const existing = await this.prisma.issue.findUnique({
      where: { id: issueId },
      select: { id: true },
    });
    if (existing === null) {
      throw new IssueError("No such issue.", "issue-not-found");
    }

    const issue = await this.prisma.issue.update({
      where: { id: issueId },
      data: { status },
      include: ISSUE_INCLUDE,
    });

    this.logger.log(`Issue ${issue.id} moved to ${status}`);

    const reporterId = issue.reporterPersonId;
    const persons =
      reporterId === null
        ? []
        : await this.prisma.person.findMany({
            where: { id: reporterId },
            select: {
              id: true,
              firstName: true,
              lastName: true,
              protectedPersonalData: true,
            },
          });

    return {
      ...toOwnView(issue),
      audience: issue.type.audience,
      reporter: await this.reporterOf(
        issue,
        new Map(persons.map((person) => [person.id, person])),
      ),
    };
  }

  /**
   * Attaches a photograph to one's own report.
   *
   * The file goes through the media layer like every other, so it is identified
   * from its own bytes, given a generated key and served from this instance's
   * origin. It is recorded INTERNAL, which means no session, no file.
   *
   * It carries no capability narrowing, and that is a deliberate trade-off
   * rather than an omission: the media layer narrows a file to exactly one
   * capability, and the two people who have to see an issue photo - the
   * resident who took it and the property manager who has to fix the thing -
   * hold no capability in common. What actually keeps a photo private is that
   * nothing hands out its identifier: it is reachable only through an issue
   * payload, and those are filtered to the reporter and to whoever handles
   * issues.
   */
  async attachPhoto(input: {
    issueId: string;
    reporterPersonId: string;
    bytes: Buffer;
    fileName: string;
  }): Promise<IssuePhotoView> {
    const issue = await this.prisma.issue.findFirst({
      where: {
        id: input.issueId,
        reporterPersonId: input.reporterPersonId,
      },
      select: { id: true, _count: { select: { photos: true } } },
    });
    if (issue === null) {
      throw new IssueError("No such issue.", "issue-not-found");
    }
    if (issue._count.photos >= MAX_PHOTOS_PER_ISSUE) {
      throw new IssueError(
        "This report already carries as many photographs as it may.",
        "too-many-photos",
      );
    }

    const file = await this.media.upload({
      bytes: input.bytes,
      fileName: input.fileName,
      visibility: "INTERNAL",
      /*
       * Declared true without asking, which is the safe direction.
       *
       * The declaration is the input the publication guardrails need: a person
       * may appear on a public page only with a recorded publication consent,
       * and a file nobody declared cannot be checked against that rule. Nobody
       * knows whether a photograph of a stairwell caught a neighbour on it, and
       * an issue photograph is never published anyway - so it is recorded as if
       * it shows someone, and a later path that wanted to publish it would have
       * to answer for that.
       */
      showsIdentifiablePersons: true,
      uploadedByPersonId: input.reporterPersonId,
    });

    const photo = await this.prisma.issuePhoto.create({
      data: {
        issueId: issue.id,
        fileId: file.id,
        sortOrder: issue._count.photos,
      },
      select: { id: true },
    });

    return {
      id: photo.id,
      url: file.url,
      fileName: file.fileName,
      width: file.width,
      height: file.height,
    };
  }

  /**
   * The apartments the reporter may file against: their own, today.
   *
   * A picker over the whole register would enumerate the building, and an issue
   * filed against somebody else's home is a report about a neighbour rather
   * than about the building. The free-text location covers everything that is
   * not an apartment.
   */
  async ownApartments(personId: string): Promise<IssueApartmentView[]> {
    const now = new Date();
    const residencies = await this.prisma.residency.findMany({
      where: {
        personId,
        OR: [{ movedOutOn: null }, { movedOutOn: { gt: now } }],
      },
      select: { apartment: { select: APARTMENT_SELECT } },
      orderBy: { movedInOn: "asc" },
    });

    const seen = new Set<string>();
    const apartments: IssueApartmentView[] = [];
    for (const residency of residencies) {
      if (seen.has(residency.apartment.id)) {
        continue;
      }
      seen.add(residency.apartment.id);
      apartments.push(toApartmentView(residency.apartment));
    }
    return apartments;
  }

  private async requireOwnApartment(
    personId: string,
    apartmentId: string,
  ): Promise<string> {
    const apartments = await this.ownApartments(personId);
    if (!apartments.some((apartment) => apartment.id === apartmentId)) {
      // Deliberately the same answer as an apartment that is not in the
      // register: otherwise this endpoint enumerates the building.
      throw new IssueError("No such apartment.", "apartment-not-found");
    }
    return apartmentId;
  }

  private async reporterOf(
    issue: {
      reporterPersonId: string | null;
      reporterNameCipher: string | null;
      reporterEmailCipher: string | null;
    },
    persons: ReadonlyMap<
      string,
      {
        id: string;
        firstName: string;
        lastName: string;
        protectedPersonalData: boolean;
      }
    >,
  ): Promise<IssueReporterView> {
    const personId = issue.reporterPersonId;

    if (personId !== null) {
      const person = persons.get(personId);
      if (person === undefined) {
        return { kind: "unknown" };
      }
      if (person.protectedPersonalData) {
        return { kind: "protected", personId: person.id };
      }
      return {
        kind: "resident",
        personId: person.id,
        name: `${person.firstName} ${person.lastName}`.trim(),
      };
    }

    if (
      issue.reporterNameCipher === null &&
      issue.reporterEmailCipher === null
    ) {
      return { kind: "unknown" };
    }

    return {
      kind: "external",
      name:
        issue.reporterNameCipher === null
          ? null
          : await this.encryption.decrypt(
              "issue.reporterName",
              issue.reporterNameCipher,
            ),
      email:
        issue.reporterEmailCipher === null
          ? null
          : await this.encryption.decrypt(
              "issue.reporterEmail",
              issue.reporterEmailCipher,
            ),
    };
  }
}

const APARTMENT_SELECT = {
  id: true,
  number: true,
  address: { select: { street: true, number: true } },
} as const;

const ISSUE_INCLUDE = {
  type: { select: { id: true, name: true, audience: true } },
  apartment: { select: APARTMENT_SELECT },
  photos: {
    orderBy: { sortOrder: "asc" },
    select: {
      id: true,
      file: { select: { id: true, fileName: true, width: true, height: true } },
    },
  },
} as const;

interface ApartmentRecord {
  id: string;
  number: string;
  address: { street: string; number: string };
}

function toApartmentView(apartment: ApartmentRecord): IssueApartmentView {
  return {
    id: apartment.id,
    number: apartment.number,
    address: `${apartment.address.street} ${apartment.address.number}`,
  };
}

function toOwnView(issue: {
  id: string;
  status: IssueStatus;
  location: string | null;
  description: string;
  createdAt: Date;
  updatedAt: Date;
  type: { id: string; name: string; audience: IssueAudience };
  apartment: ApartmentRecord | null;
  photos: {
    id: string;
    file: {
      id: string;
      fileName: string;
      width: number | null;
      height: number | null;
    };
  }[];
}): OwnIssueView {
  return {
    id: issue.id,
    status: issue.status,
    typeId: issue.type.id,
    typeName: issue.type.name,
    location: issue.location,
    description: issue.description,
    apartment:
      issue.apartment === null ? null : toApartmentView(issue.apartment),
    photos: issue.photos.map((photo) => ({
      id: photo.id,
      url: mediaUrl(photo.file.id),
      fileName: photo.file.fileName,
      width: photo.file.width,
      height: photo.file.height,
    })),
    createdAt: issue.createdAt.toISOString(),
    updatedAt: issue.updatedAt.toISOString(),
  };
}
