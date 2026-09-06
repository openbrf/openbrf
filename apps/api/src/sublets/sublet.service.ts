import { Injectable, Logger } from "@nestjs/common";
import { scanForPersonalIdentityNumbers } from "@openbrf/shared";

import { AuditLogService } from "../audit/audit-log.service";
import type { Principal } from "../authorization/capabilities";
import {
  compareLocalDays,
  dateColumnOf,
  formatLocalDay,
  type LocalDay,
  localDayOfColumn,
  parseLocalDay,
} from "../bookings/stockholm-calendar";
import { PrismaService } from "../database/prisma.service";
import type {
  AuditAction,
  SubletApplicationStatus,
} from "../generated/prisma/enums";
import { SubletError, type SubletTextLocation } from "./sublet.error";

/** An apartment as an applicant and the board are told which one it is. */
export interface SubletApartmentView {
  id: string;
  number: string;
  /** "Storgatan 12", so a household with two entrances can tell them apart. */
  address: string;
}

/**
 * What the rent tribunal (hyresnamnden) permitted after the board refused.
 *
 * Its own shape rather than two loose columns, because the two dates are one
 * fact and a permission with a start and no answer to "until when" reads as an
 * open-ended one rather than as a decision whose end date nobody recorded.
 */
export interface SubletTribunalPermissionView {
  /** "YYYY-MM-DD": the day the tribunal permitted the letting. */
  permittedOn: string;
  /**
   * "YYYY-MM-DD", or null where the recorded decision named no end.
   *
   * BRL 7 kap. 11 § forsta stycket requires the permission to a
   * bostadsrattshavare to be limited in time, so an absent end is a gap in what
   * was recorded rather than a permission without one - which is why the
   * platform states it as absent instead of inventing a date.
   */
  permittedUntil: string | null;
}

/** An application as the member who made it reads it back. */
export interface OwnSubletApplicationView {
  id: string;
  /** Null where the apartment has since been corrected out of the register. */
  apartment: SubletApartmentView | null;
  /** "YYYY-MM-DD": the first day of the period applied for. */
  periodFrom: string;
  /** "YYYY-MM-DD": the last day of the period applied for, inclusive. */
  periodTo: string;
  reason: string;
  status: SubletApplicationStatus;
  /** ISO instant. */
  submittedAt: string;
  /** ISO instant, or null while the application is with the board. */
  closedAt: string | null;
  /** What the board wrote when it answered, where it wrote anything. */
  decisionNote: string | null;
  /** Null unless the board refused and somebody recorded a permission. */
  tribunalPermission: SubletTribunalPermissionView | null;
}

/**
 * Who applied, as the board may be told.
 *
 * The three cases the motion queue has, and the two that are not a plain name
 * are the point of the type.
 *
 * `protected` is a member with protected personal data (skyddade
 * personuppgifter). Their name is withheld even though the board's own address
 * book prints it, on the judgement `IssueReporterView` sets out: this payload is
 * a queue rather than a statutory register, and a board member who has to reach
 * them goes through the register that has a reason to name them.
 *
 * `unknown` is an applicant reference that no longer resolves to a person.
 * Sublet data is service tier and a person can be purged out from under a row
 * that is still open, so the queue has to be able to say "we no longer know"
 * rather than break.
 */
export type SubletApplicantView =
  | { kind: "member"; personId: string; name: string }
  | { kind: "protected"; personId: string }
  | { kind: "unknown" };

/** An application as the board reads it in the queue. */
export interface QueuedSubletApplicationView extends OwnSubletApplicationView {
  applicant: SubletApplicantView;
  /** Who closed it, when somebody has. Never a name: an identifier. */
  closedByPersonId: string | null;
}

