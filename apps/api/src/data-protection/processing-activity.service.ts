import { HttpStatus, Injectable } from "@nestjs/common";
import { scanForPersonalIdentityNumbers } from "@openbrf/shared";
import type { TFunction } from "i18next";

import { AuditLogService } from "../audit/audit-log.service";
import { PrismaService } from "../database/prisma.service";
import type { LegalBasis } from "../generated/prisma/enums";
import { DomainError } from "../http/domain-error";
import { pluginProcessorKey } from "./processor-key";
import type { ProcessorFacts } from "./processors";
import { SEED_KEYS, seedRows } from "./processing-activity-seed";

export class ProcessingActivityError extends DomainError {
  readonly status: number;

  constructor(
    message: string,
    readonly reason:
      "activity-not-found" | "personal-identity-number" | "already-ended",
  ) {
    super(message);
    this.status =
      reason === "activity-not-found"
        ? HttpStatus.NOT_FOUND
        : reason === "already-ended"
          ? HttpStatus.CONFLICT
          : HttpStatus.BAD_REQUEST;
  }
}

const ACTIVITY_SELECT = {
  id: true,
  name: true,
  purpose: true,
  legalBasis: true,
  legalBasisNote: true,
  dataSubjectCategories: true,
  personalDataCategories: true,
  recipients: true,
  thirdCountryTransfer: true,
  thirdCountrySafeguards: true,
  retention: true,
  securityMeasures: true,
  source: true,
  sourceKey: true,
  endedAt: true,
  recordedByPersonId: true,
  updatedByPersonId: true,
} as const;

export interface ProcessingActivityView {
  activityId: string;
  name: string;
  purpose: string;
  legalBasis: LegalBasis;
  legalBasisNote: string | null;
  dataSubjectCategories: string[];
  personalDataCategories: string[];
  recipients: string | null;
  thirdCountryTransfer: boolean;
  thirdCountrySafeguards: string | null;
  retention: string;
  securityMeasures: string | null;
  source: string;
  sourceKey: string | null;
  endedAt: string | null;
  /** True while the seed still refreshes this row, i.e. nobody has edited it. */
  seeded: boolean;
}

/** The head of the record: who the controller is (GDPR art. 30(1)(a)). */
export interface ControllerBlock {
  name: string;
  organizationNumber: string | null;
  contactEmail: string | null;
  postalAddress: string | null;
  officer: { name: string | null; email: string; phone: string | null } | null;
  jointController: { name: string; contact: string } | null;
}

export interface ProcessingRecord {
  controller: ControllerBlock;
  activities: ProcessingActivityView[];
}

/**
 * The record of processing activities (registerforteckning), GDPR art. 30.
 *
 * A board asked to fill in a blank one would be asked to reverse-engineer the
 * product. So the instance writes down what it does with personal data, and the
 * board corrects it and adds what happens outside the application.
 *
 * The seed is idempotent on `sourceKey` and refreshes every field it authored,
 * and only while `updatedByPersonId` is null. That is what makes a changed
 * storage driver show up in the record without a background job ever
 * overwriting a board's own wording: the column says whether the board has
 * touched the row, and `update` sets it on any edit that changes something.
 *
 * Text the product wrote is refreshed for the same reason the derived fields
 * are. A row nobody has edited is the product's statement of what the instance
 * does, so a correction to that statement has to reach it - the record is
 * persisted rather than rendered, and a value only fixed in the locale file
 * would leave every instance seeded before the fix stating the old one for
 * good. That is not hypothetical: the authority's name was seeded misspelled
 * into this record until it was corrected, and correcting the string alone
 * would have repaired nothing already written.
 *
 * Art. 30(5) exempts an organisation with fewer than 250 employees only where
 * the processing is occasional, carries no risk and holds no special
 * categories. A housing cooperative's member register is none of those, so the
 * record is required and this is not an optional feature.
 */
