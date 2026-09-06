import { Injectable, Logger } from "@nestjs/common";
import { scanForPersonalIdentityNumbers } from "@openbrf/shared";

import { AuditLogService } from "../audit/audit-log.service";
import type { Principal } from "../authorization/capabilities";
import { PrismaService } from "../database/prisma.service";
import type {
  AuditAction,
  KeyOrderKind,
  KeyOrderStatus,
} from "../generated/prisma/enums";
import { KeyOrderError, type KeyOrderTextLocation } from "./key-order.error";

/** An apartment as a resident and the board are told which one it is. */
export interface KeyOrderApartmentView {
  id: string;
  number: string;
  /** "Storgatan 12", so a household with two entrances can tell them apart. */
  address: string;
}

/** An order as the resident who placed it reads it back. */
export interface OwnKeyOrderView {
  id: string;
  /** Null where the apartment has since been corrected out of the register. */
  apartment: KeyOrderApartmentView | null;
  kind: KeyOrderKind;
  quantity: number;
  /** What the resident said the key is for, where they said anything. */
  note: string | null;
  status: KeyOrderStatus;
  /** ISO instant. */
  submittedAt: string;
  /** ISO instant, or null while the order is with the board. */
  closedAt: string | null;
  /** What the board wrote when it answered, where it wrote anything. */
  boardNote: string | null;
}

/**
 * Who ordered, as the board may be told.
 *
 * The three cases the booking calendar has, and the two that are not a plain
 * name are the point of the type.
 *
 * `protected` is a person with protected personal data (skyddade
 * personuppgifter). Their name is withheld even though the board's own address
 * book prints it, on the judgement `IssueReporterView` sets out: this payload is
 * a queue rather than a statutory register, and a board member who has to reach
 * them goes through the register that has a reason to name them. The apartment
 * is still stated, because the key is for a door rather than for a person, and
 * the board has to know which door.
 *
 * `unknown` is an orderer reference that no longer resolves to a person. Key
 * order data is service tier and a person can be purged out from under a row
 * that is still open, so the queue has to be able to say "we no longer know"
 * rather than break.
 */
export type KeyOrdererView =
  | { kind: "resident"; personId: string; name: string }
  | { kind: "protected"; personId: string }
  | { kind: "unknown" };

/** An order as the board reads it in the queue. */
export interface QueuedKeyOrderView extends OwnKeyOrderView {
  orderer: KeyOrdererView;
  /** Who closed it, when somebody has. Never a name: an identifier. */
  closedByPersonId: string | null;
}

/** What the resident's half of the screen needs in one answer. */
export interface KeyOrderIntakeView {
  /**
   * The apartments this caller may order for: the ones they live in, today.
   *
   * Part of the intake rather than a call of its own, because the form is
   * unusable without it and because it is the only list of apartments this
   * module ever discloses - a picker over the register would enumerate the
   * building to whoever loaded the form.
   */
  apartments: KeyOrderApartmentView[];
  orders: OwnKeyOrderView[];
}

/** What the board's half of the screen needs in one answer. */
export interface KeyOrderQueueView {
  orders: QueuedKeyOrderView[];
}

export interface PlaceKeyOrderInput {
  apartmentId: string;
  kind: KeyOrderKind;
  quantity: number;
  note: string | null;
}

/** What the resident may still change while the board has not answered. */
export interface ReviseKeyOrderInput {
  kind: KeyOrderKind;
  quantity: number;
  note: string | null;
}

export interface AnswerKeyOrderInput {
  /** True where the key or the tag was handed over, false to decline. */
  handedOver: boolean;
  /** What the board wants recorded with the answer, where it wants anything. */
  note: string | null;
}