/** What the member's half of the screen needs in one answer. */
export interface SubletIntakeView {
  /**
   * The apartments this caller may apply about: the ones they hold as a member,
   * today.
   *
   * Part of the intake rather than a call of its own, because the form is
   * unusable without it and because it is the only list of apartments this
   * module ever discloses - a picker over the register would enumerate the
   * building to whoever loaded the form.
   */
  apartments: SubletApartmentView[];
  applications: OwnSubletApplicationView[];
}

/** What the board's half of the screen needs in one answer. */
export interface SubletQueueView {
  applications: QueuedSubletApplicationView[];
}

export interface ApplyForSubletInput {
  apartmentId: string;
  /** "YYYY-MM-DD". */
  periodFrom: string;
  /** "YYYY-MM-DD", inclusive. */
  periodTo: string;
  reason: string;
}

/** What the applicant may still change while the board has not answered. */
export interface ReviseSubletInput {
  periodFrom: string;
  periodTo: string;
  reason: string;
}

export interface DecideSubletInput {
  /** True to give the board's samtycke, false to refuse it. */
  consent: boolean;
  /** What the board wants recorded with the answer, where it wants anything. */
  note: string | null;
}

/**
 * What the rent tribunal decided, as the board records it.
 *
 * Null clears a record that was entered wrongly. Nothing here records a tribunal
 * *refusal*: a refusal leaves the board's own refusal standing, which the row
 * already says, so there would be nothing for the extra state to change.
 */
export interface TribunalPermissionInput {
  /** "YYYY-MM-DD". */
  permittedOn: string;
  /** "YYYY-MM-DD", or null where the decision named no end. */
  permittedUntil: string | null;
}

/**
 * Subletting applications (ansokan om andrahandsupplatelse): a member's intake
 * and the queue the board works.
 *
 * ## The statute, and what it actually says
 *
 * BRL 7 kap. 10 § forsta stycket: "En bostadsrattshavare far upplata sin
 * lagenhet i andra hand till nagon annan for sjalvstandigt brukande endast om
 * styrelsen ger sitt samtycke." So the act belongs to the tenant-owner, it is
 * about their own apartment, and what the board gives is consent rather than
 * approval of a proposal.
 *
 * 10 § andra stycket (Lag 2026:776) widens what counts as independent use: a
 * letting of the apartment *or a part of it* always counts where the holder does
 * not use it as a permanent home or otherwise to a beaktansvard extent. That
 * turns on how somebody lives, which this platform does not know and would be
 * guessing at, so the rule is stated on the form and the member applies or does
 * not. Nothing here decides whether consent was needed.
 *
 * 10 a § lists two cases where consent is not needed at all and the board is
 * only to be notified at once. Both holders are juridical persons - a
 * lienholding company after a forced sale, and a kommun or a region - and
 * neither has a resident account on this instance, so neither can reach this
 * form. A board that receives such a notification records it outside this
 * module.
 *
 * ## Membership, and why it is checked twice
 *
 * The capability `sublets:apply` is derived from membership in
 * `authorization/capabilities.ts`, which is what keeps a partner, an adult child
 * or a tenant off the route. {@link apply} then asks the register again about
 * the apartment named in the request, and that second question is not a
 * duplicate of the first: an administrator holds every capability in the model
 * by definition, and holding a grant on an instance is not holding a
 * tenant-ownership in the association. Without it the one account that can do
 * everything could ask the board's consent to let a flat it has no share in.
 *
 * It is asked of the apartment rather than of the person, which is stricter than
 * the motion module's check and follows from the statute saying "sin lagenhet":
 * a member of this association may not apply to let a flat they do not hold.
 *
 * ## Free text
 *
 * The applicant's reason and the board's decision note are both scanned for a
 * Swedish personal identity number and refused if they carry one, on the way in
 * and on every later edit. Unlike an issue description - which is deliberately
 * neither scanned nor refused, because a report about a leak is exactly where a
 * third party's details turn up and refusing it would turn away the reports the
 * module exists for - both of these travel: the note is quoted back to the
 * applicant, and both are printed in full on a data subject access report. The
 * refusal names the field and the offset and never the value.
 *
 * ## The rent tribunal is stated, never enforced
 *
 * 7 kap. 11 § lets the member let anyway if the hyresnamnden permits it after
 * the board refused. The platform cannot know what the tribunal decided unless
 * somebody records it, and inventing the answer either way would take a right
 * away on a guess - so {@link recordTribunalPermission} writes it down beside the
 * refusal and changes nothing else. The status stays REFUSED, because the
 * association did not consent; the tribunal permitted, and those are two facts
 * about the same letting.
 */
