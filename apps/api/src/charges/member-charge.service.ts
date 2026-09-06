import { Injectable } from "@nestjs/common";
import { scanForPersonalIdentityNumbers } from "@openbrf/shared";

import { isMasked } from "../address-book/address-book-view";
import { AuditLogService } from "../audit/audit-log.service";
import {
  compareLocalDays,
  dateColumnOf,
  formatLocalDay,
  type LocalDay,
  localDayOf,
  localDayOfColumn,
  parseLocalDay,
} from "../bookings/stockholm-calendar";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import {
  type DebitingList,
  type DebitingListApartment,
  debitingListFileName,
  type DebitingListParty,
  type DebitingListRow,
  sumChargeAmounts,
  writeDebitingList,
} from "./debiting-list";
import {
  MemberChargeError,
  type MemberChargeTextLocation,
} from "./member-charge.error";

/** What the purge and the log call a charge. */
export const MEMBER_CHARGE_TARGET_KIND = "memberCharge";

/** The VAT treatments a board may state. Mirrors the Prisma enum. */
export type VatTreatment = "EXEMPT" | "RATE";

/** What a board states when recording a charge. */
export interface RecordMemberChargeInput {
  actorPersonId: string;
  /** Exactly one of these two, per the model's own rule. */
  personId?: string | null;
  apartmentId?: string | null;
  /** "YYYY-MM-DD" on the association's own calendar. */
  chargedOn: string;
  /** Kronor as a decimal string, e.g. "450.00". */
  amount: string;
  reason: string;
  vatTreatment: VatTreatment;
  vatRatePercent?: number | null;
  /** "YYYY-MM-DD", where the basis has already gone to the manager. */
  handedToManagerOn?: string | null;
}

/**
 * What a board may change afterwards, and the one thing it may not.
 *
 * The charged party is absent from this list. A charge put on the wrong person
 * is not the same charge with a name corrected - it is a charge that was never
 * owed, and one that was. Moving it would leave the log saying the association
 * charged somebody it then silently stopped having charged, and the person who
 * was charged in the meantime with no record of it on their own access report.
 * So the board removes it and records the right one, which is two entries that
 * say what happened.
 */
export interface CorrectMemberChargeInput {
  actorPersonId: string;
  chargedOn?: string;
  amount?: string;
  reason?: string;
  vatTreatment?: VatTreatment;
  vatRatePercent?: number | null;
  handedToManagerOn?: string | null;
}

/** The debiting list plus the file it is handed over as. */
export interface DebitingListExport {
  list: DebitingList;
  fileName: string;
  csv: string;
}

/**
 * A charge read back, as much of the person as a row needs.
 *
 * `toFixed` rather than `toString`, because the two disagree on exactly the
 * value this module cares about: a `DECIMAL(14, 2)` holding 450 renders as
 * "450" through one and "450.00" through the other, and the file the bookkeeper
 * reads has to state ore.
 */
interface AmountValue {
  toFixed: (places: number) => string;
}

interface ChargeRecord {
  id: string;
  personId: string | null;
  apartmentId: string | null;
  chargedOn: Date;
  amount: AmountValue;
  reason: string;
  vatTreatment: VatTreatment;
  vatRatePercent: number | null;
  handedToManagerOn: Date | null;
}

const CHARGE_FIELDS = {
  id: true,
  personId: true,
  apartmentId: true,
  chargedOn: true,
  amount: true,
  reason: true,
  vatTreatment: true,
  vatRatePercent: true,
  handedToManagerOn: true,
} as const;