/**
 * Key orders (nyckelbestallning): a resident's intake and the queue the board
 * works.
 *
 * ## Whose right, and why it is not a member's
 *
 * A resident's. No statute stands behind a key: what BRL and EFL give a member
 * are rights in the association - to put an item to a general meeting, to vote,
 * to have the board's consent weighed before letting - and a key to the entrance
 * or a tag to the bike room is none of them. It is the association's own service
 * to the household living in the apartment, and a partner, an adult child and a
 * tenant need to get through the front door exactly as a member does. So
 * `keyOrders:place` is derived from residency, the way `bookings:book` is, and
 * {@link ownApartments} takes any active residency rather than a MEMBER one.
 *
 * That is the deliberate opposite of the sublets module beside it, where the act
 * is the bostadsrattshavare's because BRL 7 kap. 10 § says "sin lagenhet". The
 * two decisions are made separately and for different reasons, and neither
 * follows from the other.
 *
 * The board may decline an order, which the motion queue has no equivalent of:
 * refusing to take up a member's motion is not the board's to decide under EFL
 * 6 kap. 15 §, and refusing somebody a fourth tag to the bike room plainly is.
 *
 * ## The apartment, and why it is checked
 *
 * The apartment named in the request has to be one the caller lives in, asked of
 * the register at the moment of the order. An administrator holds every
 * capability in the model and no residency, so this is what keeps the one
 * account that can do everything from ordering a key to somebody else's home;
 * and a household that has moved out stops being able to order on the day the
 * residency ends rather than when somebody remembers to change something.
 *
 * ## Free text
 *
 * The resident's note and the board's answer are both scanned for a Swedish
 * personal identity number and refused if they carry one, on the way in and on
 * every later edit. An order placed on behalf of somebody else in the household
 * is exactly the sentence a number gets written into, and the note is printed in
 * full on a data subject access report. The refusal names the field and the
 * offset and never the value.
 *
 * ## No amount
 *
 * Nothing here records what a key costs. That is a charge (debitering) with its
 * own model, its own VAT treatment and its own export to whoever keeps the
 * association's books, and a second place holding a sum would be a second answer
 * to what the member owes. A handover recorded here is the basis such a charge
 * would be raised from; the join runs from the charge to the order.
 */