@Injectable()
export class SubletService {
  private readonly logger = new Logger(SubletService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * The member's own applications, newest first, and the apartments they may
   * apply about.
   */
  async intake(personId: string): Promise<SubletIntakeView> {
    const [apartments, applications] = await Promise.all([
      this.ownApartments(personId),
      this.prisma.subletApplication.findMany({
        where: { appliedByPersonId: personId },
        orderBy: { submittedAt: "desc" },
        select: APPLICATION_COLUMNS,
      }),
    ]);

    return { apartments, applications: applications.map(toOwnView) };
  }

  /**
   * The apartments this caller may apply about: the ones they hold as a member,
   * today.
   *
   * MEMBER residencies only, and that is the difference from
   * `BookingService.ownApartments`, which takes any active residency. Booking
   * the laundry is part of living here; asking to let an apartment in andra hand
   * is BRL 7 kap. 10 §, which gives the act to the bostadsrattshavare. A person
   * living in one flat as a member and in another as a tenant is offered the
   * first and not the second.
   *
   * Deduplicated, because joint holders and successive residencies of one
   * apartment are several rows about one home.
   */
  async ownApartments(personId: string): Promise<SubletApartmentView[]> {
    const residencies = await this.prisma.residency.findMany({
      where: {
        personId,
        role: "MEMBER",
        OR: [{ movedOutOn: null }, { movedOutOn: { gt: new Date() } }],
      },
      select: { apartment: { select: APARTMENT_SELECT } },
      orderBy: [{ movedInOn: "asc" }],
    });

    const seen = new Set<string>();
    const apartments: SubletApartmentView[] = [];
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
   * Asks the board's consent to let an apartment in andra hand.
   *
   * The row and its audit entry are one transaction. An application whose entry
   * rolled back would leave the member's own access report unable to show that
   * they asked, and the entry outlives the row by design - it is what answers "I
   * asked, and this is when" once the purge has erased the application itself.
   */
  async apply(
    principal: Principal,
    input: ApplyForSubletInput,
  ): Promise<{ id: string }> {
    const period = this.requirePeriod(input.periodFrom, input.periodTo);
    await this.requireOwnApartment(principal.personId, input.apartmentId);
    this.refusePersonalIdentityNumbers({ reason: input.reason });

    const application = await this.prisma.$transaction(async (tx) => {
      const created = await tx.subletApplication.create({
        data: {
          appliedByPersonId: principal.personId,
          apartmentId: input.apartmentId,
          periodFrom: dateColumnOf(period.from),
          periodTo: dateColumnOf(period.to),
          reason: input.reason,
        },
        select: { id: true },
      });

      await this.audit.record(
        {
          action: "SUBLET_APPLICATION_SUBMITTED",
          // Actor and subject are the same person: the act is theirs and nobody
          // applies on anybody's behalf.
          actorPersonId: principal.personId,
          targetPersonId: principal.personId,
          targetKind: "subletApplication",
          targetId: created.id,
          /*
           * The period and the length of what was written, and never the reason
           * itself: the log is append-only and exempt from every purge, so text
           * copied into it would outlive the row it came from and stay after the
           * retention window erased the original. The period is a fact about the
           * request rather than about the applicant's circumstances, and it is
           * what makes the entry able to say what was asked for once the row is
           * gone.
           */
          context: {
            apartmentId: input.apartmentId,
            periodFrom: formatLocalDay(period.from),
            periodTo: formatLocalDay(period.to),
            reasonLength: input.reason.length,
          },
        },
        tx,
      );

      return created;
    });

    // The identifier and the act. Why a member wants to let their flat is theirs
    // and has no business in a log line.
    this.logger.log(`Sublet application ${application.id} submitted`);
    return application;
  }

  /**
   * Changes what one's own application asks for, while it is still open.
   *
   * The period and the reason and not the apartment: an application about a
   * different flat is a different request, and rewriting the apartment on a row
   * the board may already have read would make the queue say something nobody
   * asked. Withdraw and apply again is the honest path.
   *
   * Only while the board has not answered, and scoped to the caller's own
   * applications in the same query that finds it - so one belonging to somebody
   * else answers exactly as one that does not exist.
   */
  async revise(
    personId: string,
    applicationId: string,
    input: ReviseSubletInput,
  ): Promise<OwnSubletApplicationView> {
    const period = this.requirePeriod(input.periodFrom, input.periodTo);
    this.refusePersonalIdentityNumbers({ reason: input.reason });

    const existing = await this.prisma.subletApplication.findFirst({
      where: { id: applicationId, appliedByPersonId: personId },
      select: { id: true, status: true },
    });
    if (existing === null) {
      // Deliberately the same answer as an application that was never made: see
      // the reasoning on SubletError.
      throw new SubletError("No such application.", "application-not-found");
    }
    if (existing.status !== "SUBMITTED") {
      throw new SubletError(
        "The board has answered this application.",
        "already-closed",
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.subletApplication.updateMany({
        // Conditional on the state rather than on the primary key alone: this is
        // what makes the check above a decision instead of a read that a board
        // member's answer can invalidate before the write lands.
        where: { id: applicationId, status: "SUBMITTED" },
        data: {
          periodFrom: dateColumnOf(period.from),
          periodTo: dateColumnOf(period.to),
          reason: input.reason,
        },
      });
      if (count === 0) {
        throw new SubletError(
          "The board has answered this application.",
          "already-closed",
        );
      }

      const updated = await tx.subletApplication.findUniqueOrThrow({
        where: { id: applicationId },
        select: APPLICATION_COLUMNS,
      });

      await this.audit.record(
        {
          action: "SUBLET_APPLICATION_REVISED",
          actorPersonId: personId,
          targetPersonId: personId,
          targetKind: "subletApplication",
          targetId: applicationId,
          context: {
            periodFrom: formatLocalDay(period.from),
            periodTo: formatLocalDay(period.to),
            reasonLength: input.reason.length,
          },
        },
        tx,
      );

      this.logger.log(`Sublet application ${applicationId} revised`);
      return toOwnView(updated);
    });
  }

  /**
   * Takes one's own application back, while the board has not answered.
   *
   * The row stays and takes a date and a status. Nothing in this module deletes
   * an application except the purge, so a member can still point at having
   * asked.
   */
  async withdraw(
    personId: string,
    applicationId: string,
  ): Promise<OwnSubletApplicationView> {
    const existing = await this.prisma.subletApplication.findFirst({
      where: { id: applicationId, appliedByPersonId: personId },
      select: { id: true, status: true },
    });
    if (existing === null) {
      throw new SubletError("No such application.", "application-not-found");
    }
    if (existing.status !== "SUBMITTED") {
      throw new SubletError(
        "The board has answered this application.",
        "already-closed",
      );
    }

    return this.close({
      applicationId,
      status: "WITHDRAWN",
      actorPersonId: personId,
      subjectPersonId: personId,
      action: "SUBLET_APPLICATION_WITHDRAWN",
      note: null,
    });
  }

  /**
   * The board's queue.
   *
   * Open applications first and oldest first within a status, because the queue
   * is worked from the top and the request that has been waiting longest is the
   * one to look at. SUBMITTED sorts before the three closed states by the order
   * the enum declares, which is the order a board reads them in.
   */
  async queue(filter?: {
    status?: SubletApplicationStatus;
  }): Promise<SubletQueueView> {
    const applications = await this.prisma.subletApplication.findMany({
      where: filter?.status === undefined ? {} : { status: filter.status },
      orderBy: [{ status: "asc" }, { submittedAt: "asc" }],
      select: APPLICATION_COLUMNS,
    });

    const applicants = await this.applicantsOf(applications);

    return {
      applications: applications.map((application) => ({
        ...toOwnView(application),
        closedByPersonId: application.closedByPersonId,
        applicant: applicantOf(application.appliedByPersonId, applicants),
      })),
    };
  }

  /**
   * Records the board's consent, or its refusal, with the date it was given.
   *
   * One act with two outcomes rather than two endpoints, because BRL 7 kap. 10 §
   * makes it one decision: the board either gives its samtycke or it does not.
   * The two are audited separately all the same, because only a refusal opens
   * the tribunal route in 11 § and the log has to say which the association is
   * answerable for.
   */
  async decide(
    applicationId: string,
    actorPersonId: string,
    input: DecideSubletInput,
  ): Promise<QueuedSubletApplicationView> {
    if (input.note !== null) {
      this.refusePersonalIdentityNumbers({ decisionNote: input.note });
    }

    const existing = await this.prisma.subletApplication.findUnique({
      where: { id: applicationId },
      select: { id: true, status: true, appliedByPersonId: true },
    });
    if (existing === null) {
      throw new SubletError("No such application.", "application-not-found");
    }
    if (existing.status !== "SUBMITTED") {
      throw new SubletError(
        "This application has already been answered.",
        "already-closed",
      );
    }

    const closed = await this.close({
      applicationId,
      status: input.consent ? "CONSENTED" : "REFUSED",
      actorPersonId,
      // The subject stays the member who applied, so their own access report
      // shows what the board did with their request rather than only what they
      // did themselves.
      subjectPersonId: existing.appliedByPersonId,
      action: input.consent
        ? "SUBLET_APPLICATION_CONSENTED"
        : "SUBLET_APPLICATION_REFUSED",
      note: input.note,
    });

    const applicants = await this.applicantsOf([
      { appliedByPersonId: existing.appliedByPersonId },
    ]);

    return {
      ...closed,
      closedByPersonId: actorPersonId,
      applicant: applicantOf(existing.appliedByPersonId, applicants),
    };
  }

  /**
   * Records what the rent tribunal (hyresnamnden) permitted after a refusal, or
   * takes that record back.
   *
   * BRL 7 kap. 11 §: where the board refuses consent the member may let anyway
   * if the tribunal permits it, and the permission is limited in time and may
   * carry conditions. None of that is something the platform can know, and
   * deciding it either way would take a right away on a guess - so this writes
   * down what somebody was told and enforces nothing. The status stays REFUSED:
   * the association did not consent, and a row that flipped to CONSENTED would
   * be the platform putting words in the board's mouth.
   *
   * Refused unless the application is REFUSED, because that is the state 11 §
   * opens the route from. The database says the same thing in a check
   * constraint, so a hand-written statement cannot leave a permission standing
   * against a consent.
   *
   * The conditions a permission may carry (11 § tredje stycket) are not modelled.
   * They are whatever the tribunal wrote, in its own words about a tenancy this
   * platform holds nothing else about, and a field for them would be a second
   * free-text store of a third party's arrangements with no reader that acts on
   * it.
   */
  async recordTribunalPermission(
    applicationId: string,
    actorPersonId: string,
    permission: TribunalPermissionInput | null,
  ): Promise<QueuedSubletApplicationView> {
    const dates =
      permission === null ? null : this.requirePermission(permission);

    const application = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.subletApplication.findUnique({
        where: { id: applicationId },
        select: { id: true, status: true, appliedByPersonId: true },
      });
      if (existing === null) {
        throw new SubletError("No such application.", "application-not-found");
      }

      const { count } = await tx.subletApplication.updateMany({
        /*
         * Conditional on the state rather than on the primary key alone, and the
         * state is the statutory condition itself: 11 § opens the tribunal route
         * only where the board refused. Reading the status and then writing
         * would leave a permission landing on an application somebody consented
         * to a moment earlier - which the database would refuse with a check
         * violation and no reason code.
         */
        where: { id: applicationId, status: "REFUSED" },
        data: {
          tribunalPermittedOn: dates === null ? null : dateColumnOf(dates.on),
          tribunalPermittedUntil:
            dates === null || dates.until === null
              ? null
              : dateColumnOf(dates.until),
        },
      });
      if (count === 0) {
        throw new SubletError(
          "The board has not refused this application, so there is no tribunal decision to record against it.",
          "not-refused",
        );
      }

      const updated = await tx.subletApplication.findUniqueOrThrow({
        where: { id: applicationId },
        select: APPLICATION_COLUMNS,
      });

      await this.audit.record(
        {
          action: "SUBLET_TRIBUNAL_PERMISSION_RECORDED",
          actorPersonId,
          // The subject stays the applicant: the permission is about their
          // letting, and their own access report is where it has to be visible.
          targetPersonId: existing.appliedByPersonId,
          targetKind: "subletApplication",
          targetId: applicationId,
          // The dates recorded, or that the record was cleared. Nothing about
          // the proceeding, which is not the association's to summarise.
          context:
            dates === null
              ? { cleared: true }
              : {
                  permittedOn: formatLocalDay(dates.on),
                  permittedUntil:
                    dates.until === null ? null : formatLocalDay(dates.until),
                },
        },
        tx,
      );

      return updated;
    });

    this.logger.log(
      permission === null
        ? `Sublet application ${applicationId} carries no tribunal permission`
        : `Sublet application ${applicationId} carries a recorded tribunal permission`,
    );

    const applicants = await this.applicantsOf([application]);
    return {
      ...toOwnView(application),
      closedByPersonId: application.closedByPersonId,
      applicant: applicantOf(application.appliedByPersonId, applicants),
    };
  }

