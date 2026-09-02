import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
} from "@nestjs/common";
import { z } from "zod";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import type { Principal } from "../authorization/capabilities";
import { RequireCapability } from "../authorization/require-capability.decorator";
import type {
  AttendanceCapacity,
  AttendanceMode,
  MeetingDecisionOutcome,
  MeetingKind,
  RepresentativeGround,
} from "../generated/prisma/enums";
import {
  type MeetingNoticeView,
  MeetingNoticeService,
} from "./meeting-notice.service";
import {
  type AgendaItemView,
  type AttendanceView,
  MeetingService,
  type MeetingSummaryView,
  type MeetingView,
  type ProxyAuthorisationView,
} from "./meeting.service";

/**
 * The enumerated values this API accepts, written out rather than derived from
 * the generated enums.
 *
 * Every controller in this codebase writes its own: this is the wire contract,
 * and a value added to a table is a decision about the API rather than an
 * automatic widening of it. `satisfies` is what keeps the two from drifting the
 * other way - a value renamed or removed in the schema stops compiling here.
 */
const KINDS = [
  "ORDINARY",
  "EXTRAORDINARY",
] as const satisfies readonly MeetingKind[];

const CAPACITIES = [
  "MEMBER",
  "PROXY_HOLDER",
  "ASSISTANT",
] as const satisfies readonly AttendanceCapacity[];

const MODES = [
  "IN_PERSON",
  "REMOTE",
] as const satisfies readonly AttendanceMode[];

const GROUNDS = [
  "MEMBER",
  "SPOUSE_OR_COHABITANT",
  "BYLAWS",
] as const satisfies readonly RepresentativeGround[];

const OUTCOMES = [
  "CARRIED",
  "REJECTED",
] as const satisfies readonly MeetingDecisionOutcome[];

/** "YYYY-MM-DD", which the service parses strictly. */
const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);

const arrangeSchema = z.object({
  kind: z.enum(KINDS),
  heldOn: daySchema,
});

const agendaSchema = z.object({
  /**
   * The running order, as a list. The caller states the order and never the
   * numbers: a caller that stated its own could state a gap or a repeat, which
   * is not a running order.
   *
   * Bounded generously at both ends. An agenda with no items is a meeting
   * nothing was convened for, and a hundred items is far past what a general
   * meeting deals with - the cap is here so one request cannot write an
   * unbounded number of rows, not because ninety-nine is a rule anybody has.
   */
  items: z
    .array(z.object({ title: z.string().trim().min(1).max(300) }))
    .min(1)
    .max(100),
});

/**
 * The notice, in the terms EFL 6 kap. 22 § has it state itself.
 *
 * A time of day and never a date. The day a meeting is held is the meeting's own
 * and is the day that decides who has a vote at it, so a notice carrying a
 * second date could summon the members to a different day from the one the
 * register is read against. The service turns this into an instant on the
 * meeting's day, and refuses an hour the association's clock does not have.
 *
 * `digitalParticipation` is null for a meeting held in a room and the
 * instruction for one held digitally. Non-empty when present, because a digital
 * meeting whose members were told nothing about how to take part or how to vote
 * has not been summoned as that paragraph requires. The table refuses blank text
 * too; this is what turns the refusal into an answer with a reason.
 */
const noticeSchema = z.object({
  startsAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u),
  place: z.string().trim().min(1).max(300),
  digitalParticipation: z.string().trim().min(1).max(2000).nullable(),
});

const attendanceSchema = z.object({
  personId: z.string().min(1),
  capacity: z.enum(CAPACITIES),
  mode: z.enum(MODES),
  /**
   * The member or proxy holder an assistant came with.
   *
   * Required on that capacity and refused on the other two, which the service
   * decides and the table states as a check constraint. Refused rather than
   * dropped: a field a request set and the server silently ignored is a defect
   * nothing surfaces.
   */
  onBehalfOfPersonId: z.string().min(1).nullish(),
});

const proxySchema = z.object({
  memberPersonId: z.string().min(1),
  proxyHolderPersonId: z.string().min(1),
  ground: z.enum(GROUNDS),
  authorisedOn: daySchema,
});

/**
 * A recorded tally.
 *
 * Non-negative integers, bounded well above any cooperative's membership. The
 * bound is not a statutory number: it is what keeps a mis-keyed figure out of
 * the platform's copy of the protokoll's own counts, and the table checks the
 * lower end as well.
 */
const countSchema = z.number().int().min(0).max(100_000);

const decisionSchema = z.object({
  outcome: z.enum(OUTCOMES),
  votesFor: countSchema,
  votesAgainst: countSchema,
  votesAbstaining: countSchema,
  closedBallot: z.boolean(),
});

/**
 * The acting principal, or a fault.
 *
 * The global guard attaches one to every route that is not @Public(), so
 * reaching this throw means the guard stopped doing that - and a 500 naming the
 * guard is the honest answer.
 */
function requirePrincipal(request: RequestWithPrincipal): Principal {
  const principal = request.principal;
  if (principal === undefined) {
    throw new Error("The authorization guard did not attach a principal.");
  }
  return principal;
}

