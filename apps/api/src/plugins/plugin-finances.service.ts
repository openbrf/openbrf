import { Injectable } from "@nestjs/common";
import type {
  PluginFeeNotification,
  PluginFeeNotificationSummary,
  PluginMemberCharge,
  PluginMemberChargeParty,
} from "@openbrf/plugin-sdk";
import { parseLocalDay } from "@openbrf/shared";

import type { DebitingListRow } from "../charges/debiting-list";
import { MemberChargeService } from "../charges/member-charge.service";
import { PrismaService } from "../database/prisma.service";
import { FeeNotificationService } from "../fees/fee-notification.service";
import { isResidencyHeldOn, residencyHeldOn } from "../registers/held-on";
import { pluginReceiptOf } from "./plugin-delivery-receipt";

/**
 * The association's finances, as a plugin may read them.
 *
 * ## The board's own rows, then less
 *
 * Every read starts from what the board's own documents state - the fee notice
 * document and the debiting list, through the services that write those files -
 * so the masking each file applies is applied here by the same code rather than
 * by a second copy of it. A change to what the file withholds reaches a plugin
 * with it. What this adds is only ever more withholding, never less:
 *
 *   The address book's rule that a person with protected personal data never
 *   reaches a plugin. The fee notice file already withholds a protected
 *   household's names; the debiting list withholds a protected person's
 *   apartment and prints their name, because the bookkeeper has to know whom
 *   to invoice. A plugin is not the bookkeeper, so here the name goes as well,
 *   and the board's free text about the charge with it - what was written about
 *   a protected person's charge can say who they are as well as a name can.
 *
 *   A restriction of processing (GDPR art. 18). Handing a row to code the
 *   association installed is a use, and art. 18(2) permits storage rather than
 *   use, which is why the address book leaves a restricted person out. The
 *   files the board hands over do not, because billing them is the association
 *   meeting its own books; a plugin carrying the notice elsewhere is a further
 *   use, so their names are withheld here.
 *
 *   A person the register no longer holds. Their charge stays on the list for
 *   the association's books, and the plugin is told it is withheld rather than
 *   handed an empty name.
 *
 *   The free text on a charge to a household somebody masked lives in: the
 *   board's reason, and the references plugins wrote. A charge on the
 *   apartment, or on a person sharing it with somebody protected or
 *   restricted, names nobody masked, but what was written about it can - "the
 *   door Signe broke" - as a notice's names would. The household is the one
 *   living there on the day of the charge, by the rule a notice is read by on
 *   its period's last day. The apartment, and the name of a person charged who
 *   is not masked themselves, stay: the address book names that same person
 *   at that same door to any plugin that reads it, so withholding them here
 *   would hide nothing the register keeps from plugins, and it would stop a
 *   plugin invoicing a person whom nothing stands against. A notice withholds its names for a reason a charge
 *   does not have: it is for the household, and naming some of it would
 *   misstate who it is for.
 *
 *   A delivery receipt's reference, on a row whose names or free text are
 *   withheld. It is free text a plugin wrote, perhaps before the protection or
 *   the restriction was, and can say who the row is for as well as a name can.
 *   And another plugin's reference on every row, for the reason
 *   `pluginReceiptOf` gives. The receipt stays, so a plugin can tell the row
 *   was delivered; the board's screen keeps the reference.
 *
 * And a fixed shape, mapped field by field rather than spread: a field added to
 * the board's documents for the board's screen does not reach a plugin until
 * somebody adds it here and to the SDK, which is the point of keeping the two
 * apart that `PluginAddressBookService` gives.
 *
 * ## What is never here
 *
 * A personal identity number - no row carries one. A payment, a balance or a
 * status - core records none. An audit entry per read: a plugin reading the
 * books in its own process is the association's own code, consented to by the
 * board at install, and an entry for every poll would bury the entries that
 * say something. What a plugin writes back - a delivery receipt - is audited.
 */