  /**
   * Closes an application one way or the other, with the entry in the same
   * transaction.
   *
   * The status, the closing date and the board's note are written together and
   * the update is conditional on the application still being open, so two clicks
   * racing produce one close: the loser's update matches no row and is answered
   * exactly as a read would have answered it.
   */
  private async close(input: {
    applicationId: string;
    status: Exclude<SubletApplicationStatus, "SUBMITTED">;
    actorPersonId: string;
    subjectPersonId: string;
    action: AuditAction;
    note: string | null;
  }): Promise<OwnSubletApplicationView> {
    return this.prisma.$transaction(async (tx) => {
      const closedAt = new Date();
      const { count } = await tx.subletApplication.updateMany({
        where: { id: input.applicationId, status: "SUBMITTED" },
        data: {
          status: input.status,
          closedAt,
          closedByPersonId: input.actorPersonId,
          // Written only where there is one, so a withdrawal cannot blank a note
          // and a second answer cannot leave a stale one behind.
          ...(input.note === null ? {} : { decisionNote: input.note }),
        },
      });
      if (count === 0) {
        throw new SubletError(
          "This application has already been answered.",
          "already-closed",
        );
      }

      const application = await tx.subletApplication.findUniqueOrThrow({
        where: { id: input.applicationId },
        select: APPLICATION_COLUMNS,
      });

      await this.audit.record(
        {
          action: input.action,
          actorPersonId: input.actorPersonId,
          targetPersonId: input.subjectPersonId,
          targetKind: "subletApplication",
          targetId: input.applicationId,
          // The state it moved to and how long the note was, and nothing either
          // of them was carrying.
          context: {
            status: input.status,
            noteLength: input.note?.length ?? 0,
          },
        },
        tx,
      );

      this.logger.log(
        `Sublet application ${input.applicationId} moved to ${input.status}`,
      );
      return toOwnView(application);
    });
  }