/**
 * Charges to members (debiteringar mot medlem): the basis for a one-off cost the
 * board puts on a member or on an apartment, and the debiting list it is handed
 * over as.
 *
 * ## What this module is not
 *
 * It is not a ledger. There is no payment, no outstanding balance and no status
 * that stands in for one, and adding any of them is the one change this module
 * will not take: the accounting system is where a debt is settled, and a second
 * answer to whether a charge has been paid is worse than none. The nearest thing
 * to a workflow field is `handedToManagerOn`, which says when the basis left the
 * association for whoever keeps its books and nothing about what happened to it
 * after that.
 *
 * It is also not the delivering half. Posting to an accounting system, autogiro
 * and bankgiro files, reminders, collections, an approval step and recurring
 * charges are the paid module, and nothing here is shaped to receive them: there
 * is no export target, no schedule and no hook, because a seam left for a thing
 * that does not exist is a guess about its shape.
 *
 * ## Where the personal data is
 *
 * A charge against a person is obviously about them. A charge against an
 * apartment is about them too, because the apartment leads back to whoever lives
 * there - which is why both kinds sit in the service tier under this
 * association's ordinary access control, reach the data subject access report,
 * and are erased by a purge of their own.
 *
 * The reason is board-written free text about a named person, so it is scanned
 * for a Swedish personal identity number on the way in and on every later edit,
 * and the refusal names the field it was found in. That is what every
 * board-written free-text field in this product does, and the argument is the
 * same: a personnummer arrives pasted along with the text around it rather than
 * because somebody decided to write one down, and this text is copied into a
 * file that leaves the association.
 */