@Injectable()
export class ProcessingActivityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /** The whole record, controller block first. */
  async read(): Promise<ProcessingRecord> {
    const [association, activities] = await Promise.all([
      this.prisma.association.findUnique({
        where: { id: 1 },
        select: {
          name: true,
          organizationNumber: true,
          controllerContactEmail: true,
          controllerPostalAddress: true,
          dataProtectionOfficerName: true,
          dataProtectionOfficerEmail: true,
          dataProtectionOfficerPhone: true,
          jointControllerName: true,
          jointControllerContact: true,
        },
      }),
      this.prisma.processingActivity.findMany({
        orderBy: [{ source: "asc" }, { name: "asc" }],
        select: ACTIVITY_SELECT,
      }),
    ]);

    return {
      controller: {
        name: association?.name ?? "",
        organizationNumber: association?.organizationNumber ?? null,
        contactEmail: association?.controllerContactEmail ?? null,
        postalAddress: association?.controllerPostalAddress ?? null,
        /*
         * Appointed means there is an address. A name with no way to reach it
         * is not what art. 13(1)(b) and art. 30(1)(a) ask for.
         */
        officer:
          association?.dataProtectionOfficerEmail == null
            ? null
            : {
                name: association.dataProtectionOfficerName,
                email: association.dataProtectionOfficerEmail,
                phone: association.dataProtectionOfficerPhone,
              },
        // Written both or neither, so a name never stands without contact
        // details art. 30(1)(a) requires beside it.
        jointController:
          association?.jointControllerName == null ||
          association.jointControllerContact == null
            ? null
            : {
                name: association.jointControllerName,
                contact: association.jointControllerContact,
              },
      },
      activities: activities.map(toView),
    };
  }

  /**
   * Writes the rows the instance knows about itself, and refreshes the ones the
   * board has not edited.
   *
   * No audit entry: the seed has no actor. What a board does to a row is
   * audited; what the instance says about itself at boot is the instance
   * describing its own configuration.
   */
  async seed(t: TFunction, facts: ProcessorFacts): Promise<void> {
    const rows = seedRows(t, facts);

    await this.prisma.$transaction(async (tx) => {
      await tx.processingActivity.createMany({
        data: rows.map((row) => ({
          sourceKey: row.sourceKey,
          source: row.source,
          name: row.name,
          purpose: row.purpose,
          legalBasis: row.legalBasis,
          legalBasisNote: row.legalBasisNote,
          dataSubjectCategories: row.dataSubjectCategories,
          personalDataCategories: row.personalDataCategories,
          recipients: row.recipients,
          thirdCountryTransfer: row.thirdCountryTransfer,
          thirdCountrySafeguards: row.thirdCountrySafeguards,
          retention: row.retention,
          securityMeasures: row.securityMeasures,
        })),
        skipDuplicates: true,
      });

      for (const row of rows) {
        await tx.processingActivity.updateMany({
          where: { sourceKey: row.sourceKey, updatedByPersonId: null },
          data: {
            /*
             * Everything the seed authored, not only what it derives from the
             * configuration. `updatedByPersonId` is what protects the board's
             * own words, and it is set by every edit that changes anything, so
             * a row reaching here has nothing of the board's in it to lose.
             */
            name: row.name,
            purpose: row.purpose,
            legalBasis: row.legalBasis,
            legalBasisNote: row.legalBasisNote,
            dataSubjectCategories: row.dataSubjectCategories,
            personalDataCategories: row.personalDataCategories,
            retention: row.retention,
            recipients: row.recipients,
            thirdCountryTransfer: row.thirdCountryTransfer,
            thirdCountrySafeguards: row.thirdCountrySafeguards,
            securityMeasures: row.securityMeasures,
          },
        });
      }
    });
  }

  /**
   * Records, or reopens, the processing one installed plugin performs.
   *
   * Update-or-create rather than create-if-absent: removing a plugin ends its
   * row, and installing it again has to reopen that row rather than be blocked
   * by it. The board's own edits to the text survive; the declared categories
   * are refreshed, because they are the new version's declaration.
   */
  async seedPlugin(
    pluginId: string,
    input: { name: string; personalDataCategories: string[] },
  ): Promise<void> {
    const sourceKey = pluginProcessorKey(pluginId);

    /*
     * One statement rather than a read and then a write. Two installs arriving
     * together would both read no row and the second `create` would fail on the
     * unique key, leaving the art. 30 record without the processing an
     * installed plugin performs.
     */
    await this.prisma.processingActivity.upsert({
      where: { sourceKey },
      create: {
        sourceKey,
        source: "PLUGIN",
        name: input.name,
        purpose: input.name,
        legalBasis: "LEGITIMATE_INTEREST",
        dataSubjectCategories: ["member", "resident"],
        personalDataCategories: input.personalDataCategories,
        retention: "",
      },
      update: {
        endedAt: null,
        personalDataCategories: input.personalDataCategories,
      },
    });
  }

  /** Ends the processing a removed plugin performed. The row stays. */
  async endPlugin(pluginId: string): Promise<void> {
    await this.prisma.processingActivity.updateMany({
      where: { sourceKey: pluginProcessorKey(pluginId), endedAt: null },
      data: { endedAt: new Date() },
    });
  }

  /** A processing the board recorded itself. */
  async record(
    input: ActivityInput & { actorPersonId: string },
  ): Promise<ProcessingActivityView> {
    assertNoIdentityNumber(input);

    return this.prisma.$transaction(async (tx) => {
      const row = await tx.processingActivity.create({
        data: {
          source: "BOARD",
          name: input.name,
          purpose: input.purpose,
          legalBasis: input.legalBasis,
          legalBasisNote: input.legalBasisNote ?? null,
          dataSubjectCategories: input.dataSubjectCategories,
          personalDataCategories: input.personalDataCategories,
          recipients: input.recipients ?? null,
          thirdCountryTransfer: input.thirdCountryTransfer,
          thirdCountrySafeguards: input.thirdCountrySafeguards ?? null,
          retention: input.retention,
          securityMeasures: input.securityMeasures ?? null,
          recordedByPersonId: input.actorPersonId,
          updatedByPersonId: input.actorPersonId,
        },
        select: ACTIVITY_SELECT,
      });

      await this.audit.record(
        {
          action: "PROCESSING_ACTIVITY_RECORDED",
          actorPersonId: input.actorPersonId,
          targetKind: "processingActivity",
          targetId: row.id,
          // No subject: the record describes a processing, not a person.
          context: { source: "BOARD", legalBasis: input.legalBasis },
        },
        tx,
      );

      return toView(row);
    });
  }

  /** Edits a row, seeded or the board's own. */
  async update(
    activityId: string,
    input: Partial<ActivityInput> & { actorPersonId: string },
  ): Promise<ProcessingActivityView> {
    const existing = await this.prisma.processingActivity.findUnique({
      where: { id: activityId },
      select: { id: true },
    });
    if (existing === null) {
      throw new ProcessingActivityError(
        "There is no such processing.",
        "activity-not-found",
      );
    }

    assertNoIdentityNumber(input);

    const changed = Object.keys(input).filter(
      (field) =>
        field !== "actorPersonId" &&
        input[field as keyof typeof input] !== undefined,
    );

    return this.prisma.$transaction(async (tx) => {
      const row = await tx.processingActivity.update({
        where: { id: activityId },
        data: {
          name: input.name,
          purpose: input.purpose,
          legalBasis: input.legalBasis,
          legalBasisNote: input.legalBasisNote,
          dataSubjectCategories: input.dataSubjectCategories,
          personalDataCategories: input.personalDataCategories,
          recipients: input.recipients,
          thirdCountryTransfer: input.thirdCountryTransfer,
          thirdCountrySafeguards: input.thirdCountrySafeguards,
          retention: input.retention,
          securityMeasures: input.securityMeasures,
          /*
           * The row stops following the instance's settings from here. That is
           * the point of the column: a board that has written its own wording
           * should never find it replaced by a background job.
           *
           * Only where the payload changes something. A `PUT` carrying no
           * fields would otherwise detach a seeded row from the instance's
           * configuration without altering a word of it, and the record would
           * quietly stop following a changed storage driver or a new third
           * country transfer while the board remained answerable for it under
           * art. 5(2).
           */
          updatedByPersonId:
            changed.length === 0 ? undefined : input.actorPersonId,
        },
        select: ACTIVITY_SELECT,
      });

      await this.audit.record(
        {
          action: "PROCESSING_ACTIVITY_UPDATED",
          actorPersonId: input.actorPersonId,
          targetKind: "processingActivity",
          targetId: activityId,
          context: { fields: changed },
        },
        tx,
      );

      return toView(row);
    });
  }

  /** Ends a processing. The row stays, with the date it stopped. */
  async end(
    activityId: string,
    actorPersonId: string,
  ): Promise<ProcessingActivityView> {
    const existing = await this.prisma.processingActivity.findUnique({
      where: { id: activityId },
      select: { id: true, endedAt: true },
    });
    if (existing === null) {
      throw new ProcessingActivityError(
        "There is no such processing.",
        "activity-not-found",
      );
    }
    if (existing.endedAt !== null) {
      throw new ProcessingActivityError(
        "That processing has already been ended.",
        "already-ended",
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const row = await tx.processingActivity.update({
        where: { id: activityId },
        data: { endedAt: new Date() },
        select: ACTIVITY_SELECT,
      });

      await this.audit.record(
        {
          action: "PROCESSING_ACTIVITY_ENDED",
          actorPersonId,
          targetKind: "processingActivity",
          targetId: activityId,
        },
        tx,
      );

      return toView(row);
    });
  }

  /** How many seeded rows exist, for the boot hook to decide on. */
  async seededCount(): Promise<number> {
    return this.prisma.processingActivity.count({
      where: { sourceKey: { in: [...SEED_KEYS] } },
    });
  }
}