@Injectable()
export class PluginFinancesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly feeNotifications: FeeNotificationService,
    private readonly memberCharges: MemberChargeService,
  ) {}

  async notifications(): Promise<PluginFeeNotificationSummary[]> {
    const runs = await this.feeNotifications.list();
    return runs.map((run) => ({
      id: run.notificationId,
      from: run.from,
      to: run.to,
      dueOn: run.dueOn,
      issuedAt: run.issuedAt,
      notices: run.notices,
      total: run.total,
    }));
  }

  /**
   * One run with its notices, as the plugin `reader` is shown it.
   *
   * The reader is the host's id for the plugin asking, never one the plugin
   * stated: it decides whose receipt references the plugin is shown.
   */
  async notification(
    reader: string,
    id: string,
    now: Date = new Date(),
  ): Promise<PluginFeeNotification | null> {
    if (typeof id !== "string") {
      return null;
    }
    const document = await this.feeNotifications.read(id, now);
    if (document === null) {
      return null;
    }

    const restricted = await this.householdsWithRestriction(
      document.rows.map((row) => row.apartmentId),
      document.to,
    );

    return {
      id: document.notificationId,
      from: document.from,
      to: document.to,
      dueOn: document.dueOn,
      issuedAt: document.issuedAt,
      total: document.total,
      notices: document.rows.map((row) => {
        const withheld =
          row.holders.state === "withheld" || restricted.has(row.apartmentId);
        return {
          id: row.noticeId,
          apartment: {
            id: row.apartmentId,
            label: row.apartment,
            number: row.apartmentNumber,
          },
          holders:
            row.holders.state === "visible" && !withheld
              ? { state: "visible", names: [...row.holders.names] }
              : { state: "withheld" },
          amount: row.amount,
          paymentReference: row.paymentReference,
          deliveries: row.deliveries.map((receipt) =>
            pluginReceiptOf(receipt, reader, withheld),
          ),
        };
      }),
    };
  }

  /** The charges dated in a period, as the plugin `reader` is shown them. */
  async charges(
    reader: string,
    period: { from: string; to: string },
    now: Date = new Date(),
  ): Promise<PluginMemberCharge[]> {
    const { from, to } = (period ?? {}) as { from?: unknown; to?: unknown };
    if (typeof from !== "string" || typeof to !== "string") {
      throw new RangeError(
        'A period is { from: "YYYY-MM-DD", to: "YYYY-MM-DD" }.',
      );
    }
    const list = await this.memberCharges.list(from, to, now);
    return this.withheld(reader, list.rows);
  }

  /** One charge, as the plugin `reader` is shown it. */
  async charge(reader: string, id: string): Promise<PluginMemberCharge | null> {
    if (typeof id !== "string") {
      return null;
    }
    const row = await this.memberCharges.find(id);
    if (row === null) {
      return null;
    }
    const [charge] = await this.withheld(reader, [row]);
    return charge ?? null;
  }

  /**
   * The apartments where somebody living there on the day has had processing
   * restricted.
   *
   * The whole household, by the rule `holdersOf` applies to protection: naming
   * the others on a flat of two says who the remaining one lives with, and a
   * notice naming only some of its holders would misstate who it is for.
   */
  private async householdsWithRestriction(
    apartmentIds: readonly string[],
    day: string,
  ): Promise<Set<string>> {
    const held = parseLocalDay(day);
    if (apartmentIds.length === 0 || held === null) {
      return new Set();
    }
    const rows = await this.prisma.residency.findMany({
      where: {
        apartmentId: { in: [...apartmentIds] },
        ...residencyHeldOn(held),
        person: { processingRestrictedAt: { not: null } },
      },
      select: { apartmentId: true },
    });
    return new Set(rows.map((row) => row.apartmentId));
  }

  /**
   * The charges on a household somebody protected or restricted lived in on
   * the day of the charge: on the apartment itself, or on a person living
   * there.
   *
   * The day is each charge's own, as the debiting list places a person on it,
   * and the protection and the restriction are the register's now, as a
   * notice's are. Read as two queries for the whole list rather than one per
   * row: where the people charged lived, and who masked ever lived in those
   * apartments - few people, so the days are compared here.
   */
  private async chargesOnMaskedHouseholds(
    rows: readonly DebitingListRow[],
  ): Promise<Set<string>> {
    const personIds = new Set<string>();
    const apartmentIds = new Set<string>();
    for (const row of rows) {
      if (row.chargedTo.kind === "person") {
        personIds.add(row.chargedTo.personId);
      } else if (row.chargedTo.apartmentId !== null) {
        apartmentIds.add(row.chargedTo.apartmentId);
      }
    }

    const homes =
      personIds.size === 0
        ? []
        : await this.prisma.residency.findMany({
            where: { personId: { in: [...personIds] } },
            select: {
              personId: true,
              apartmentId: true,
              movedInOn: true,
              movedOutOn: true,
            },
          });
    for (const home of homes) {
      apartmentIds.add(home.apartmentId);
    }
    const masked =
      apartmentIds.size === 0
        ? []
        : await this.prisma.residency.findMany({
            where: {
              apartmentId: { in: [...apartmentIds] },
              person: {
                OR: [
                  { protectedPersonalData: true },
                  { processingRestrictedAt: { not: null } },
                ],
              },
            },
            select: { apartmentId: true, movedInOn: true, movedOutOn: true },
          });

    const onMasked = new Set<string>();
    for (const row of rows) {
      const day = parseLocalDay(row.chargedOn);
      // A day the list cannot have written; withheld rather than guessed at.
      if (day === null) {
        onMasked.add(row.chargeId);
        continue;
      }
      const party = row.chargedTo;
      const flats =
        party.kind === "apartment"
          ? [party.apartmentId]
          : homes
              .filter(
                (home) =>
                  home.personId === party.personId &&
                  isResidencyHeldOn(home, day),
              )
              .map((home) => home.apartmentId);
      if (
        masked.some(
          (residency) =>
            flats.includes(residency.apartmentId) &&
            isResidencyHeldOn(residency, day),
        )
      ) {
        onMasked.add(row.chargeId);
      }
    }
    return onMasked;
  }

  /** The debiting list's rows, with the plugin's own withholding applied. */
  private async withheld(
    reader: string,
    rows: readonly DebitingListRow[],
  ): Promise<PluginMemberCharge[]> {
    const personIds = [
      ...new Set(
        rows.flatMap((row) =>
          row.chargedTo.kind === "person" ? [row.chargedTo.personId] : [],
        ),
      ),
    ];
    const persons =
      personIds.length === 0
        ? []
        : await this.prisma.person.findMany({
            where: { id: { in: personIds } },
            select: {
              id: true,
              protectedPersonalData: true,
              processingRestrictedAt: true,
            },
          });
    const nameable = new Set(
      persons
        .filter(
          (person) =>
            !person.protectedPersonalData &&
            person.processingRestrictedAt === null,
        )
        .map((person) => person.id),
    );
    const onMasked = await this.chargesOnMaskedHouseholds(rows);

    return rows.map((row) => {
      const chargedTo = partyOf(row, nameable);
      const withheld =
        (chargedTo.kind === "person" && chargedTo.state === "withheld") ||
        onMasked.has(row.chargeId);
      return {
        id: row.chargeId,
        chargedOn: row.chargedOn,
        chargedTo,
        amount: row.amount,
        vatTreatment: row.vatTreatment,
        vatRatePercent: row.vatRatePercent,
        reason: withheld
          ? { state: "withheld" }
          : { state: "visible", text: row.reason },
        handedToManagerOn: row.handedToManagerOn,
        deliveries: row.deliveries.map((receipt) =>
          pluginReceiptOf(receipt, reader, withheld),
        ),
      };
    });
  }
}

/**
 * Who a charge is on, as a plugin is told it.
 *
 * Named only where the debiting list itself named the person without masking
 * and the register says, now, that nothing stands against naming them to a
 * plugin. Both, because the list's answer is the floor and this is only ever
 * stricter.
 */
function partyOf(
  row: DebitingListRow,
  nameable: ReadonlySet<string>,
): PluginMemberChargeParty {
  const party = row.chargedTo;
  if (party.kind === "apartment") {
    return {
      kind: "apartment",
      apartmentId: party.apartmentId,
      apartment:
        party.apartment.state === "visible" ? party.apartment.label : null,
    };
  }
  if (
    party.protectedPersonalData ||
    party.apartment.state === "masked" ||
    !nameable.has(party.personId)
  ) {
    return { kind: "person", state: "withheld" };
  }
  return {
    kind: "person",
    state: "visible",
    personId: party.personId,
    name: party.name,
    apartment: party.apartment.label,
  };
}