  /**
   * Refuses an apartment the caller does not hold a tenant-ownership in.
   *
   * The statutory check, asked of the register rather than of the principal, and
   * asked about the apartment rather than about the person: BRL 7 kap. 10 § is
   * about letting "sin lagenhet". An administrator holds every capability in the
   * model and no residency at all, so this is what stops the one account that
   * can do everything from asking the board's consent to let somebody else's
   * flat.
   *
   * Asked as of the moment of the request, like the booking quota, so a
   * household that has sold up stops being able to apply on the day the
   * residency ends rather than when somebody remembers to change something.
   */
  private async requireOwnApartment(
    personId: string,
    apartmentId: string,
  ): Promise<void> {
    const held = await this.prisma.residency.count({
      where: {
        personId,
        apartmentId,
        role: "MEMBER",
        OR: [{ movedOutOn: null }, { movedOutOn: { gt: new Date() } }],
      },
    });
    if (held === 0) {
      /*
       * Deliberately the same answer as an apartment that is not in the register
       * at all, on `BookingService.requireOwnApartment`'s reasoning: a
       * distinguishable answer would let this endpoint enumerate the building.
       *
       * A member of this association who names a flat they do not hold gets it
       * too, and that is the intended reading of "sin lagenhet" rather than a
       * side effect: what they may ask about is the tenant-ownership they hold.
       */
      throw new SubletError("No such apartment.", "apartment-not-found");
    }
  }