@Injectable()
export class KeyOrderService {
  private readonly logger = new Logger(KeyOrderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /** The resident's own orders, newest first, and the apartments they may order for. */
  async intake(personId: string): Promise<KeyOrderIntakeView> {
    const [apartments, orders] = await Promise.all([
      this.ownApartments(personId),
      this.prisma.keyOrder.findMany({
        where: { orderedByPersonId: personId },
        orderBy: { submittedAt: "desc" },
        select: ORDER_COLUMNS,
      }),
    ]);

    return { apartments, orders: orders.map(toOwnView) };
  }

  /**
   * The apartments this caller may order for: the ones they live in, today.
   *
   * Any active residency and not only a MEMBER one, exactly as
   * `BookingService.ownApartments` reads it and for the same reason: the
   * capability is granted for living here rather than for holding the
   * tenant-ownership, so a MEMBER-only derivation would leave a partner or a
   * tenant with no door to order a key to.
   *
   * MEMBER residencies first, so a household holding one apartment as members
   * and another as tenants gets the one they hold first. Deduplicated, because
   * joint holders and successive residencies of one apartment are several rows
   * about one home.
   */
  async ownApartments(personId: string): Promise<KeyOrderApartmentView[]> {
    const residencies = await this.prisma.residency.findMany({
      where: {
        personId,
        OR: [{ movedOutOn: null }, { movedOutOn: { gt: new Date() } }],
      },
      select: { apartment: { select: APARTMENT_SELECT } },
      orderBy: [{ role: "asc" }, { movedInOn: "asc" }],
    });

    const seen = new Set<string>();
    const apartments: KeyOrderApartmentView[] = [];
    for (const residency of residencies) {
      if (seen.has(residency.apartment.id)) {
        continue;
      }
      seen.add(residency.apartment.id);
      apartments.push(toApartmentView(residency.apartment));
    }
    return apartments;
  }

  /**
   * Places an order, and records that a resident asked for it.
   *
   * The row and its audit entry are one transaction. An order whose entry rolled
   * back would leave the resident's own access report unable to show that they
   * asked, and the entry outlives the row by design - it is what answers "I
   * ordered one, and this is when" once the purge has erased the order itself.
   */
  async place(
    principal: Principal,
    input: PlaceKeyOrderInput,
  ): Promise<{ id: string }> {
    await this.requireOwnApartment(principal.personId, input.apartmentId);
    this.refusePersonalIdentityNumbers({ note: input.note ?? undefined });

    const order = await this.prisma.$transaction(async (tx) => {
      const created = await tx.keyOrder.create({
        data: {
          orderedByPersonId: principal.personId,
          apartmentId: input.apartmentId,
          kind: input.kind,
          quantity: input.quantity,
          note: input.note,
        },
        select: { id: true },
      });

      await this.audit.record(
        {
          action: "KEY_ORDER_PLACED",
          // Actor and subject are the same person: the order is theirs and
          // nobody places it on anybody's behalf.
          actorPersonId: principal.personId,
          targetPersonId: principal.personId,
          targetKind: "keyOrder",
          targetId: created.id,
          /*
           * What was ordered and how much of it, and never the note: the log is
           * append-only and exempt from every purge, so text copied into it
           * would outlive the row it came from and stay after the retention
           * window erased the original. The kind and the quantity are facts
           * about the order rather than about the household, and they are what
           * makes the entry able to say what was asked for once the row is gone.
           */
          context: {
            apartmentId: input.apartmentId,
            kind: input.kind,
            quantity: input.quantity,
            noteLength: input.note?.length ?? 0,
          },
        },
        tx,
      );

      return created;
    });

    // The identifier and the act. What a resident wants a key for is theirs and
    // has no business in a log line.
    this.logger.log(`Key order ${order.id} placed`);
    return order;
  }

  /**
   * Changes a standing order, while the board has not answered.
   *
   * What is ordered and how much of it, and deliberately not the apartment: an
   * order for a different door is a different order, and rewriting the apartment
   * on a row the board may already have read would make the queue say something
   * nobody asked. Withdraw and order again is the honest path.
   *
   * Scoped to the caller's own orders in the same query that finds it, so one
   * belonging to somebody else answers exactly as one that does not exist.
   */
  async revise(
    personId: string,
    orderId: string,
    input: ReviseKeyOrderInput,
  ): Promise<OwnKeyOrderView> {
    this.refusePersonalIdentityNumbers({ note: input.note ?? undefined });

    const existing = await this.prisma.keyOrder.findFirst({
      where: { id: orderId, orderedByPersonId: personId },
      select: { id: true, status: true },
    });
    if (existing === null) {
      // Deliberately the same answer as an order that was never placed: see the
      // reasoning on KeyOrderError.
      throw new KeyOrderError("No such order.", "order-not-found");
    }
    if (existing.status !== "SUBMITTED") {
      throw new KeyOrderError(
        "The board has answered this order.",
        "already-closed",
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.keyOrder.updateMany({
        // Conditional on the state rather than on the primary key alone: this is
        // what makes the check above a decision instead of a read that a board
        // member's answer can invalidate before the write lands.
        where: { id: orderId, status: "SUBMITTED" },
        data: { kind: input.kind, quantity: input.quantity, note: input.note },
      });
      if (count === 0) {
        throw new KeyOrderError(
          "The board has answered this order.",
          "already-closed",
        );
      }

      const updated = await tx.keyOrder.findUniqueOrThrow({
        where: { id: orderId },
        select: ORDER_COLUMNS,
      });

      await this.audit.record(
        {
          action: "KEY_ORDER_REVISED",
          actorPersonId: personId,
          targetPersonId: personId,
          targetKind: "keyOrder",
          targetId: orderId,
          context: {
            kind: input.kind,
            quantity: input.quantity,
            noteLength: input.note?.length ?? 0,
          },
        },
        tx,
      );

      this.logger.log(`Key order ${orderId} revised`);
      return toOwnView(updated);
    });
  }

  /**
   * Takes one's own order back, while the board has not answered.
   *
   * The row stays and takes a date and a status. Nothing in this module deletes
   * an order except the purge.
   */
  async withdraw(personId: string, orderId: string): Promise<OwnKeyOrderView> {
    const existing = await this.prisma.keyOrder.findFirst({
      where: { id: orderId, orderedByPersonId: personId },
      select: { id: true, status: true },
    });
    if (existing === null) {
      throw new KeyOrderError("No such order.", "order-not-found");
    }
    if (existing.status !== "SUBMITTED") {
      throw new KeyOrderError(
        "The board has answered this order.",
        "already-closed",
      );
    }

    return this.close({
      orderId,
      status: "WITHDRAWN",
      actorPersonId: personId,
      subjectPersonId: personId,
      action: "KEY_ORDER_WITHDRAWN",
      note: null,
    });
  }

  /**
   * The board's queue.
   *
   * Open orders first and oldest first within a status, because the queue is
   * worked from the top and the order that has been waiting longest is the one
   * to look at. SUBMITTED sorts before the three closed states by the order the
   * enum declares, which is the order a board reads them in.
   */
  async queue(filter?: {
    status?: KeyOrderStatus;
  }): Promise<KeyOrderQueueView> {
    const orders = await this.prisma.keyOrder.findMany({
      where: filter?.status === undefined ? {} : { status: filter.status },
      orderBy: [{ status: "asc" }, { submittedAt: "asc" }],
      select: ORDER_COLUMNS,
    });

    const orderers = await this.orderersOf(orders);

    return {
      orders: orders.map((order) => ({
        ...toOwnView(order),
        closedByPersonId: order.closedByPersonId,
        orderer: ordererOf(order.orderedByPersonId, orderers),
      })),
    };
  }

  /**
   * Records the handover, or that the board declined the order.
   *
   * The handover is the act the record exists for: a key to the building went to
   * a named person on a day, and it is written down as its own audit action so
   * the association can still say so once the order row has been purged.
   */
  async answer(
    orderId: string,
    actorPersonId: string,
    input: AnswerKeyOrderInput,
  ): Promise<QueuedKeyOrderView> {
    if (input.note !== null) {
      this.refusePersonalIdentityNumbers({ boardNote: input.note });
    }

    const existing = await this.prisma.keyOrder.findUnique({
      where: { id: orderId },
      select: { id: true, status: true, orderedByPersonId: true },
    });
    if (existing === null) {
      throw new KeyOrderError("No such order.", "order-not-found");
    }
    if (existing.status !== "SUBMITTED") {
      throw new KeyOrderError(
        "This order has already been answered.",
        "already-closed",
      );
    }

    const closed = await this.close({
      orderId,
      status: input.handedOver ? "HANDED_OVER" : "DECLINED",
      actorPersonId,
      // The subject stays the resident who ordered, so their own access report
      // shows what the board did with their order rather than only what they did
      // themselves.
      subjectPersonId: existing.orderedByPersonId,
      action: input.handedOver ? "KEY_ORDER_HANDED_OVER" : "KEY_ORDER_DECLINED",
      note: input.note,
    });

    const orderers = await this.orderersOf([
      { orderedByPersonId: existing.orderedByPersonId },
    ]);

    return {
      ...closed,
      closedByPersonId: actorPersonId,
      orderer: ordererOf(existing.orderedByPersonId, orderers),
    };
  }

  /**
   * Closes an order one way or the other, with the entry in the same
   * transaction.
   *
   * The status, the closing date and the board's note are written together and
   * the update is conditional on the order still being open, so two clicks
   * racing produce one close: the loser's update matches no row and is answered
   * exactly as a read would have answered it.
   */
  private async close(input: {
    orderId: string;
    status: Exclude<KeyOrderStatus, "SUBMITTED">;
    actorPersonId: string;
    subjectPersonId: string;
    action: AuditAction;
    note: string | null;
  }): Promise<OwnKeyOrderView> {
    return this.prisma.$transaction(async (tx) => {
      const closedAt = new Date();
      const { count } = await tx.keyOrder.updateMany({
        where: { id: input.orderId, status: "SUBMITTED" },
        data: {
          status: input.status,
          closedAt,
          closedByPersonId: input.actorPersonId,
          // Written only where there is one, so a withdrawal cannot blank a note
          // and a second answer cannot leave a stale one behind.
          ...(input.note === null ? {} : { boardNote: input.note }),
        },
      });
      if (count === 0) {
        throw new KeyOrderError(
          "This order has already been answered.",
          "already-closed",
        );
      }

      const order = await tx.keyOrder.findUniqueOrThrow({
        where: { id: input.orderId },
        select: ORDER_COLUMNS,
      });

      await this.audit.record(
        {
          action: input.action,
          actorPersonId: input.actorPersonId,
          targetPersonId: input.subjectPersonId,
          targetKind: "keyOrder",
          targetId: input.orderId,
          // What went and how much of it, so the entry still says what was
          // handed over once the row is gone. Never the note either side wrote.
          context: {
            status: input.status,
            kind: order.kind,
            quantity: order.quantity,
            noteLength: input.note?.length ?? 0,
          },
        },
        tx,
      );

      this.logger.log(`Key order ${input.orderId} moved to ${input.status}`);
      return toOwnView(order);
    });
  }

  /**
   * Refuses an apartment the caller does not live in.
   *
   * Asked of the register rather than of the principal, and asked about the
   * apartment rather than about the person: an account holding
   * `keyOrders:place` still has to name a door that is theirs. An administrator
   * holds every capability and no residency, so they match nothing here.
   */
  private async requireOwnApartment(
    personId: string,
    apartmentId: string,
  ): Promise<void> {
    const held = await this.prisma.residency.count({
      where: {
        personId,
        apartmentId,
        OR: [{ movedOutOn: null }, { movedOutOn: { gt: new Date() } }],
      },
    });
    if (held === 0) {
      // Deliberately the same answer as an apartment that is not in the register
      // at all, on `BookingService.requireOwnApartment`'s reasoning: a
      // distinguishable answer would let this endpoint enumerate the building.
      throw new KeyOrderError("No such apartment.", "apartment-not-found");
    }
  }

  /**
   * The people who placed these orders, as the queue may name them.
   *
   * `orderedByPersonId` is a plain column and not a relation - which is what lets
   * the purge reach this table at all - so the persons are read in a query of
   * their own rather than joined off the order.
   */
  private async orderersOf(
    orders: readonly { orderedByPersonId: string }[],
  ): Promise<
    Map<
      string,
      { firstName: string; lastName: string; protectedPersonalData: boolean }
    >
  > {
    const ids = [...new Set(orders.map((order) => order.orderedByPersonId))];
    if (ids.length === 0) {
      return new Map();
    }

    const persons = await this.prisma.person.findMany({
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

  /**
   * Refuses text carrying a Swedish personal identity number.
   *
   * The same rule a page, a news item, a motion and a subletting application
   * live under. An order travels: the note is read by the board and printed in
   * full on the resident's own data subject access report, and the board's
   * answer is quoted back to them on their own screen. It usually arrives pasted
   * along with the text around it rather than because anybody decided to publish
   * it - an order placed for a lodger or an adult child is exactly the sentence
   * it turns up in.
   *
   * The refusal names the field and the offset and never the value. What the
   * scan caught is precisely the thing that must not travel back in a response
   * body.
   */
  private refusePersonalIdentityNumbers(
    parts: Partial<Record<KeyOrderTextLocation["part"], string>>,
  ): void {
    const locations: KeyOrderTextLocation[] = [];
    for (const [part, text] of Object.entries(parts)) {
      if (text === undefined) {
        continue;
      }
      for (const hit of scanForPersonalIdentityNumbers(text)) {
        locations.push({
          part: part as KeyOrderTextLocation["part"],
          offset: hit.index,
        });
      }
    }

    if (locations.length > 0) {
      throw new KeyOrderError(
        "The order carries a personal identity number and cannot be stored.",
        "personal-identity-number",
        locations,
      );
    }
  }
}

const APARTMENT_SELECT = {
  id: true,
  number: true,
  address: { select: { street: true, number: true } },
} as const;

const ORDER_COLUMNS = {
  id: true,
  orderedByPersonId: true,
  apartment: { select: APARTMENT_SELECT },
  kind: true,
  quantity: true,
  note: true,
  status: true,
  submittedAt: true,
  closedAt: true,
  closedByPersonId: true,
  boardNote: true,
} as const;

interface ApartmentRecord {
  id: string;
  number: string;
  address: { street: string; number: string };
}

interface OrderRecord {
  id: string;
  apartment: ApartmentRecord | null;
  kind: KeyOrderKind;
  quantity: number;
  note: string | null;
  status: KeyOrderStatus;
  submittedAt: Date;
  closedAt: Date | null;
  boardNote: string | null;
}

function toApartmentView(apartment: ApartmentRecord): KeyOrderApartmentView {
  return {
    id: apartment.id,
    number: apartment.number,
    address: `${apartment.address.street} ${apartment.address.number}`,
  };
}

function toOwnView(order: OrderRecord): OwnKeyOrderView {
  return {
    id: order.id,
    apartment:
      order.apartment === null ? null : toApartmentView(order.apartment),
    kind: order.kind,
    quantity: order.quantity,
    note: order.note,
    status: order.status,
    submittedAt: order.submittedAt.toISOString(),
    closedAt: order.closedAt?.toISOString() ?? null,
    boardNote: order.boardNote,
  };
}

function ordererOf(
  personId: string,
  persons: ReadonlyMap<
    string,
    { firstName: string; lastName: string; protectedPersonalData: boolean }
  >,
): KeyOrdererView {
  const person = persons.get(personId);
  if (person === undefined) {
    return { kind: "unknown" };
  }
  if (person.protectedPersonalData) {
    return { kind: "protected", personId };
  }
  return {
    kind: "resident",
    personId,
    name: `${person.firstName} ${person.lastName}`.trim(),
  };
}
