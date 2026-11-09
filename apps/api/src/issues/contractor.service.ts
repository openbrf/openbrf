import { randomUUID } from "node:crypto";

import { Injectable, Logger } from "@nestjs/common";
import { normalizeSingleLineText } from "@openbrf/shared";

import { AuditLogService } from "../audit/audit-log.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { IssueError } from "./issue.error";
import { revokeWorkOrderLinks } from "./work-order-link";

/** A contractor as the board's register shows them. */
export interface ContractorView {
  id: string;
  name: string;
  trade: string;
  phone: string | null;
  email: string | null;
  active: boolean;
  /** How many work orders were written to them, which removing keeps. */
  workOrderCount: number;
}

/**
 * A contractor as a handler chooses one for a work order: on the list and
 * switched on. The address is shown because the preview names it as the
 * recipient; a contractor without one is offered but cannot be sent anything.
 */
export type ContractorChoice = Omit<
  ContractorView,
  "active" | "workOrderCount"
>;

export interface ContractorInput {
  name: string;
  trade: string;
  phone?: string | null;
  email?: string | null;
  active?: boolean;
}

/**
 * The association's list of contractors (entreprenör): name, trade and
 * telephone number (decision 23 of the issue module's plan), and the address a
 * work order is mailed to.
 *
 * Kept by the board under issues:configure, the capability that keeps the
 * issue types, because which firms the association hires is the board's call
 * about its building. Read by every handler, the property manager included,
 * who chooses from it on a work order.
 *
 * Not the register of persons, and nothing here reaches one: a contractor is a
 * firm the board writes down, never a person with an account, and a sole
 * trader's details are kept here and on the work orders sent them, nowhere
 * else.
 *
 * Every change to the list is audited, by the contractor's id, the kind of
 * change and which fields it touched, never their values: the list decides
 * where the association's work orders go, so a changed address is a change to
 * who receives what a handler writes. The telephone number and the address
 * are encrypted with the row's id as their context, so a cipher moved onto
 * another contractor's row does not decrypt there.
 */
@Injectable()
export class ContractorService {
  private readonly logger = new Logger(ContractorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: FieldEncryptionService,
    private readonly audit: AuditLogService,
  ) {}

  /** Every contractor on the list, switched on first, by name. */
  async list(): Promise<ContractorView[]> {
    const rows = await this.prisma.contractor.findMany({
      orderBy: [{ active: "desc" }, { name: "asc" }, { id: "asc" }],
      include: { _count: { select: { workOrders: true } } },
    });
    return Promise.all(rows.map((row) => this.viewOf(row)));
  }

