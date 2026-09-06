import { Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
import { z } from "zod";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import type { Principal } from "../authorization/capabilities";
import { RequireCapability } from "../authorization/require-capability.decorator";
import {
  type BoardMailboxStatusView,
  type BoardMailboxThreadSummary,
  type BoardMailboxThreadView,
  BoardMailboxService,
  MAX_REPLY_CHARACTERS,
} from "./board-mailbox.service";
import {
  type CollectionSummary,
  BoardMailboxCollectorService,
} from "./board-mailbox-collector.service";

const STATUSES = ["NEW", "TAKEN", "ANSWERED", "CLOSED"] as const;

const replySchema = z.object({
  body: z.string().min(1).max(MAX_REPLY_CHARACTERS),
});

const closedSchema = z.object({ closed: z.boolean() });

/**
 * The acting principal, or a fault.
 *
 * The global guard attaches one to every route that is not @Public(), so
 * reaching this throw means the guard stopped doing that - and a 500 naming the
 * guard is the honest answer, rather than a database lookup for the empty id.
 */
function requirePrincipal(request: RequestWithPrincipal): Principal {
  const principal = request.principal;
  if (principal === undefined) {
    throw new Error("The authorization guard did not attach a principal.");
  }
  return principal;
}

/**
 * The board's shared mailbox.
 *
 * The capability sits on the class, so a route added here later inherits it
 * rather than being open by omission. There is deliberately no @Public() route
 * anywhere in this module and no path from the website into it: what arrives at
 * a board's address is the association's private correspondence, and nothing
 * about it reaches the public site.
 *
 * Configuring the mailbox is not here. Where the mail is collected from and with
 * which credentials is `association:manage`, on the settings controller beside
 * the SMTP and SMS settings, because it is the same question - which mail server
 * does this instance talk to - answered by the same person. What this controller
 * carries is the board's own work: reading the inbox, taking a letter on,
 * answering it and closing it.
 */
@Controller("api/board-mailbox")
@RequireCapability("boardMailbox:handle")
export class BoardMailboxController {
  constructor(
    private readonly mailbox: BoardMailboxService,
    private readonly collector: BoardMailboxCollectorService,
  ) {}

  /**
   * Whether a mailbox is configured, and which address it answers as.
   *
   * Read by the board rather than by an administrator, although configuring it
   * is the administrator's: a board looking at an empty inbox has to be able to
   * tell "nobody has written" from "this instance is not collecting anything",
   * and those two look identical without this.
   */
  @Get("status")
  async status(): Promise<BoardMailboxStatusView> {
    return this.mailbox.status();
  }

  @Get("threads")
  async listThreads(
    @Query("status") status?: string,
  ): Promise<BoardMailboxThreadSummary[]> {
    const filter = z.enum(STATUSES).optional().parse(status);
    return this.mailbox.listThreads({ status: filter });
  }

  @Get("threads/:id")
  async readThread(@Param("id") id: string): Promise<BoardMailboxThreadView> {
    return this.mailbox.readThread(id);
  }

  @Post("threads/:id/take")
  async take(
    @Param("id") id: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<BoardMailboxThreadView> {
    return this.mailbox.take(id, requirePrincipal(request));
  }

  @Post("threads/:id/release")
  async release(
    @Param("id") id: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<BoardMailboxThreadView> {
    return this.mailbox.release(id, requirePrincipal(request));
  }

  @Post("threads/:id/reply")
  async reply(
    @Param("id") id: string,
    @Req() request: RequestWithPrincipal,
    @Body() body: unknown,
  ): Promise<BoardMailboxThreadView> {
    const input = replySchema.parse(body);
    return this.mailbox.reply(id, requirePrincipal(request), input.body);
  }

  @Post("threads/:id/closed")
  async setClosed(
    @Param("id") id: string,
    @Req() request: RequestWithPrincipal,
    @Body() body: unknown,
  ): Promise<BoardMailboxThreadView> {
    const input = closedSchema.parse(body);
    return this.mailbox.setClosed(id, input.closed, requirePrincipal(request));
  }

  /**
   * Collects the mailbox now.
   *
   * A control the board actually wants rather than a lever for a test: the
   * schedule collects every five minutes, and the two moments a board needs an
   * answer sooner are the ones that matter most. The first is just after the
   * settings have been filled in, when the question is whether the credentials
   * work at all and the alternative is waiting five minutes to find out that a
   * password is wrong. The second is a board member on the telephone with
   * somebody who has just pressed send.
   *
   * It runs the collection rather than queueing it, because the value is the
   * answer: how many letters arrived, or which way the mailbox refused. A queued
   * job would return nothing and leave the screen saying only that it had asked.
   */
  @Post("collect")
  async collect(): Promise<CollectionSummary> {
    return this.collector.collect();
  }
}
