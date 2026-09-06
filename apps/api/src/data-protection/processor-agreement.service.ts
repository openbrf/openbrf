import { HttpStatus, Injectable } from "@nestjs/common";
import { scanForPersonalIdentityNumbers } from "@openbrf/shared";
import type { TFunction } from "i18next";

import { AuditLogService } from "../audit/audit-log.service";
import { PrismaService } from "../database/prisma.service";
import type {
  ProcessorAgreementStatus,
  ProcessorClassification,
  ProcessorKind,
} from "../generated/prisma/enums";
import { DomainError } from "../http/domain-error";
import { externalProcessorKey, parseProcessorKey } from "./processor-key";
import {
  currentProcessors,
  type ProcessorAgreementState,
  type ProcessorDescriptor,
  type ProcessorFacts,
  stateOf,
} from "./processors";

export class ProcessorAgreementError extends DomainError {
  readonly status: number;

  constructor(
    message: string,
    readonly reason:
      | "processor-not-found"
      | "agreement-not-found"
      | "classification-inconsistent"
      | "terms-required"
      | "counterparty-required"
      | "note-required"
      | "signed-on-required"
      | "personal-identity-number"
      | "already-ended",
  ) {
    super(message);
    this.status =
      reason === "processor-not-found" || reason === "agreement-not-found"
        ? HttpStatus.NOT_FOUND
        : reason === "already-ended"
          ? HttpStatus.CONFLICT
          : HttpStatus.BAD_REQUEST;
  }
}

const AGREEMENT_SELECT = {
  id: true,
  processorKind: true,
  processorKey: true,
  classification: true,
  status: true,
  counterparty: true,
  reference: true,
  signedOn: true,
  termsConfirmed: true,
  subProcessorsAuthorised: true,
  subProcessorNote: true,
  note: true,
  endedAt: true,
  endReason: true,
  recordedByPersonId: true,
} as const;

/** One recipient, what the board said about it, and the agreement covering it. */
export interface ProcessorView extends ProcessorDescriptor {
  agreement: {
    agreementId: string;
    classification: ProcessorClassification;
    status: ProcessorAgreementStatus | null;
    counterparty: string | null;
    reference: string | null;
    signedOn: string | null;
    termsConfirmed: boolean | null;
    subProcessorsAuthorised: boolean | null;
    subProcessorNote: string | null;
    note: string | null;
  } | null;
}

export interface ProcessorAgreementInput {
  classification: ProcessorClassification;
  status?: ProcessorAgreementStatus | null;
  counterparty?: string | null;
  reference?: string | null;
  signedOn?: Date | null;
  termsConfirmed?: boolean | null;
  subProcessorsAuthorised?: boolean | null;
  subProcessorNote?: string | null;
  note?: string | null;
}

/**
 * Who receives the association's personal data, how each of them is classified,
 * and what agreement covers the ones that need one (GDPR art. 28).
 *
 * The classification comes first and the agreement second, because art. 28(3)
 * applies to a processor (art. 4(8)) and not to every recipient. Asking every
 * recipient for an agreement would make the record wrong rather than complete:
 * a plugin running inside the instance's own process sends nothing anywhere, an
 * instance storing files on its own disk has no processor for storage, and a
 * recipient deciding its own purposes is a controller in its own right.
 *
 * Rows are dated rather than edited in place. How a recipient was classified,
 * and which agreement covered it, is a fact about a period: recording a new row
 * closes the open one with the reason "replaced", so the record can still
 * answer what the association had agreed with whom last spring.
 */