  /** The period applied for, or a refusal naming which end is wrong. */
  private requirePeriod(
    from: string,
    to: string,
  ): { from: LocalDay; to: LocalDay } {
    const parsedFrom = parseDayOrRefuse(from);
    const parsedTo = parseDayOrRefuse(to);
    if (compareLocalDays(parsedTo, parsedFrom) < 0) {
      throw new SubletError(
        "The period ends before it begins.",
        "invalid-period",
      );
    }
    return { from: parsedFrom, to: parsedTo };
  }

  /** The tribunal's dates, or a refusal. */
  private requirePermission(input: TribunalPermissionInput): {
    on: LocalDay;
    until: LocalDay | null;
  } {
    const on = parseDayOrRefuse(input.permittedOn);
    if (input.permittedUntil === null) {
      return { on, until: null };
    }
    const until = parseDayOrRefuse(input.permittedUntil);
    if (compareLocalDays(until, on) < 0) {
      // The same refusal a backwards application period gets, because it is the
      // same mistake: a permission that runs out before it starts is not one.
      throw new SubletError(
        "The permission ends before it begins.",
        "invalid-period",
      );
    }
    return { on, until };
  }

  /**
   * The people who made these applications, as the queue may name them.
   *
   * `appliedByPersonId` is a plain column and not a relation - which is what lets
   * the purge reach this table at all - so the persons are read in a query of
   * their own rather than joined off the application.
   */
  private async applicantsOf(
    applications: readonly { appliedByPersonId: string }[],
  ): Promise<
    Map<
      string,
      { firstName: string; lastName: string; protectedPersonalData: boolean }
    >
  > {
    const ids = [
      ...new Set(
        applications.map((application) => application.appliedByPersonId),
      ),
    ];
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
   * The same rule a page, a news item and a motion live under. An application
   * travels: the reason is read by the board and printed in full on the
   * applicant's own data subject access report, and the board's note is quoted
   * back to the applicant on their own screen. A personnummer in either is a
   * disclosure the association cannot take back, and it usually arrives pasted
   * along with the text around it rather than because anybody decided to publish
   * it - a member explaining that they are letting to a named person while they
   * work abroad is exactly the sentence it turns up in.
   *
   * The refusal names the field and the offset and never the value. What the
   * scan caught is precisely the thing that must not travel back in a response
   * body.
   */
  private refusePersonalIdentityNumbers(
    parts: Partial<Record<SubletTextLocation["part"], string>>,
  ): void {
    const locations: SubletTextLocation[] = [];
    for (const [part, text] of Object.entries(parts)) {
      if (text === undefined) {
        continue;
      }
      for (const hit of scanForPersonalIdentityNumbers(text)) {
        locations.push({
          part: part as SubletTextLocation["part"],
          offset: hit.index,
        });
      }
    }

    if (locations.length > 0) {
      throw new SubletError(
        "The application carries a personal identity number and cannot be stored.",
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

const APPLICATION_COLUMNS = {
  id: true,
  appliedByPersonId: true,
  apartment: { select: APARTMENT_SELECT },
  periodFrom: true,
  periodTo: true,
  reason: true,
  status: true,
  submittedAt: true,
  closedAt: true,
  closedByPersonId: true,
  decisionNote: true,
  tribunalPermittedOn: true,
  tribunalPermittedUntil: true,
} as const;

interface ApartmentRecord {
  id: string;
  number: string;
  address: { street: string; number: string };
}

interface ApplicationRecord {
  id: string;
  apartment: ApartmentRecord | null;
  periodFrom: Date;
  periodTo: Date;
  reason: string;
  status: SubletApplicationStatus;
  submittedAt: Date;
  closedAt: Date | null;
  decisionNote: string | null;
  tribunalPermittedOn: Date | null;
  tribunalPermittedUntil: Date | null;
}

function toApartmentView(apartment: ApartmentRecord): SubletApartmentView {
  return {
    id: apartment.id,
    number: apartment.number,
    address: `${apartment.address.street} ${apartment.address.number}`,
  };
}

function toOwnView(application: ApplicationRecord): OwnSubletApplicationView {
  return {
    id: application.id,
    apartment:
      application.apartment === null
        ? null
        : toApartmentView(application.apartment),
    periodFrom: formatLocalDay(localDayOfColumn(application.periodFrom)),
    periodTo: formatLocalDay(localDayOfColumn(application.periodTo)),
    reason: application.reason,
    status: application.status,
    submittedAt: application.submittedAt.toISOString(),
    closedAt: application.closedAt?.toISOString() ?? null,
    decisionNote: application.decisionNote,
    tribunalPermission:
      application.tribunalPermittedOn === null
        ? null
        : {
            permittedOn: formatLocalDay(
              localDayOfColumn(application.tribunalPermittedOn),
            ),
            permittedUntil:
              application.tribunalPermittedUntil === null
                ? null
                : formatLocalDay(
                    localDayOfColumn(application.tribunalPermittedUntil),
                  ),
          },
  };
}

function applicantOf(
  personId: string,
  persons: ReadonlyMap<
    string,
    { firstName: string; lastName: string; protectedPersonalData: boolean }
  >,
): SubletApplicantView {
  const person = persons.get(personId);
  if (person === undefined) {
    return { kind: "unknown" };
  }
  if (person.protectedPersonalData) {
    return { kind: "protected", personId };
  }
  return {
    kind: "member",
    personId,
    name: `${person.firstName} ${person.lastName}`.trim(),
  };
}

/**
 * A "YYYY-MM-DD" date, or the module's own refusal.
 *
 * The controller's schema already refuses anything that is not that shape, so
 * reaching the throw means a date the calendar does not have - the 30th of
 * February, which `parseLocalDay` catches and `Date.parse` would silently answer
 * as the 2nd of March.
 */
function parseDayOrRefuse(text: string): LocalDay {
  const day = parseLocalDay(text);
  if (day === null) {
    throw new SubletError("That is not a date.", "invalid-period");
  }
  return day;
}