@Injectable()
export class MemberChargeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * Records one charge.
   *
   * The write and the entry that records it are one transaction, for the reason
   * every audited write in this product gives: a log claiming an act that rolled
   * back is worse than no log.
   */
  async record(
    input: RecordMemberChargeInput,
    now: Date = new Date(),
  ): Promise<DebitingListRow> {
    const personId = input.personId ?? null;
    const apartmentId = input.apartmentId ?? null;
    if (personId === null && apartmentId === null) {
      throw new MemberChargeError(
        "A charge has to name the person or the apartment it is put on.",
        "party-required",
      );
    }
    if (personId !== null && apartmentId !== null) {
      throw new MemberChargeError(
        "A charge is put on a person or on an apartment, not on both.",
        "party-ambiguous",
      );
    }

    const chargedOn = this.readPastDate(input.chargedOn, now);
    const handedToManagerOn = this.readHandOver(
      input.handedToManagerOn ?? null,
      chargedOn,
      now,
    );
    const amount = readAmount(input.amount);
    const reason = readReason(input.reason);
    const vatRatePercent = readVatRate(
      input.vatTreatment,
      input.vatRatePercent,
    );
    refusePersonalIdentityNumbers({ reason });

    const charge = await this.prisma.$transaction(async (tx) => {
      await this.requireParty(tx, personId, apartmentId);

      const created = await tx.memberCharge.create({
        data: {
          personId,
          apartmentId,
          chargedOn: dateColumnOf(chargedOn),
          amount,
          reason,
          vatTreatment: input.vatTreatment,
          vatRatePercent,
          handedToManagerOn:
            handedToManagerOn === null ? null : dateColumnOf(handedToManagerOn),
          recordedByPersonId: input.actorPersonId,
        },
        select: CHARGE_FIELDS,
      });

      await this.audit.record(
        {
          action: "MEMBER_CHARGE_RECORDED",
          actorPersonId: input.actorPersonId,
          /*
           * The person charged, so the charge appears on their own access report
           * as something the association did to them. Null on an apartment
           * charge: which of its residents the subject would be is a question
           * the log must not answer by guessing, and the apartment is named in
           * the context instead.
           */
          targetPersonId: personId,
          targetKind: MEMBER_CHARGE_TARGET_KIND,
          targetId: created.id,
          /*
           * Identifiers and an enum value. Not the amount, not the date and not
           * the reason: the log is append-only and exempt from every purge, and
           * a sum copied in here would be a permanent record of what a named
           * person was charged, sitting inside the entry that says the charge
           * itself is erasable. `targetId` is what the entry is for, and the
           * figures are read from the row while the row exists.
           */
          context: {
            party: personId === null ? "apartment" : "person",
            apartmentId,
            vatTreatment: input.vatTreatment,
          },
        },
        tx,
      );

      return created;
    });

    return this.rowFor(charge);
  }

  /**
   * Corrects a recorded charge.
   *
   * Every field the board may change at once, and the entry names which of them
   * moved. One act rather than one per field, and in particular the hand-over
   * date is not its own: it is a fact about the charge like the date and the
   * figure, and a route of its own would suggest a state machine this module
   * does not have and is not going to grow.
   */
  async correct(
    id: string,
    input: CorrectMemberChargeInput,
    now: Date = new Date(),
  ): Promise<DebitingListRow> {
    const charge = await this.prisma.memberCharge.findUnique({
      where: { id },
      select: CHARGE_FIELDS,
    });
    if (charge === null) {
      throw new MemberChargeError("There is no such charge.", "not-found");
    }

    const chargedOn =
      input.chargedOn === undefined
        ? localDayOfColumn(charge.chargedOn)
        : this.readPastDate(input.chargedOn, now);

    const handedToManagerOn =
      input.handedToManagerOn === undefined
        ? charge.handedToManagerOn === null
          ? null
          : localDayOfColumn(charge.handedToManagerOn)
        : this.readHandOver(input.handedToManagerOn, chargedOn, now);
    /*
     * Checked again when only the charge date moved. The pair is an invariant
     * about the row rather than a validation of one field, so a charge dated
     * forward past a hand-over already recorded has to be refused too - the
     * board is told to move the hand-over as well, rather than being left with a
     * row saying the basis was sent before the charge existed.
     */
    if (
      input.handedToManagerOn === undefined &&
      handedToManagerOn !== null &&
      compareLocalDays(handedToManagerOn, chargedOn) < 0
    ) {
      throw new MemberChargeError(
        "The basis cannot have reached the economic manager before the charge was made.",
        "handed-over-before-charge",
      );
    }

    const amount =
      input.amount === undefined ? undefined : readAmount(input.amount);
    const reason =
      input.reason === undefined ? undefined : readReason(input.reason);
    const vatTreatment = input.vatTreatment ?? charge.vatTreatment;
    const vatRatePercent = readVatRate(
      vatTreatment,
      input.vatTreatment === undefined && input.vatRatePercent === undefined
        ? charge.vatRatePercent
        : (input.vatRatePercent ?? null),
    );
    if (reason !== undefined) {
      refusePersonalIdentityNumbers({ reason });
    }

    const fields = changedFields(charge, {
      chargedOn,
      amount,
      reason,
      vatTreatment,
      vatRatePercent,
      handedToManagerOn,
    });

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.memberCharge.update({
        where: { id },
        data: {
          chargedOn: dateColumnOf(chargedOn),
          ...(amount === undefined ? {} : { amount }),
          ...(reason === undefined ? {} : { reason }),
          vatTreatment,
          vatRatePercent,
          handedToManagerOn:
            handedToManagerOn === null ? null : dateColumnOf(handedToManagerOn),
        },
        select: CHARGE_FIELDS,
      });

      await this.audit.record(
        {
          action: "MEMBER_CHARGE_CORRECTED",
          actorPersonId: input.actorPersonId,
          targetPersonId: charge.personId,
          targetKind: MEMBER_CHARGE_TARGET_KIND,
          targetId: id,
          // Which fields moved, and never what they moved to or from. The field
          // name is what makes the entry answerable; the values live on the row.
          context: { fields },
        },
        tx,
      );

      return row;
    });

    return this.rowFor(updated);
  }

  /**
   * Removes a charge.
   *
   * Removal and not a cancelled flag. A charge entered by mistake was never
   * owed, and a row kept with a marker saying so would be a second answer to
   * what the association is charging - which is the shape this module refuses
   * everywhere else. What survives is the audit entry, which says the charge
   * existed and that a named board member took it away.
   */
  async remove(id: string, actorPersonId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const charge = await tx.memberCharge.findUnique({
        where: { id },
        select: { id: true, personId: true, apartmentId: true },
      });
      if (charge === null) {
        throw new MemberChargeError("There is no such charge.", "not-found");
      }

      await tx.memberCharge.delete({ where: { id } });

      await this.audit.record(
        {
          action: "MEMBER_CHARGE_REMOVED",
          actorPersonId,
          targetPersonId: charge.personId,
          targetKind: MEMBER_CHARGE_TARGET_KIND,
          targetId: id,
          context: {
            party: charge.personId === null ? "apartment" : "person",
            apartmentId: charge.apartmentId,
          },
        },
        tx,
      );
    });
  }

  /**
   * The debiting list for a period, as the board reads it on screen.
   *
   * Not audited, unlike {@link exportList} below. Reading the charges is the
   * board working in its own instance, the way reading the booking calendar is;
   * what carries an entry is the copy that leaves the association. The statutory
   * registers are audited on the read because an extract of one is public on
   * request and the log has to answer who took a copy - a charge is neither.
   */
  async list(
    from: string,
    to: string,
    now: Date = new Date(),
  ): Promise<DebitingList> {
    const period = this.readPeriod(from, to);
    return this.build(this.prisma, period, now);
  }

  /**
   * The same list as the file the board hands over, with the entry that records
   * the disclosure.
   *
   * A POST rather than a GET on the controller, and audited here rather than
   * there, for the reason the register supply gives: this is a copy of named
   * people's charges leaving the association for a recipient outside it, and an
   * audited disclosure has to be an act somebody chose to take rather than
   * something a prefetch, a bookmark or a link checker could cause.
   */
  async exportList(
    input: { actorPersonId: string; from: string; to: string },
    now: Date = new Date(),
  ): Promise<DebitingListExport> {
    const period = this.readPeriod(input.from, input.to);

    const list = await this.audit.withAuditedRead<DebitingList>(
      {
        action: "DEBITING_LIST_EXPORTED",
        actorPersonId: input.actorPersonId,
        // The period asked for and how many rows it answered with. No name and
        // no figure: this entry says who took a copy of what, which is the
        // question a supervisory authority asks, and the copy itself is the
        // file rather than the log.
        context: { from: period.from, to: period.to },
      },
      async (tx) => this.build(tx, period, now),
    );

    return {
      list,
      fileName: debitingListFileName(period.from, period.to),
      csv: writeDebitingList(list),
    };
  }

  /** The period a read covers, as calendar dates the board stated. */
  private readPeriod(
    from: string,
    to: string,
  ): {
    fromDay: LocalDay;
    toDay: LocalDay;
    from: string;
    to: string;
  } {
    const fromDay = parseLocalDay(from);
    const toDay = parseLocalDay(to);
    if (fromDay === null || toDay === null) {
      throw new MemberChargeError(
        "A period is stated as two calendar dates.",
        "date-not-a-calendar-date",
      );
    }
    if (compareLocalDays(fromDay, toDay) > 0) {
      throw new MemberChargeError(
        "A period cannot end before it begins.",
        "range-invalid",
      );
    }
    return {
      fromDay,
      toDay,
      from: formatLocalDay(fromDay),
      to: formatLocalDay(toDay),
    };
  }

  /**
   * A date the board states about a charge, refused where it has not arrived.
   *
   * The same two refusals `registers/statutory-date.ts` makes, and made here
   * rather than through it: that module is about dates on rows the database will
   * not let anybody correct, and a charge is correctable. What the two share is
   * the comparison, which is the recurring bug in this repository - a date column
   * read back is midnight UTC and an instant is a moment, so the question has to
   * be asked of calendar days or a board recording a charge at half past midnight
   * is told today is in the future.
   */
  private readPastDate(text: string, now: Date): LocalDay {
    const day = parseLocalDay(text);
    if (day === null) {
      throw new MemberChargeError(
        "That is not a calendar date.",
        "date-not-a-calendar-date",
      );
    }
    if (compareLocalDays(day, localDayOf(now)) > 0) {
      throw new MemberChargeError(
        "A charge cannot be dated in the future.",
        "date-in-the-future",
      );
    }
    return day;
  }

  /** The hand-over date, which cannot precede the charge or lie ahead. */
  private readHandOver(
    text: string | null,
    chargedOn: LocalDay,
    now: Date,
  ): LocalDay | null {
    if (text === null) {
      return null;
    }
    const day = parseLocalDay(text);
    if (day === null) {
      throw new MemberChargeError(
        "That is not a calendar date.",
        "date-not-a-calendar-date",
      );
    }
    if (compareLocalDays(day, localDayOf(now)) > 0) {
      throw new MemberChargeError(
        "The basis cannot have gone to the economic manager on a day that has not come.",
        "handed-over-in-the-future",
      );
    }
    if (compareLocalDays(day, chargedOn) < 0) {
      throw new MemberChargeError(
        "The basis cannot have reached the economic manager before the charge was made.",
        "handed-over-before-charge",
      );
    }
    return day;
  }

  /** Refuses a charged party the register does not hold. */
  private async requireParty(
    tx: Prisma.TransactionClient,
    personId: string | null,
    apartmentId: string | null,
  ): Promise<void> {
    if (personId !== null) {
      const person = await tx.person.findUnique({
        where: { id: personId },
        select: { id: true },
      });
      if (person === null) {
        throw new MemberChargeError(
          "There is no such person.",
          "person-not-found",
        );
      }
      return;
    }
    const apartment = await tx.apartment.findUnique({
      where: { id: apartmentId ?? "" },
      select: { id: true },
    });
    if (apartment === null) {
      throw new MemberChargeError(
        "There is no such apartment.",
        "apartment-not-found",
      );
    }
  }

  /** One charge read back on its own, for the answer to a write. */
  private async rowFor(charge: ChargeRecord): Promise<DebitingListRow> {
    const parties = await this.partiesFor(this.prisma, [charge]);
    return toRow(charge, parties);
  }

  private async build(
    client: PrismaService | Prisma.TransactionClient,
    period: { fromDay: LocalDay; toDay: LocalDay; from: string; to: string },
    now: Date,
  ): Promise<DebitingList> {
    const association = await client.association.findUnique({
      where: { id: 1 },
      select: { name: true, organizationNumber: true },
    });

    const charges = await client.memberCharge.findMany({
      where: {
        chargedOn: {
          gte: dateColumnOf(period.fromDay),
          lte: dateColumnOf(period.toDay),
        },
      },
      // The day first, because the list is read as a period; then the order they
      // were entered in, so two charges on one day keep the sequence the board
      // typed them in rather than an order the database happened to return.
      orderBy: [{ chargedOn: "asc" }, { createdAt: "asc" }],
      select: CHARGE_FIELDS,
    });

    const parties = await this.partiesFor(client, charges);
    const rows = charges.map((charge) => toRow(charge, parties));

    return {
      housingCooperative: {
        name: association?.name ?? "",
        organizationNumber: association?.organizationNumber ?? null,
      },
      from: period.from,
      to: period.to,
      generatedOn: formatLocalDay(localDayOf(now)),
      rows,
      total: sumChargeAmounts(rows.map((row) => row.amount)),
    };
  }

  /**
   * The charged parties for a set of charges, read in two queries.
   *
   * `personId` is a plain column and not a relation, for the reason the model
   * gives, so the people are read separately rather than joined. Their apartment
   * comes from the residencies covering the charge's own day rather than from
   * where they live now: the list is a record of a period, and a household that
   * moved in October would otherwise appear against the new flat on a charge from
   * March.
   */
  private async partiesFor(
    client: PrismaService | Prisma.TransactionClient,
    charges: readonly Pick<
      ChargeRecord,
      "personId" | "apartmentId" | "chargedOn"
    >[],
  ): Promise<PartyLookup> {
    const personIds = [
      ...new Set(
        charges
          .map((charge) => charge.personId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const apartmentIds = [
      ...new Set(
        charges
          .map((charge) => charge.apartmentId)
          .filter((id): id is string => id !== null),
      ),
    ];

    const persons =
      personIds.length === 0
        ? []
        : await client.person.findMany({
            where: { id: { in: personIds } },
            select: {
              id: true,
              firstName: true,
              lastName: true,
              protectedPersonalData: true,
              residencies: {
                orderBy: [{ movedInOn: "asc" }],
                select: {
                  movedInOn: true,
                  movedOutOn: true,
                  apartment: {
                    select: {
                      number: true,
                      address: { select: { street: true, number: true } },
                    },
                  },
                },
              },
            },
          });

    const apartments =
      apartmentIds.length === 0
        ? []
        : await client.apartment.findMany({
            where: { id: { in: apartmentIds } },
            select: {
              id: true,
              number: true,
              address: { select: { street: true, number: true } },
            },
          });

    return {
      persons: new Map(persons.map((person) => [person.id, person])),
      apartments: new Map(
        apartments.map((apartment) => [
          apartment.id,
          apartmentLabel(apartment),
        ]),
      ),
    };
  }
}

interface PersonRecord {
  id: string;
  firstName: string;
  lastName: string;
  protectedPersonalData: boolean;
  residencies: {
    movedInOn: Date;
    movedOutOn: Date | null;
    apartment: { number: string; address: { street: string; number: string } };
  }[];
}

interface PartyLookup {
  persons: Map<string, PersonRecord>;
  apartments: Map<string, string>;
}

function apartmentLabel(apartment: {
  number: string;
  address: { street: string; number: string };
}): string {
  return `${apartment.address.street} ${apartment.address.number} ${apartment.number}`;
}

/** One line of the list. */
function toRow(charge: ChargeRecord, parties: PartyLookup): DebitingListRow {
  return {
    chargeId: charge.id,
    chargedOn: formatLocalDay(localDayOfColumn(charge.chargedOn)),
    chargedTo: partyOf(charge, parties),
    amount: charge.amount.toFixed(2),
    vatTreatment: charge.vatTreatment,
    vatRatePercent: charge.vatRatePercent,
    reason: charge.reason,
    handedToManagerOn:
      charge.handedToManagerOn === null
        ? null
        : formatLocalDay(localDayOfColumn(charge.handedToManagerOn)),
  };
}

function partyOf(
  charge: ChargeRecord,
  parties: PartyLookup,
): DebitingListParty {
  if (charge.personId === null) {
    return {
      kind: "apartment",
      apartmentId: charge.apartmentId,
      /*
       * Never masked. The apartment is the charged party here and withholding it
       * would empty the row; what protection withholds is which person is behind
       * a door, and a charge on the flat does not say.
       *
       * Visible with a null label where the apartment has since been corrected
       * out of the register, which the SetNull on the column allows: the charge
       * still says what the association charged and why.
       */
      apartment: {
        state: "visible",
        label:
          charge.apartmentId === null
            ? null
            : (parties.apartments.get(charge.apartmentId) ?? null),
      },
    };
  }

  const person = parties.persons.get(charge.personId);
  if (person === undefined) {
    /*
     * The person has been erased while their charge has not. Reachable in one
     * ordering: a residency purge runs before this charge's own seven years are
     * up. The row stays on the list, because the association charged somebody
     * and its books say so, and it names nobody, because there is nobody left to
     * name.
     */
    return {
      kind: "person",
      personId: charge.personId,
      name: "",
      protectedPersonalData: false,
      apartment: { state: "visible", label: null },
    };
  }

  return {
    kind: "person",
    personId: person.id,
    name: `${person.firstName} ${person.lastName}`.trim(),
    protectedPersonalData: person.protectedPersonalData,
    apartment: apartmentOn(person, localDayOfColumn(charge.chargedOn)),
  };
}

/**
 * Where the person lived on the day of the charge, or the statement that it is
 * withheld.
 *
 * Masked through `isMasked`, which is the address book's own decision function,
 * so a protected person's apartment is withheld here by the same rule that
 * withholds their postal address from the member register extract. The list is
 * handed to a bookkeeper outside the association, and the link from a name to a
 * door is what protection exists to withhold.
 *
 * Several apartments are joined rather than one being chosen: a household
 * holding two flats has two, and picking one would state something the register
 * does not say.
 */
function apartmentOn(
  person: PersonRecord,
  day: LocalDay,
): DebitingListApartment {
  if (isMasked("postalAddress", person)) {
    return { state: "masked" };
  }

  const held = person.residencies.filter(
    (residency) =>
      compareLocalDays(localDayOfColumn(residency.movedInOn), day) <= 0 &&
      (residency.movedOutOn === null ||
        compareLocalDays(localDayOfColumn(residency.movedOutOn), day) >= 0),
  );

  return {
    state: "visible",
    label:
      held.length === 0
        ? null
        : held
            .map((residency) => apartmentLabel(residency.apartment))
            .join(", "),
  };
}

/**
 * The amount as the column holds it.
 *
 * Refused rather than rounded when it is not a sum of kronor and ore: a board
 * typing a thousands separator or a third decimal place is told so, rather than
 * being handed a figure the bookkeeper will reconcile against and find short.
 * The controller refuses the same shapes first with a schema; this is the rule
 * stated where the invariant lives, because the service is what the integration
 * tests and every later caller go through.
 */
function readAmount(text: string): string {
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(text)) {
    throw new MemberChargeError(
      "An amount is stated in kronor and at most two decimal places.",
      "amount-not-a-sum",
    );
  }
  if (Number(text) <= 0) {
    throw new MemberChargeError(
      "A charge is a positive amount. A credit is the accounting system's act, not a charge.",
      "amount-not-positive",
    );
  }
  return text;
}

/** The reason, with the surrounding whitespace off and something left. */
function readReason(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") {
    throw new MemberChargeError(
      "A charge states what it is for.",
      "reason-required",
    );
  }
  return trimmed;
}

