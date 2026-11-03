import { Injectable, Logger } from "@nestjs/common";
import { normalizeSingleLineText } from "@openbrf/shared";

import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { Prisma } from "../generated/prisma/client";
import { IssueError } from "./issue.error";

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
 */
@Injectable()
export class ContractorService {
  private readonly logger = new Logger(ContractorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: FieldEncryptionService,
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

  async create(input: ContractorInput): Promise<ContractorView> {
    const row = await this.prisma.contractor.create({
      data: {
        ...(await this.stored(input)),
        active: input.active ?? true,
      },
      include: { _count: { select: { workOrders: true } } },
    });
    this.logger.log(`Contractor ${row.id} added`);
    return this.viewOf(row);
  }

  async update(id: string, input: ContractorInput): Promise<ContractorView> {
    const data = await this.stored(input);
    const row = await this.prisma.contractor
      .update({
        where: { id },
        data: {
          ...data,
          ...(input.active === undefined ? {} : { active: input.active }),
        },
        include: { _count: { select: { workOrders: true } } },
      })
      .catch(notFound);
    this.logger.log(`Contractor ${row.id} changed`);
    return this.viewOf(row);
  }

  /**
   * Removes a contractor from the list, whether or not anything was sent them.
   * The work orders they received keep their own copy of whom they went to, so
   * the record of what left the association stays; a sole trader who asks to
   * be taken off the list can be.
   */
  async remove(id: string): Promise<void> {
    await this.prisma.contractor.delete({ where: { id } }).catch(notFound);
    this.logger.log(`Contractor ${id} removed`);
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

  /** The fields as the row stores them, the contact details encrypted. */
  private async stored(input: ContractorInput): Promise<{
    name: string;
    trade: string;
    phoneCipher: string | null;
    emailCipher: string | null;
  }> {
    const fields = normalized(input);
    return {
      name: fields.name,
      trade: fields.trade,
      phoneCipher:
        fields.phone === null
          ? null
          : (await this.encryption.encrypt("contractor.phone", fields.phone))
              .cipher,
      emailCipher:
        fields.email === null
          ? null
          : (await this.encryption.encrypt("contractor.email", fields.email))
              .cipher,
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
          : await this.encryption.decrypt("contractor.phone", row.phoneCipher),
      email:
        row.emailCipher === null
          ? null
          : await this.encryption.decrypt("contractor.email", row.emailCipher),
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

/**
 * The fields as entered: one line each, folded as the identity-number scan
 * folds text, with an empty telephone number or address taken as none. A
 * name or trade the folding leaves empty - invisible characters and nothing
 * else, which the route's trim does not see - is refused.
 */
function normalized(input: ContractorInput): {
  name: string;
  trade: string;
  phone: string | null;
  email: string | null;
} {
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

/** A contractor that is not on the list, as Prisma reports one. */
function notFound(cause: unknown): never {
  if (
    cause instanceof Prisma.PrismaClientKnownRequestError &&
    cause.code === "P2025"
  ) {
    throw new IssueError("No such contractor.", "contractor-not-found");
  }
  throw cause;
}