export interface ActivityInput {
  name: string;
  purpose: string;
  legalBasis: LegalBasis;
  legalBasisNote?: string | null;
  dataSubjectCategories: string[];
  personalDataCategories: string[];
  recipients?: string | null;
  thirdCountryTransfer: boolean;
  thirdCountrySafeguards?: string | null;
  retention: string;
  securityMeasures?: string | null;
}

function assertNoIdentityNumber(input: Partial<ActivityInput>): void {
  for (const value of [
    input.name,
    input.purpose,
    input.legalBasisNote,
    input.recipients,
    input.thirdCountrySafeguards,
    input.retention,
    input.securityMeasures,
  ]) {
    if (typeof value !== "string") {
      continue;
    }
    for (const _hit of scanForPersonalIdentityNumbers(value)) {
      throw new ProcessingActivityError(
        "Describe the processing without a personal identity number in it.",
        "personal-identity-number",
      );
    }
  }
}

function toView(row: {
  id: string;
  name: string;
  purpose: string;
  legalBasis: LegalBasis;
  legalBasisNote: string | null;
  dataSubjectCategories: string[];
  personalDataCategories: string[];
  recipients: string | null;
  thirdCountryTransfer: boolean;
  thirdCountrySafeguards: string | null;
  retention: string;
  securityMeasures: string | null;
  source: string;
  sourceKey: string | null;
  endedAt: Date | null;
  recordedByPersonId: string | null;
  updatedByPersonId: string | null;
}): ProcessingActivityView {
  return {
    activityId: row.id,
    name: row.name,
    purpose: row.purpose,
    legalBasis: row.legalBasis,
    legalBasisNote: row.legalBasisNote,
    dataSubjectCategories: row.dataSubjectCategories,
    personalDataCategories: row.personalDataCategories,
    recipients: row.recipients,
    thirdCountryTransfer: row.thirdCountryTransfer,
    thirdCountrySafeguards: row.thirdCountrySafeguards,
    retention: row.retention,
    securityMeasures: row.securityMeasures,
    source: row.source,
    sourceKey: row.sourceKey,
    endedAt: row.endedAt?.toISOString() ?? null,
    seeded: row.sourceKey !== null && row.updatedByPersonId === null,
  };
}