/** The rate, refused where it does not belong to the treatment stated. */
function readVatRate(
  treatment: VatTreatment,
  rate: number | null | undefined,
): number | null {
  if (treatment === "EXEMPT") {
    if (rate !== null && rate !== undefined) {
      throw new MemberChargeError(
        "A charge with no value added tax on it carries no rate.",
        "vat-rate-not-applicable",
      );
    }
    return null;
  }
  if (rate === null || rate === undefined) {
    throw new MemberChargeError(
      "A charge carrying value added tax states the rate.",
      "vat-rate-required",
    );
  }
  if (!Number.isInteger(rate) || rate < 1 || rate > 100) {
    throw new MemberChargeError(
      "A rate is a whole percentage between 1 and 100.",
      "vat-rate-out-of-range",
    );
  }
  return rate;
}

/**
 * Refuses a charge carrying a Swedish personal identity number.
 *
 * The same rule a page, a news item and an event live under, and for the same
 * reason: the reason is copied into a file that leaves the association for its
 * bookkeeper, and a personnummer in it is a disclosure that cannot be taken
 * back.
 *
 * The refusal names the field and the offset and never the value - the thing the
 * scan caught is precisely the thing that must not travel back.
 */
function refusePersonalIdentityNumbers(fields: { reason: string }): void {
  const locations: MemberChargeTextLocation[] = scanForPersonalIdentityNumbers(
    fields.reason,
  ).map((hit) => ({ field: "reason", offset: hit.index }));

  if (locations.length > 0) {
    throw new MemberChargeError(
      "The charge carries a personal identity number and cannot be recorded.",
      "personal-identity-number",
      { locations },
    );
  }
}

