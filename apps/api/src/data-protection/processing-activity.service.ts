import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import {
  type PluginNonResidentCaller,
  type PluginProcessing,
  readsAddressBook,
} from "@openbrf/plugin-sdk";
import {
  ACTIVITY_FIELDS,
  type ActivityField,
  scanForPersonalIdentityNumbers,
} from "@openbrf/shared";
import type { TFunction } from "i18next";

import { AuditLogService } from "../audit/audit-log.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import type { LegalBasis } from "../generated/prisma/enums";
import { DomainError } from "../http/domain-error";
import { I18nService } from "../i18n/i18n.service";
import { failureFrames, failureName } from "../logging/failure";
import { foldedText } from "./folded-text";
import { pluginProcessorKey } from "./processor-key";
import { ProcessorFactsService } from "./processor-facts.service";
import type { ProcessorFacts } from "./processors";
import { lockProcessingActivity } from "./processing-activity-lock";
import { SEED_KEYS, seedRows, type SeedRow } from "./processing-activity-seed";
import { declaredProcessing } from "./plugin-processing";

export class ProcessingActivityError extends DomainError {
  readonly status: number;

  constructor(
    message: string,
    readonly reason:
      | "activity-not-found"
      | "personal-identity-number"
      | "already-ended"
      | "activity-changed"
      | "no-product-text",
  ) {
    super(message);
    this.status =
      reason === "activity-not-found"
        ? HttpStatus.NOT_FOUND
        : // A conflict rather than a refusal on the merits: nothing is wrong
          // with what was sent, somebody else wrote first, and the board reads
          // the record again and decides what to do about it. A row with no
          // product text to adopt - one the board recorded, a plugin's, or one
          // the seed still refreshes - is the same: the screen never offers the
          // action there, so a caller asking is out of step with the record.
          reason === "already-ended" ||
            reason === "activity-changed" ||
            reason === "no-product-text"
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
  revision: true,
} as const;

/*
 * Every field the board writes is a field of the input, so a name added to the
 * shared list that the API does not accept fails here.
 */
ACTIVITY_FIELDS satisfies readonly (keyof ActivityInput)[];

/**
 * Whether a supplied value says what the row already says.
 *
 * The two category lists are compared as sets. Their order carries no
 * meaning, so a client that sends them in a different order has not changed
 * the processing they describe.
 */
function sameValue(current: unknown, next: unknown): boolean {
  if (Array.isArray(current) && Array.isArray(next)) {
    const order = (left: unknown, right: unknown): number =>
      String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0;
    return (
      JSON.stringify([...current].sort(order)) ===
      JSON.stringify([...next].sort(order))
    );
  }
  return current === next;
}

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
  /**
   * The row as it stands, to send back with a save.
   *
   * Read and returned rather than required, so a caller written before the
   * field existed keeps working; a caller that sends it gets a refusal instead
   * of replacing an edit it never saw.
   */
  revision: number;
  /**
   * Whether the product's own statement for this row now says something the
   * row does not.
   *
   * Only ever true on a seeded row the board has edited: the seed refreshes
   * every other seeded row itself, and a row the board recorded has no product
   * statement to differ from. The board's wording keeps winning, so nothing
   * replaces it; the screen says that the product has moved on and lets the
   * board take the product's wording field by field.
   */
  productDiffers: boolean;
  /**
   * What the product says now, for each field where that is not what the row
   * holds. Empty wherever `productDiffers` is false.
   */
  productText: ProductText;
  /**
   * True on a seeded row the board has edited when the product's statement
   * could not be computed for this answer, so `productDiffers` is false
   * because nothing was compared, not because the texts agree. The screen
   * says so rather than showing the row as though it matched.
   */
  productTextUnavailable: boolean;
}

/**
 * The product's statement of a seeded row, field by field, where it differs
 * from the row.
 */