/**
 * The general meeting, as the board arranges and runs it.
 *
 * One capability on the class, so a route added here later inherits it rather
 * than being open by omission. There is deliberately no @Public() route: a
 * general meeting is the members' business with their own association and none
 * of it is published, and the members' own view of a meeting is a later
 * decision rather than something to leave half-open now.
 *
 * `meetings:manage` and not one capability per act, unlike the motions module's
 * two. There the split is between two audiences - a member submitting and the
 * board working the queue - and one controller carrying both would open a route
 * to the wrong half of the house. Here every act is the board's own side of the
 * same meeting: arranging it, writing its agenda, checking people in,
 * registering a proxy authorisation and minuting a decision are the same office
 * doing the same job, and splitting them would suggest an audience that does
 * not exist.
 *
 * The external property manager holds none of it, on the `motions:handle`
 * precedent: an external contractor has nothing to do with the members'
 * decisions about their own association.
 */
@Controller("api/meetings")
@RequireCapability("meetings:manage")
export class MeetingsController {
  constructor(
    private readonly meetings: MeetingService,
    private readonly notices: MeetingNoticeService,
  ) {}

  @Get()
  async list(): Promise<MeetingSummaryView[]> {
    return this.meetings.list();
  }

  /**
   * One meeting with its agenda, its list of those present, the authorities
   * registered against it, the bylaws that govern it and the register.
   *
   * One answer rather than six calls: a board checking people in needs all of it
   * at once, and a screen that fetched the parts separately would show a state
   * that never existed at any single moment.
   */
  @Get(":id")
  async read(@Param("id") id: string): Promise<MeetingView> {
    return this.meetings.read(id);
  }

  @Post()
  @HttpCode(201)
  async arrange(
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<MeetingSummaryView> {
    return this.meetings.arrange(
      arrangeSchema.parse(body),
      requirePrincipal(request).personId,
    );
  }

  /**
   * Records that the meeting has been held.
   *
   * A post to a named sub-resource rather than a patch on the meeting, on the
   * motion withdrawal's precedent: it is an act with its own entry in the audit
   * log and its own refusal, not a field somebody set.
   */
  @Post(":id/conclusion")
  async conclude(
    @Param("id") id: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<MeetingSummaryView> {
    return this.meetings.conclude(id, requirePrincipal(request).personId);
  }

  /**
   * Replaces the agenda with the items given, in the order given.
   *
   * A put, because it is the whole running order and not an addition: moving an
   * item is the same act as adding one, and an interface offering both would have
   * to reconcile two orderings.
   */
  @Put(":id/agenda")
  async setAgenda(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<AgendaItemView[]> {
    return this.meetings.setAgenda(
      id,
      agendaSchema.parse(body),
      requirePrincipal(request).personId,
    );
  }

  /**
   * Issues the notice (kallelse) that summons the meeting, and sends it.
   *
   * A post to a named sub-resource, like recording that the meeting was held,
   * because it is one act with one entry in the audit log rather than fields
   * somebody set. There is no route that edits or withdraws it: EFL 6 kap. 25 §
   * gives the remedy for a notice that went wrong and it is an extra general
   * meeting, not a second notice.
   */
  @Post(":id/notice")
  @HttpCode(201)
  async issueNotice(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<MeetingNoticeView> {
    return this.notices.issue(
      id,
      noticeSchema.parse(body),
      requirePrincipal(request).personId,
    );
  }

  @Post(":id/attendances")
  @HttpCode(201)
  async recordAttendance(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<AttendanceView> {
    return this.meetings.recordAttendance(
      id,
      attendanceSchema.parse(body),
      requirePrincipal(request).personId,
    );
  }

  /**
   * Strikes a line off the list of those present.
   *
   * A post and not a delete: the line stays and takes a date, so "was recorded
   * as present and struck off again" is answerable afterwards. Nothing in this
   * module deletes an attendance line.
   */
  @Post(":id/attendances/:attendanceId/withdrawal")
  async withdrawAttendance(
    @Param("id") id: string,
    @Param("attendanceId") attendanceId: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<AttendanceView> {
    return this.meetings.withdrawAttendance(
      id,
      attendanceId,
      requirePrincipal(request).personId,
    );
  }

  @Post(":id/proxy-authorisations")
  @HttpCode(201)
  async registerProxy(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<ProxyAuthorisationView> {
    return this.meetings.registerProxy(
      id,
      proxySchema.parse(body),
      requirePrincipal(request).personId,
    );
  }

  /** Takes an authority back. A date on the row, never a delete. */
  @Post(":id/proxy-authorisations/:authorisationId/withdrawal")
  async withdrawProxy(
    @Param("id") id: string,
    @Param("authorisationId") authorisationId: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<ProxyAuthorisationView> {
    return this.meetings.withdrawProxy(
      id,
      authorisationId,
      requirePrincipal(request).personId,
    );
  }

  /**
   * Records what the meeting decided on one agenda item.
   *
   * A put, because there is exactly one decision per item and correcting a
   * mis-keyed count writes the same row again. What stands is the signed
   * protokoll; this is the platform's copy of the figure, and the audit log
   * carries what it moved to.
   */
  @Put(":id/agenda/:agendaItemId/decision")
  async recordDecision(
    @Param("id") id: string,
    @Param("agendaItemId") agendaItemId: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<AgendaItemView> {
    return this.meetings.recordDecision(
      id,
      agendaItemId,
      decisionSchema.parse(body),
      requirePrincipal(request).personId,
    );
  }
}