@Injectable()
export class ProcessorAgreementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /** Every current recipient, joined with what the board has recorded. */
  async list(facts: ProcessorFacts): Promise<ProcessorView[]> {
    const open = await this.openRows();
    const byKey = new Map(open.map((row) => [row.processorKey, row]));

    return currentProcessors(facts, open).map((descriptor) => {
      const row = byKey.get(descriptor.processorKey);
      return {
        ...descriptor,
        agreement:
          row === undefined
            ? null
            : {
                agreementId: row.id,
                classification: row.classification,
                status: row.status,
                counterparty: row.counterparty,
                reference: row.reference,
                signedOn: row.signedOn?.toISOString().slice(0, 10) ?? null,
                termsConfirmed: row.termsConfirmed,
                subProcessorsAuthorised: row.subProcessorsAuthorised,
                subProcessorNote: row.subProcessorNote,
                note: row.note,
              },
      };
    });
  }

  /**
   * Records how one recipient is classified, and the agreement where there is
   * one.
   *
   * Refuses a key naming nothing the instance actually hands data to: a record
   * describing an agreement with a mail server this instance does not use would
   * be a false entry in a statutory document.
   */
  async record(
    processorKey: string,
    input: ProcessorAgreementInput & { actorPersonId: string | null },
    facts: ProcessorFacts,
  ): Promise<ProcessorView> {
    const parsed = parseProcessorKey(processorKey);
    if (parsed === null) {
      throw new ProcessorAgreementError(
        "There is no such recipient.",
        "processor-not-found",
      );
    }

    const open = await this.openRows();
    const known = currentProcessors(facts, open).some(
      (descriptor) => descriptor.processorKey === processorKey,
    );
    if (!known) {
      throw new ProcessorAgreementError(
        "This instance hands nothing to that recipient.",
        "processor-not-found",
      );
    }

    assertConsistent(input);

    return this.write(processorKey, parsed.kind, input, facts);
  }

  /** Records a recipient the board knows about and the instance cannot see. */
  async recordExternal(
    input: ProcessorAgreementInput & { actorPersonId: string | null },
    facts: ProcessorFacts,
  ): Promise<ProcessorView> {
    assertConsistent(input);

    /*
     * The key is derived from the row's own id, so a board-recorded recipient
     * is addressable like any other and its classification can be replaced the
     * same way. Written in two steps because the id does not exist until the
     * row does, and both steps and the audit entry commit together: a row left
     * open under the placeholder key would appear on the board screen as a
     * recipient called "external:pending", which is a false entry in the
     * art. 28 record.
     */
    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.processorAgreement.create({
        data: {
          processorKind: "EXTERNAL",
          processorKey: "external:pending",
          classification: input.classification,
          status: input.status ?? null,
          counterparty: input.counterparty ?? null,
          reference: input.reference ?? null,
          signedOn: input.signedOn ?? null,
          termsConfirmed: input.termsConfirmed ?? null,
          subProcessorsAuthorised: input.subProcessorsAuthorised ?? null,
          subProcessorNote: input.subProcessorNote ?? null,
          note: input.note ?? null,
          recordedByPersonId: input.actorPersonId,
        },
        select: { id: true },
      });

      await tx.processorAgreement.update({
        where: { id: row.id },
        data: { processorKey: externalProcessorKey(row.id) },
      });

      await this.audit.record(
        {
          action: "PROCESSOR_AGREEMENT_RECORDED",
          actorPersonId: input.actorPersonId,
          targetKind: "processorAgreement",
          targetId: row.id,
          context: {
            processorKind: "EXTERNAL",
            classification: input.classification,
            status: input.status ?? null,
            replaced: false,
          },
        },
        tx,
      );

      return row;
    });

    const listed = await this.list(facts);
    const view = listed.find(
      (candidate) =>
        candidate.processorKey === externalProcessorKey(created.id),
    );
    if (view === undefined) {
      throw new ProcessorAgreementError(
        "The recipient could not be read back.",
        "agreement-not-found",
      );
    }
    return view;
  }

  /** Closes an open row. */
  async end(
    agreementId: string,
    reason: string | null,
    actorPersonId: string,
  ): Promise<void> {
    const existing = await this.prisma.processorAgreement.findUnique({
      where: { id: agreementId },
      select: { id: true },
    });
    if (existing === null) {
      throw new ProcessorAgreementError(
        "There is no such record.",
        "agreement-not-found",
      );
    }

    await this.prisma.$transaction(async (tx) => {
      /*
       * Still open is asked as part of the write, not before it. The `endedAt`
       * this sets bounds the period the row describes, and a second request
       * passing a pre-read guard would move that bound and rewrite who closed
       * the record.
       */
      const { count } = await tx.processorAgreement.updateMany({
        where: { id: agreementId, endedAt: null },
        data: {
          endedAt: new Date(),
          endReason: reason,
          endedByPersonId: actorPersonId,
        },
      });
      if (count === 0) {
        throw new ProcessorAgreementError(
          "That record is already closed.",
          "already-ended",
        );
      }
      await this.audit.record(
        {
          action: "PROCESSOR_AGREEMENT_ENDED",
          actorPersonId,
          targetKind: "processorAgreement",
          targetId: agreementId,
        },
        tx,
      );
    });
  }

  /** What the board has said about each installed plugin. */
  async forPlugins(): Promise<Map<string, ProcessorAgreementState>> {
    const rows = await this.openRows();
    const states = new Map<string, ProcessorAgreementState>();

    for (const row of rows) {
      if (row.processorKind !== "PLUGIN") {
        continue;
      }
      states.set(row.processorKey.slice("plugin:".length), stateOf(row));
    }

    return states;
  }

  /**
   * Suggests the classification the instance's own configuration settles.
   *
   * Only storage on the association's own disk: that is not a recipient at all,
   * and asking a board to research its own hard drive would be asking it to
   * answer a question the product has already answered. Everything else -
   * a bucket, a mail server, whoever runs the machine - depends on who they
   * are, which the instance cannot know.
   */
  async seed(facts: ProcessorFacts, t: TFunction): Promise<void> {
    const open = await this.openRows();
    const storage = open.find((row) => row.processorKey === "storage");

    if (facts.storageDriver === "local") {
      if (storage === undefined) {
        await this.prisma.processorAgreement.create({
          data: {
            processorKind: "STORAGE",
            processorKey: "storage",
            classification: "NOT_A_PROCESSOR",
            note: t("dataProtection.processors.seed.localDisk"),
            // No actor: the instance answered this, not a board member.
            recordedByPersonId: null,
          },
        });
      }
      return;
    }

    /*
     * The driver changed to a bucket the association does not run. A seeded
     * "no processor" row would now be describing the wrong thing, so it is
     * closed and the state falls back to not recorded - which is the screen
     * asking the board a question rather than answering it wrongly.
     */
    if (storage !== undefined && storage.recordedByPersonId === null) {
      await this.prisma.processorAgreement.update({
        where: { id: storage.id },
        data: { endedAt: new Date(), endReason: "driver-changed" },
      });
    }
  }

  private async openRows() {
    return this.prisma.processorAgreement.findMany({
      where: { endedAt: null },
      select: AGREEMENT_SELECT,
    });
  }

  private async write(
    processorKey: string,
    processorKind: ProcessorKind,
    input: ProcessorAgreementInput & { actorPersonId: string | null },
    facts: ProcessorFacts,
  ): Promise<ProcessorView> {
    let replaced = false;

    await this.prisma.$transaction(async (tx) => {
      /*
       * Closed by the query rather than by an id read beforehand. One open row
       * per recipient is what `list` and `forPlugins` read the record through,
       * and two requests passing the same pre-read guard would leave two - a
       * dated record that says the association agreed two different things with
       * one recipient over the same period.
       */
      const closed = await tx.processorAgreement.updateMany({
        where: { processorKey, endedAt: null },
        data: { endedAt: new Date(), endReason: "replaced" },
      });
      replaced = closed.count > 0;

      const created = await tx.processorAgreement.create({
        data: {
          processorKind,
          processorKey,
          classification: input.classification,
          status: input.status ?? null,
          counterparty: input.counterparty ?? null,
          reference: input.reference ?? null,
          signedOn: input.signedOn ?? null,
          termsConfirmed: input.termsConfirmed ?? null,
          subProcessorsAuthorised: input.subProcessorsAuthorised ?? null,
          subProcessorNote: input.subProcessorNote ?? null,
          note: input.note ?? null,
          /*
           * Null where the instance answered rather than a board member, which
           * is what the command-line install is. `seed` tells an
           * instance-authored row from a board-authored one by this column, so
           * an empty string here would read as board-authored and the row would
           * outlive the configuration it describes.
           */
          recordedByPersonId: input.actorPersonId,
        },
        select: { id: true },
      });

      await this.audit.record(
        {
          action: "PROCESSOR_AGREEMENT_RECORDED",
          actorPersonId: input.actorPersonId,
          targetKind: "processorAgreement",
          targetId: created.id,
          // Codes and dates. Never the counterparty or the note, which name a
          // company and say why in the board's own words.
          context: {
            processorKind,
            processorKey,
            classification: input.classification,
            status: input.status ?? null,
            signedOn: input.signedOn?.toISOString().slice(0, 10) ?? null,
            termsConfirmed: input.termsConfirmed ?? null,
            subProcessorsAuthorised: input.subProcessorsAuthorised ?? null,
            replaced,
          },
        },
        tx,
      );
    });

    const view = (await this.list(facts)).find(
      (candidate) => candidate.processorKey === processorKey,
    );
    if (view === undefined) {
      throw new ProcessorAgreementError(
        "The recipient could not be read back.",
        "agreement-not-found",
      );
    }
    return view;
  }
}

