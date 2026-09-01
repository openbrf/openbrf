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
  type AgendaItemView,
  type AttendanceView,
  MeetingService,
  type MeetingSummaryView,
  type MeetingView,
  type ProxyAppointmentView,
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
   * nothing was convened for, and a hundred items is far past what a stamma
   * deals with - the cap is here so one request cannot write an unbounded number
   * of rows, not because ninety-nine is a rule anybody has.
   */
  items: z
    .array(z.object({ title: z.string().trim().min(1).max(300) }))
    .min(1)
    .max(100),
});

const attendanceSchema = z.object({
  personId: z.string().min(1),
  capacity: z.enum(CAPACITIES),
  mode: z.enum(MODES),
  /**
   * The member or ombud a bitrade came with.
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
 * stamma is the members' business with their own association and none of it is
 * published, and the members' own view of a meeting is a later decision rather
 * than something to leave half-open now.
 *
 * `meetings:manage` and not one capability per act, unlike the motions module's
 * two. There the split is between two audiences - a member submitting and the
 * board working the queue - and one controller carrying both would open a route
 * to the wrong half of the house. Here every act is the board's own side of the
 * same meeting: arranging it, writing its agenda, checking people in,
 * registering a fullmakt and minuting a decision are the same office doing the
 * same job, and splitting them would suggest an audience that does not exist.
 *
 * The external property manager holds none of it, on the `motions:handle`
 * precedent: an external contractor has nothing to do with the members'
 * decisions about their own association.
 */
@Controller("api/meetings")
@RequireCapability("meetings:manage")
export class MeetingsController {
  constructor(private readonly meetings: MeetingService) {}

  @Get()
  async list(): Promise<MeetingSummaryView[]> {
    return this.meetings.list();
  }

  /**
   * One meeting with its agenda, its list of those present, the authorities
   * registered against it, the bylaws that govern it and the roll.
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

  @Post(":id/proxy-appointments")
  @HttpCode(201)
  async registerProxy(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<ProxyAppointmentView> {
    return this.meetings.registerProxy(
      id,
      proxySchema.parse(body),
      requirePrincipal(request).personId,
    );
  }

  /** Takes an authority back. A date on the row, never a delete. */
  @Post(":id/proxy-appointments/:appointmentId/withdrawal")
  async withdrawProxy(
    @Param("id") id: string,
    @Param("appointmentId") appointmentId: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<ProxyAppointmentView> {
    return this.meetings.withdrawProxy(
      id,
      appointmentId,
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