/**
 * Which fields a correction actually moves.
 *
 * Compared against what is on the row rather than taken from which keys the
 * request carried, so a form that posts every field back names only what
 * changed. An entry saying six fields moved when one did would make the log
 * unreadable exactly where it is most needed - a charge somebody disputes.
 */
function changedFields(
  charge: ChargeRecord,
  next: {
    chargedOn: LocalDay;
    amount: string | undefined;
    reason: string | undefined;
    vatTreatment: VatTreatment;
    vatRatePercent: number | null;
    handedToManagerOn: LocalDay | null;
  },
): string[] {
  const fields: string[] = [];
  if (
    compareLocalDays(localDayOfColumn(charge.chargedOn), next.chargedOn) !== 0
  ) {
    fields.push("chargedOn");
  }
  if (next.amount !== undefined && charge.amount.toFixed(2) !== next.amount) {
    fields.push("amount");
  }
  if (next.reason !== undefined && charge.reason !== next.reason) {
    fields.push("reason");
  }
  if (charge.vatTreatment !== next.vatTreatment) {
    fields.push("vatTreatment");
  }
  if (charge.vatRatePercent !== next.vatRatePercent) {
    fields.push("vatRatePercent");
  }
  const wasHandedOver =
    charge.handedToManagerOn === null
      ? null
      : formatLocalDay(localDayOfColumn(charge.handedToManagerOn));
  const isHandedOver =
    next.handedToManagerOn === null
      ? null
      : formatLocalDay(next.handedToManagerOn);
  if (wasHandedOver !== isHandedOver) {
    fields.push("handedToManagerOn");
  }
  return fields;
}