/**
 * Refuses a record that would say two things at once.
 *
 * Each of these is the difference between a record that demonstrates art. 28
 * compliance and one that merely has rows in it.
 */
function assertConsistent(input: ProcessorAgreementInput): void {
  for (const value of [
    input.counterparty,
    input.reference,
    input.note,
    input.subProcessorNote,
  ]) {
    if (typeof value !== "string") {
      continue;
    }
    for (const _hit of scanForPersonalIdentityNumbers(value)) {
      throw new ProcessorAgreementError(
        "Record the agreement without a personal identity number in it.",
        "personal-identity-number",
      );
    }
  }

  if (input.classification === "PROCESSOR") {
    if (input.status == null) {
      throw new ProcessorAgreementError(
        "A processor's agreement is either in place or being made.",
        "classification-inconsistent",
      );
    }
    if ((input.counterparty ?? "").trim() === "") {
      throw new ProcessorAgreementError(
        "A processor is somebody: name the other party.",
        "counterparty-required",
      );
    }
    if (input.status === "IN_PLACE") {
      if (input.signedOn == null) {
        throw new ProcessorAgreementError(
          "An agreement in place has a date.",
          "signed-on-required",
        );
      }
      if (input.termsConfirmed !== true) {
        /*
         * art. 28(3) lists what the contract must set out - subject matter and
         * duration, the data and the subjects, the controller's instructions,
         * confidentiality, art. 32 security, sub-processing, assistance,
         * deletion or return, and audit. An agreement without them is not one
         * the article recognises, so it cannot be recorded as in place.
         */
        throw new ProcessorAgreementError(
          "An agreement is in place once it carries the terms art. 28(3) requires.",
          "terms-required",
        );
      }
    }
    return;
  }

  // Neither of the other two classifications has an agreement to describe.
  if (input.status != null) {
    throw new ProcessorAgreementError(
      "Only a processor has an agreement under art. 28(3).",
      "classification-inconsistent",
    );
  }
  if (input.termsConfirmed != null || input.subProcessorsAuthorised != null) {
    throw new ProcessorAgreementError(
      "Those answers belong to a processor's agreement.",
      "classification-inconsistent",
    );
  }
  if ((input.note ?? "").trim() === "") {
    // The reasoning is the record: why this recipient is not a processor, or
    // why it decides its own purposes.
    throw new ProcessorAgreementError(
      "Say why this recipient needs no agreement under art. 28.",
      "note-required",
    );
  }
  if (
    input.classification === "INDEPENDENT_CONTROLLER" &&
    (input.counterparty ?? "").trim() === ""
  ) {
    throw new ProcessorAgreementError(
      "An independent controller is somebody: name them.",
      "counterparty-required",
    );
  }
}
