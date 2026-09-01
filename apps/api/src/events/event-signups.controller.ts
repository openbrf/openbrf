import { Controller, Get, HttpCode, Param, Post, Req } from "@nestjs/common";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import type { Principal } from "../authorization/capabilities";
import { RequireCapability } from "../authorization/require-capability.decorator";
import {
  type AttendableOccurrenceView,
  EventSignupService,
  type RollCallView,
} from "./event-signup.service";

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
 * Signing up to a date in the association's calendar (anmalan), as a resident.
 *
 * One capability, declared on the class so a route added here later inherits it
 * rather than being open by omission. Everything on it is scoped to the caller:
 * the calendar says how many places are gone and never who has them, and standing
 * down acts on the caller's own sign-up only. Who is coming is events:manage and
 * lives on the controller below.
 *
 * Its own base path rather than routes under the board's `api/events`, on the
 * argument the booking module makes and that the events module comment already
 * stated: one controller carrying two capabilities is a route open to the wrong
 * half of the house.
 *
 * Both writes are a POST to a named act. Nothing here is deleted - standing down
 * writes a date on the row - and no request body carries anything: what date, and
 * which person, are the path and the session, so there is nothing left to
 * validate.
 *
 * Both answer 200 rather than 201. What comes back is the state of the date, not
 * a resource at a new address: signing up again after standing down creates
 * nothing at all, and a screen reads the count and its own place out of one
 * payload either way.
 */
@Controller("api/event-signups")
@RequireCapability("events:attend")
export class EventSignupController {
  constructor(private readonly signups: EventSignupService) {}

  /** The dates still to come, with the caller's own place on each. */
  @Get()
  async upcoming(
    @Req() request: RequestWithPrincipal,
  ): Promise<AttendableOccurrenceView[]> {
    return this.signups.upcoming(requirePrincipal(request).personId);
  }

  /**
   * Takes a place at one date.
   *
   * Answers with the date as it stands after the claim rather than with the
   * sign-up alone, so the count and the caller's own state arrive together and a
   * screen has nothing to work out for itself.
   */
  @Post(":occurrenceId")
  @HttpCode(200)
  async signUp(
    @Param("occurrenceId") occurrenceId: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<AttendableOccurrenceView> {
    return this.signups.signUp(
      requirePrincipal(request).personId,
      occurrenceId,
    );
  }

  /**
   * Stands the caller down from one date.
   *
   * Keyed on the date and not on the sign-up's own identifier: what the person
   * has is the cleaning day on the 18th, and the place is free again the moment
   * the withdrawal date is written.
   */
  @Post(":occurrenceId/withdraw")
  @HttpCode(200)
  async withdraw(
    @Param("occurrenceId") occurrenceId: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<AttendableOccurrenceView> {
    return this.signups.withdrawOwn(
      requirePrincipal(request).personId,
      occurrenceId,
    );
  }
}

/**
 * Who is coming, and standing somebody down on their behalf.
 *
 * events:manage, because a roll-call is a list of named residents and which of
 * them is going to which of the association's dates is personal data no other
 * resident is shown. A person with protected personal data is named on it to
 * nobody at all - their place is counted and their name is not.
 *
 * Withdrawing on somebody's behalf is here rather than on the board's series
 * controller because it is the same subject as the roll-call: it is what makes
 * the refusal to move a date people are standing on actionable, and the board
 * takes it one person at a time from the list it is reading.
 */
@Controller("api/event-attendance")
@RequireCapability("events:manage")
export class EventAttendanceAdminController {
  constructor(private readonly signups: EventSignupService) {}

  @Get("occurrences/:occurrenceId")
  async rollCall(
    @Param("occurrenceId") occurrenceId: string,
  ): Promise<RollCallView> {
    return this.signups.rollCall(occurrenceId);
  }

  /**
   * Withdraws one sign-up on behalf of the person who made it.
   *
   * Keyed on the sign-up, which is what the roll-call above gives: the board is
   * standing one named person down rather than clearing a date, and there is
   * deliberately no route that withdraws everybody at once. Calling a date off is
   * the act for that, and it leaves the sign-ups saying who had been expected.
   */
  @Post("signups/:signupId/withdraw")
  @HttpCode(200)
  async withdraw(
    @Param("signupId") signupId: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<RollCallView> {
    return this.signups.withdrawFor(
      signupId,
      requirePrincipal(request).personId,
    );
  }
}