  /** The contractors a handler may choose for a work order, by name. */
  async choices(): Promise<ContractorChoice[]> {
    const rows = await this.prisma.contractor.findMany({
      where: { active: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: CONTACT_SELECT,
    });
    return Promise.all(rows.map((row) => this.contactOf(row)));
  }

  async create(
    input: ContractorInput,
    actorPersonId: string,
  ): Promise<ContractorView> {
    const id = randomUUID();
    const fields = normalized(input);
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.contractor.create({
        data: {
          id,
          ...(await this.stored(id, fields)),
          active: input.active ?? true,
        },
        include: { _count: { select: { workOrders: true } } },
      });
      await this.recordChange(tx, actorPersonId, id, "added", [
        ...changedFields(EMPTY_CONTACT, fields),
        ...(created.active ? [] : ["active"]),
      ]);
      return created;
    });
    this.logger.log(`Contractor ${row.id} added`);
    return this.viewOf(row);
  }

  /**
   * Changes a contractor. Under the row's lock, which a sending takes too
   * (`lockForSending`), so an address changed while a work order is being sent
   * either reaches that sending - which then refuses it as not what was
   * previewed - or waits for it to commit.
   */
  async update(
    id: string,
    input: ContractorInput,
    actorPersonId: string,
  ): Promise<ContractorView> {
    const fields = normalized(input);
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "contractor" WHERE "id" = ${id} FOR UPDATE`;
      const before = await tx.contractor.findUnique({
        where: { id },
        select: { ...CONTACT_SELECT, active: true },
      });
      if (before === null) {
        throw contractorNotFound();
      }
      const contact = changedFields(await this.contactOf(before), fields);
      const changed = await tx.contractor.update({
        where: { id },
        data: {
          ...(await this.stored(id, fields)),
          ...(input.active === undefined ? {} : { active: input.active }),
          // A new name or address may be a new person behind it, who has not
          // been told how the association keeps their details: the next work
          // order links the privacy notice again (GDPR art. 14(3)(b)).
          ...(contact.includes("name") || contact.includes("email")
            ? { privacyNoticeGivenAt: null }
            : {}),
        },
        include: { _count: { select: { workOrders: true } } },
      });
      const touched = [
        ...contact,
        ...(changed.active === before.active ? [] : ["active"]),
      ];
      if (touched.length > 0) {
        await this.recordChange(tx, actorPersonId, id, "changed", touched);
      }
      return changed;
    });
    this.logger.log(`Contractor ${row.id} changed`);
    return this.viewOf(row);
  }

  /**
   * Removes a contractor from the list, whether or not anything was sent them,
   * and erases them from the work orders they received: the name and address
   * copied onto each are cleared, and the rows stay, so each issue still
   * records that a work order went out, when, what it said and who sent it.
   * This is how a sole trader who asks to be erased is (GDPR art. 17); a
   * board that only stops hiring a firm switches it off instead, and keeps
   * the record of whom the work orders went to.
   *
   * A work order still waiting for its mail is erased with the rest, and its
   * sending then fails as having no recipient.
   *
   * The nightly issue purge removes a contractor the same way ten years after
   * the last work order sent them (`IssuePurgeService`, ADR 0057 question 6);
   * this is the board removing one sooner.
   */
  async remove(id: string, actorPersonId: string): Promise<void> {
    const erased = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "contractor" WHERE "id" = ${id} FOR UPDATE`;
      const { removed, workOrdersErased } = await eraseContractor(tx, id);
      if (!removed) {
        throw contractorNotFound();
      }
      await this.recordChange(
        tx,
        actorPersonId,
        id,
        "removed",
        [],
        workOrdersErased,
      );
      return workOrdersErased;
    });
    this.logger.log(
      `Contractor ${id} removed, erased from ${String(erased)} work orders`,
    );
  }

  /**
   * Holds a contractor's row until the sending that read it commits, so the
   * board's change to it is decided either before that sending or after it.
   */
  async lockForSending(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "contractor" WHERE "id" = ${id} FOR SHARE`;
  }

  /**
   * A contractor on the list and switched on, with their address decrypted,
   * for a work order: null when there is none such.
   */
  async active(
    db: Prisma.TransactionClient | PrismaService,
    id: string,
  ): Promise<ContractorChoice | null> {
    const row = await db.contractor.findFirst({
      where: { id, active: true },
      select: CONTACT_SELECT,
    });
    return row === null ? null : this.contactOf(row);
  }

  /**
   * The audit entry for a change to the list: the contractor's id, the kind
   * of change, which fields it touched and, on removal, how many work orders
   * it was erased from. Never a value.
   */
  private async recordChange(
    tx: Prisma.TransactionClient,
    actorPersonId: string,
    contractorId: string,
    change: "added" | "changed" | "removed",
    fields: readonly string[],
    workOrdersErased?: number,
  ): Promise<void> {
    await this.audit.record(
      {
        action: "CONTRACTOR_LIST_CHANGED",
        channel: "WEB",
        actorPersonId,
        targetKind: "contractor",
        targetId: contractorId,
        context: {
          change,
          fields: [...fields],
          ...(workOrdersErased === undefined ? {} : { workOrdersErased }),
        },
      },
      tx,
    );
  }

  /**
   * The fields as the row stores them, the contact details encrypted with the
   * row's id as their context.
   */
  private async stored(
    id: string,
    fields: ContactFields,
  ): Promise<{
    name: string;
    trade: string;
    phoneCipher: string | null;
    emailCipher: string | null;
  }> {
    return {
      name: fields.name,
      trade: fields.trade,
      phoneCipher:
        fields.phone === null
          ? null
          : (
              await this.encryption.encrypt(
                "contractor.phone",
                fields.phone,
                id,
              )
            ).cipher,
      emailCipher:
        fields.email === null
          ? null
          : (
              await this.encryption.encrypt(
                "contractor.email",
                fields.email,
                id,
              )
            ).cipher,
    };
  }

  private async contactOf(row: ContactRow): Promise<ContractorChoice> {
    return {
      id: row.id,
      name: row.name,
      trade: row.trade,
      phone:
        row.phoneCipher === null
          ? null
          : await this.encryption.decrypt(
              "contractor.phone",
              row.phoneCipher,
              row.id,
            ),
      email:
        row.emailCipher === null
          ? null
          : await this.encryption.decrypt(
              "contractor.email",
              row.emailCipher,
              row.id,
            ),
    };
  }

  private async viewOf(
    row: ContactRow & { active: boolean; _count: { workOrders: number } },
  ): Promise<ContractorView> {
    return {
      ...(await this.contactOf(row)),
      active: row.active,
      workOrderCount: row._count.workOrders,
    };
  }
}

const CONTACT_SELECT = {
  id: true,
  name: true,
  trade: true,
  phoneCipher: true,
  emailCipher: true,
} satisfies Prisma.ContractorSelect;

type ContactRow = Prisma.ContractorGetPayload<{
  select: typeof CONTACT_SELECT;
}>;

interface ContactFields {
  name: string;
  trade: string;
  phone: string | null;
  email: string | null;
}

const EMPTY_CONTACT: ContactFields = {
  name: "",
  trade: "",
  phone: null,
  email: null,
};

/** Which of the contact fields differ, by name, for the audit entry. */
function changedFields(before: ContactFields, after: ContactFields): string[] {
  return (["name", "trade", "phone", "email"] as const).filter(
    (field) => before[field] !== after[field],
  );
}

/**
 * The fields as entered: one line each, folded as the identity-number scan
 * folds text, with an empty telephone number or address taken as none. A
 * name or trade the folding leaves empty - invisible characters and nothing
 * else, which the route's trim does not see - is refused.
 */
function normalized(input: ContractorInput): ContactFields {
  const optional = (value: string | null | undefined): string | null => {
    const text = value == null ? "" : normalizeSingleLineText(value);
    return text === "" ? null : text;
  };
  const name = normalizeSingleLineText(input.name);
  const trade = normalizeSingleLineText(input.trade);
  if (name === "" || trade === "") {
    throw new IssueError(
      "A contractor needs a name and a trade.",
      "contractor-incomplete",
    );
  }
  return {
    name,
    trade,
    phone: optional(input.phone),
    email: optional(input.email),
  };
}

function contractorNotFound(): IssueError {
  return new IssueError("No such contractor.", "contractor-not-found");
}

/**
 * Removes a contractor from the list and erases them from the work orders
 * sent them, and answers whether there was one to remove and how many work
 * orders lost their copy of the name and address. The board's removal
 * (`ContractorService.remove`) and the ten-year clock (`IssuePurgeService`)
 * both erase a contractor this way, and each records it in its own entry.
 *
 * Called under the contractor's row lock, which the caller takes. The rows
 * stay, so each issue still records that a work order went out, when, what it
 * said and who sent it.
 */
export async function eraseContractor(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<{ removed: boolean; workOrdersErased: number }> {
  const { count: workOrdersErased } = await tx.workOrder.updateMany({
    where: { contractorId: id },
    data: { recipientName: null, recipientEmailCipher: null },
  });
  // A contractor erased from their work orders holds no link to them either
  // (ADR 0055). After the work orders' update, so this takes the work order
  // rows before the link rows as issuing a link does, and two handlers
  // working on one work order cannot each hold what the other needs.
  await revokeWorkOrderLinks(tx, { contractorId: id });
  const { count } = await tx.contractor.deleteMany({ where: { id } });
  return { removed: count > 0, workOrdersErased };
}