export type ProductText = Partial<Pick<ProcessingActivityView, ActivityField>>;

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
 * The cost of that rule is that a correction to the product's wording never
 * reaches a row the board has edited either. So the record says, on each such
 * row, where the product's statement now differs from the board's, and taking
 * the product's wording is the board's own act (`adoptProductText`), audited
 * like any other edit. Nothing takes it for the board.
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
  private readonly logger = new Logger(ProcessingActivityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly i18n: I18nService,
    private readonly facts: ProcessorFactsService,
  ) {}

  /** The whole record, controller block first. */
  async read(): Promise<ProcessingRecord> {
    const [association, activities, product] = await Promise.all([
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
      this.productStatementOrNone(),
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
      activities: activities.map((row) => toView(row, product)),
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
            /*
             * The revision moves because the row changed. Every writer to this
             * model increments it in the statement that changes the fields, or
             * a save composed on the copy from before would match afterwards
             * and replace what this wrote.
             */
            revision: { increment: 1 },
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
   * by it. The declared categories and recipients are refreshed, because they
   * are the new version's declaration and the board has just consented to it.
   *
   * `recipients` is the art. 30(1)(d) answer the plugin's declaration gives:
   * the hosts of the declared recipients that receive personal data, or null
   * when none does. A recipient declared as receiving none is not a recipient
   * in the sense of art. 4(9), and the record lists who receives personal
   * data, not every place the plugin connects to.
   *
   * Left out when the plugin declares no recipients at all, as an entry in
   * version 1 of the catalog index cannot: an absent declaration says nothing
   * about where data goes, so the answer the board wrote itself stays.
   *
   * The rest of the row is seeded from the plugin's processing declaration
   * (ADR 0035), in the association's own language: what it is for, on what
   * basis, for how long and about whom, with former residents among them when
   * the plugin keeps records about a person. A republished version that changes the
   * declaration refreshes the row only while no board member has edited it,
   * the rule every seeded row follows, so the board's own words keep winning.
   * A plugin from before the declaration existed is seeded as it always was,
   * with its name for a purpose and the rest for the board to write.
   *
   * A plugin that declares no personal data and cannot read the address book
   * processes nobody's, and has no row: a row an earlier version left open is
   * ended instead. One that reads the address book keeps its row whatever it
   * declares, because the row is what a person objects to (ADR 0035); the
   * package check refuses such a declaration, so only a plugin published
   * before that rule gets here.
   */
  async seedPlugin(
    pluginId: string,
    input: {
      name: string;
      permissions: readonly string[];
      personalDataCategories: string[];
      recipients?: string | null;
      processing?: PluginProcessing | undefined;
      /** The collections of records about a person it declares (ADR 0047). */
      personRecords?: readonly unknown[];
      /** Whom its resident routes serve who do not live here (ADR 0053). */
      nonResidentCallers?: readonly PluginNonResidentCaller[];
    },
    client?: Prisma.TransactionClient,
  ): Promise<void> {
    const db = client ?? this.prisma;
    const sourceKey = pluginProcessorKey(pluginId);

    if (
      input.personalDataCategories.length === 0 &&
      !readsAddressBook(input.permissions)
    ) {
      await this.endPlugin(pluginId, client);
      return;
    }

    const association = await db.association.findUnique({
      where: { id: 1 },
      select: { defaultLocale: true },
    });
    const declared =
      input.processing === undefined
        ? null
        : declaredProcessing(
            input.processing,
            association?.defaultLocale,
            input.personRecords,
            input.nonResidentCallers,
          );

    /*
     * One statement rather than a read and then a write. Two installs arriving
     * together would both read no row and the second `create` would fail on the
     * unique key, leaving the art. 30 record without the processing an
     * installed plugin performs.
     */
    await db.processingActivity.upsert({
      where: { sourceKey },
      create: {
        sourceKey,
        source: "PLUGIN",
        name: input.name,
        personalDataCategories: input.personalDataCategories,
        recipients: input.recipients ?? null,
        ...(declared ?? {
          purpose: input.name,
          legalBasis: "LEGITIMATE_INTEREST",
          dataSubjectCategories: ["member", "resident"],
          retention: "",
        }),
      },
      update: {
        endedAt: null,
        personalDataCategories: input.personalDataCategories,
        ...(input.recipients === undefined
          ? {}
          : { recipients: input.recipients }),
        // The revision moves because the row changed, as it does on every other
        // writer to this model.
        revision: { increment: 1 },
      },
    });

    if (declared !== null) {
      await db.processingActivity.updateMany({
        where: { sourceKey, updatedByPersonId: null },
        data: { ...declared, revision: { increment: 1 } },
      });
    }
  }

  /** Ends the processing a removed plugin performed. The row stays. */
  async endPlugin(
    pluginId: string,
    client?: Prisma.TransactionClient,
  ): Promise<void> {
    await (client ?? this.prisma).processingActivity.updateMany({
      where: { sourceKey: pluginProcessorKey(pluginId), endedAt: null },
      data: { endedAt: new Date(), revision: { increment: 1 } },
    });
  }

  /** A processing the board recorded itself. */
  async record(
    given: ActivityInput & { actorPersonId: string },
  ): Promise<ProcessingActivityView> {
    const input = foldedText(given, ACTIVITY_TEXT);
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
          channel: "WEB",
          actorPersonId: input.actorPersonId,
          targetKind: "processingActivity",
          targetId: row.id,
          // No subject: the record describes a processing, not a person.
          context: { source: "BOARD", legalBasis: input.legalBasis },
        },
        tx,
      );

      // A row the board recorded has no product statement to differ from.
      return toView(row, new Map());
    });
  }

  /** Edits a row, seeded or the board's own. */
  async update(
    activityId: string,
    given: Partial<ActivityInput> & {
      actorPersonId: string;
      /**
       * The record's revision as the caller last read it.
       *
       * Optional on the wire, and absent means what this endpoint has always
       * done. That keeps a caller written before the field existed working
       * rather than failing on a precondition it does not know about.
       */
      expectedRevision?: number;
    },
  ): Promise<ProcessingActivityView> {
    const input = foldedText(given, ACTIVITY_TEXT);
    const row = await this.prisma.$transaction(async (tx) => {
      /*
       * Before the read, so the comparison below and the write after it see the
       * same row. Read outside the transaction, a second save committing in
       * between left `changed` describing a row that was no longer there: the
       * write overwrote the newer fields, while `updatedByPersonId` and the
       * audit entry both described the older one.
       */
      await lockProcessingActivity(tx, activityId);

      const existing = await tx.processingActivity.findUnique({
        where: { id: activityId },
        select: {
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
        },
      });
      if (existing === null) {
        throw new ProcessingActivityError(
          "There is no such processing.",
          "activity-not-found",
        );
      }

      assertNoIdentityNumber(input);

      /*
       * The fields this write actually changes, read against the row rather
       * than against the payload. A field the payload carries with the value
       * the row already holds is not a change: counting it as one marked the
       * row edited on a save that altered nothing, and an edited row is one the
       * seed stops refreshing - so it would miss every later correction to the
       * product's own wording, and every change to the configuration it
       * describes.
       */
      const changed = ACTIVITY_FIELDS.filter(
        (field) =>
          input[field] !== undefined &&
          !sameValue(existing[field], input[field]),
      );

      /*
       * A claimed write and not a plain update, so the precondition sits in the
       * predicate rather than in a comparison this method makes for itself. The
       * lock above serialises two saves that overlap on the server and can say
       * nothing about when a payload was composed: a board member who opened
       * the record, went to a meeting and saved afterwards has a payload built
       * on a copy that has since been replaced, and the lock lets it through in
       * good order.
       *
       * Optional, and absent means what this endpoint has always done, which
       * keeps a caller written before the field existed working. The record is
       * edited as a whole, so what a save replaces is every field the other
       * board member wrote.
       */
      const claimed = await tx.processingActivity.updateMany({
        where: {
          id: activityId,
          ...(input.expectedRevision === undefined
            ? {}
            : { revision: input.expectedRevision }),
        },
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
           * fields, or carrying the values the row already holds, would
           * otherwise detach a seeded row from the instance's configuration
           * without altering a word of it, and the record would
           * quietly stop following a changed storage driver or a new third
           * country transfer while the board remained answerable for it under
           * art. 5(2).
           */
          updatedByPersonId:
            changed.length === 0 ? undefined : input.actorPersonId,
          /*
           * In the same statement as the fields, which is the rule the column
           * is kept by: a writer that changed the record and left the number
           * alone would let a stale precondition match afterwards. It moves on
           * every save and not only on one that altered something, because what
           * it says is that the row is not the one somebody else read.
           */
          revision: { increment: 1 },
        },
      });

      if (claimed.count === 0) {
        throw new ProcessingActivityError(
          "The processing changed after it was read.",
          "activity-changed",
        );
      }

      const row = await tx.processingActivity.findUniqueOrThrow({
        where: { id: activityId },
        select: ACTIVITY_SELECT,
      });

      await this.audit.record(
        {
          action: "PROCESSING_ACTIVITY_UPDATED",
          channel: "WEB",
          actorPersonId: input.actorPersonId,
          targetKind: "processingActivity",
          targetId: activityId,
          context: { fields: changed },
        },
        tx,
      );

      return row;
    });
    return this.viewOf(row);
  }

  /**
   * Writes the product's current wording into the named fields of a seeded row
   * the board has edited.
   *
   * The seed never does this on its own, and must not: a board that has
   * written its own account of a processing is answerable for it under art.
   * 5(2), and a background job replacing it would be the association
   * contradicting itself. What the seed cannot tell is whether the board's
   * wording was a deliberate choice or a copy of the product's that the product
   * has since corrected, so the screen shows the two side by side and this is
   * the board's own act of taking the product's.
   *
   * The values are the product's as this transaction computes them, never
   * values the caller sends, so a screen read before a configuration change
   * cannot write yesterday's statement under today's name.
   *
   * The row stays the board's: `updatedByPersonId` names the board member who
   * adopted the text, the seed keeps leaving the row alone, and the next time
   * the product's statement moves on the screen says so again. Audited as the
   * edit it is, with the fields it changed and that the text was the
   * product's, and never the text itself.
   */
  async adoptProductText(
    activityId: string,
    input: {
      fields: readonly ActivityField[];
      actorPersonId: string;
      /** @see update */
      expectedRevision?: number;
    },
  ): Promise<ProcessingActivityView> {
    return this.prisma.$transaction(async (tx) => {
      // Before the read, as `update` takes it, so the comparison and the write
      // see the same row.
      await lockProcessingActivity(tx, activityId);

      const existing = await tx.processingActivity.findUnique({
        where: { id: activityId },
        select: ACTIVITY_SELECT,
      });
      if (existing === null) {
        throw new ProcessingActivityError(
          "There is no such processing.",
          "activity-not-found",
        );
      }

      const product = await this.productStatement(tx);
      const statement = productTextOf(existing, product);
      if (statement === null) {
        throw new ProcessingActivityError(
          "The product has no wording of its own for this processing to adopt.",
          "no-product-text",
        );
      }

      // Only the fields that still differ. One that has come back into line
      // since the screen was read has nothing to adopt, and naming it in the
      // audit entry would record a change that was never made.
      const changed = ACTIVITY_FIELDS.filter(
        (field) => input.fields.includes(field) && field in statement.differs,
      );
      if (changed.length === 0) {
        /*
         * The precondition holds here too. A field another board member's save
         * has since brought into line leaves nothing to write, but the caller's
         * copy is still not the row: answering 200 would tell a screen built on
         * it that its read stands.
         */
        if (
          input.expectedRevision !== undefined &&
          input.expectedRevision !== existing.revision
        ) {
          throw new ProcessingActivityError(
            "The processing changed after it was read.",
            "activity-changed",
          );
        }
        // Nothing left to adopt: nothing is written, so nothing is audited,
        // and the screen is answered with the row as it stands.
        return toView(existing, product);
      }
      const data: Prisma.ProcessingActivityUpdateManyMutationInput = {};
      for (const field of changed) {
        Object.assign(data, { [field]: statement.row[field] });
      }

      const claimed = await tx.processingActivity.updateMany({
        where: {
          id: activityId,
          ...(input.expectedRevision === undefined
            ? {}
            : { revision: input.expectedRevision }),
        },
        data: {
          ...data,
          // The board member who adopted it: the row stays the board's, so
          // the seed goes on leaving it alone.
          updatedByPersonId: input.actorPersonId,
          // In the same statement as the fields, as on every writer to this
          // model.
          revision: { increment: 1 },
        },
      });
      if (claimed.count === 0) {
        throw new ProcessingActivityError(
          "The processing changed after it was read.",
          "activity-changed",
        );
      }

      const row = await tx.processingActivity.findUniqueOrThrow({
        where: { id: activityId },
        select: ACTIVITY_SELECT,
      });

      await this.audit.record(
        {
          action: "PROCESSING_ACTIVITY_UPDATED",
          channel: "WEB",
          actorPersonId: input.actorPersonId,
          targetKind: "processingActivity",
          targetId: activityId,
          context: { fields: changed, adoptedProductText: true },
        },
        tx,
      );

      return toView(row, product);
    });
  }

  /**
   * The product's own statement of every seeded row, as the seed would write
   * it now: in the association's language and from the instance's current
   * configuration, the two things `DataProtectionSeedService` seeds from.
   *
   * Plugin rows are not in it. A plugin's wording is its processing
   * declaration, which lives in the package the board consented to and is not
   * re-read here.
   */
  private async productStatement(
    client?: Prisma.TransactionClient,
  ): Promise<ReadonlyMap<string, SeedRow>> {
    const db = client ?? this.prisma;
    const [association, facts] = await Promise.all([
      db.association.findUnique({
        where: { id: 1 },
        select: { defaultLocale: true },
      }),
      this.facts.read(client),
    ]);
    const t = this.i18n.translatorFor(association?.defaultLocale);
    return new Map(seedRows(t, facts).map((row) => [row.sourceKey, row]));
  }

  /**
   * The product's statement, or null where it cannot be computed just now.
   *
   * What is read or written is shown without the comparison rather than not
   * at all. The record is the document the board is answerable for, and a
   * configuration that cannot be read just now must not make it unreadable,
   * nor undo a save or an ending that has committed. The edited rows then say
   * that they could not be compared (`productTextUnavailable`) until the next
   * read, rather than showing as though they agreed with the product.
   */
  private productStatementOrNone(): Promise<ReadonlyMap<
    string,
    SeedRow
  > | null> {
    return this.productStatement().catch((cause: unknown) => {
      this.logger.warn(
        "The product's own wording could not be computed, so edited rows " +
          `are shown without comparing them against it: ${failureName(cause)}.`,
        failureFrames(cause),
      );
      return null;
    });
  }

  /**
   * The product's statement for a row `update` or `end` returns, read only
   * where there can be one to show.
   *
   * After the write's transaction and outside it: the comparison is a view of
   * the row and no part of the write, so it failing must not roll the write
   * and its audit entry back.
   */
  private async viewOf(row: ActivityRow): Promise<ProcessingActivityView> {
    return toView(
      row,
      mayDifferFromProduct(row)
        ? await this.productStatementOrNone()
        : new Map(),
    );
  }

  /** Ends a processing. The row stays, with the date it stopped. */
  async end(
    activityId: string,
    actorPersonId: string,
  ): Promise<ProcessingActivityView> {
    const row = await this.prisma.$transaction(async (tx) => {
      /*
       * Before the read, as its sibling `update` takes it and for the same
       * reason: read outside the transaction, the already-ended check answered
       * about a row that could be ended by the time this write landed, and an
       * `end` could interleave inside a locked save's read-write window - so
       * the save's own comparison described a row that had stopped.
       */
      await lockProcessingActivity(tx, activityId);

      const existing = await tx.processingActivity.findUnique({
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

      /*
       * Conditional on the row still being open, because the lock above is not
       * taken by every writer of `endedAt`: a plugin being removed ends its own
       * processing through `endPlugin`, which does not take it. Matched on the
       * id alone, an end landing after that one would replace the first date
       * with a second and record a second actor as having ended it. Matched on
       * `endedAt: null`, it matches nothing and is refused exactly as a second
       * attempt read above is.
       */
      const claimed = await tx.processingActivity.updateMany({
        where: { id: activityId, endedAt: null },
        data: {
          endedAt: new Date(),
          // Ending the processing is a change to the record, so a save composed
          // on the copy from before it is told rather than applied.
          revision: { increment: 1 },
        },
      });
      if (claimed.count === 0) {
        throw new ProcessingActivityError(
          "That processing has already been ended.",
          "already-ended",
        );
      }

      const row = await tx.processingActivity.findUniqueOrThrow({
        where: { id: activityId },
        select: ACTIVITY_SELECT,
      });

      await this.audit.record(
        {
          action: "PROCESSING_ACTIVITY_ENDED",
          channel: "WEB",
          actorPersonId,
          targetKind: "processingActivity",
          targetId: activityId,
        },
        tx,
      );

      return row;
    });
    return this.viewOf(row);
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

const ACTIVITY_TEXT = {
  oneLine: ["name"],
  freeText: [
    "purpose",
    "legalBasisNote",
    "recipients",
    "thirdCountrySafeguards",
    "retention",
    "securityMeasures",
  ],
} as const;

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

/** A row as `ACTIVITY_SELECT` reads it. */
type ActivityRow = Prisma.ProcessingActivityGetPayload<{
  select: typeof ACTIVITY_SELECT;
}>;

/**
 * Whether a stored value says what the product's statement says.
 *
 * Text is compared as the board's save stores it, folded the way
 * `foldedText` folds it, so a board that typed the product's sentence back
 * has not written something else. An empty text and no text are the same
 * statement: the record says nothing either way.
 */
function sameStatement(
  field: ActivityField,
  stored: unknown,
  product: unknown,
): boolean {
  const comparable = (value: unknown): unknown => {
    if (typeof value !== "string") {
      return value;
    }
    const folded = foldedText({ [field]: value }, ACTIVITY_TEXT)[field];
    return typeof folded === "string" && folded.trim() === "" ? null : folded;
  };
  return sameValue(comparable(stored), comparable(product));
}

/**
 * Whether the row is a seeded row the board has edited, the only kind whose
 * text can differ from the product's statement: the seed refreshes every other
 * seeded row itself, and a row the board recorded or a plugin wrote has no
 * product statement here.
 */
function mayDifferFromProduct(row: ActivityRow): boolean {
  return (
    row.updatedByPersonId !== null &&
    (SEED_KEYS as readonly (string | null)[]).includes(row.sourceKey)
  );
}

/**
 * The product's statement of a seeded row the board has edited, and the fields
 * where it says something the row does not. Null for every other row: one the
 * seed still refreshes says what the product says, one the board recorded has
 * no product statement, and a plugin's is not in `product`.
 */
function productTextOf(
  row: ActivityRow,
  product: ReadonlyMap<string, SeedRow>,
): { row: SeedRow; differs: ProductText } | null {
  if (row.updatedByPersonId === null || row.sourceKey === null) {
    return null;
  }
  const statement = product.get(row.sourceKey);
  if (statement === undefined) {
    return null;
  }
  const differs: ProductText = {};
  for (const field of ACTIVITY_FIELDS) {
    if (!sameStatement(field, row[field], statement[field])) {
      Object.assign(differs, { [field]: statement[field] });
    }
  }
  return { row: statement, differs };
}

/**
 * A row as the API answers it. `product` is null where the product's statement
 * could not be computed for this answer.
 */
function toView(
  row: ActivityRow,
  product: ReadonlyMap<string, SeedRow> | null,
): ProcessingActivityView {
  const productText =
    product === null ? {} : (productTextOf(row, product)?.differs ?? {});

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
    revision: row.revision,
    productDiffers: Object.keys(productText).length > 0,
    productText,
    productTextUnavailable: product === null && mayDifferFromProduct(row),
  };
}
