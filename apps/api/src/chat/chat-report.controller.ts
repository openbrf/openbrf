import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import { z } from "zod";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import { RequireCapability } from "../authorization/require-capability.decorator";
import {
  ChatReportService,
  REPORT_NOTE_MAX_LENGTH,
  type ChatReportQueueView,
  type ChatReportView,
} from "./chat-report.service";
import { requirePrincipal } from "./chat.controller";

/**
 * Reporting a message, and what the board does about one.
 *
 * Two audiences on one path, and the capability is declared per route rather
 * than on the class. Reporting is done by somebody inside a room and needs
 * `chat:participate`; reading the queue and striking a message through are the
 * board's and need `chat:moderate`. One decorator on the class would open one
 * half of this file to the wrong half of the house.
 *
 * Every route the board reaches takes a report identifier. There is deliberately
 * no route that takes a message or a room: the board's whole way into a group is
 * a report from inside it, so a board member cannot strike a message nobody
 * reported, and cannot ask about a room at all.
 *
 * `chat:moderate` is what opens those three routes, and it is not the whole of
 * what they ask: the service then asks the register for a board seat, because
 * the administrator holds every capability and holds no seat. The division is
 * the rooms' own - the capability opens the endpoint, the register decides what
 * is behind it - and it is stated once, in the service, rather than three times
 * here.
 */

const reportSchema = z.object({
  messageId: z.string().min(1).max(64),
  /**
   * What the reporter wants to say about it.
   *
   * Optional, because the message travels with the report and a reporter who has
   * nothing to add should not have to invent something. Trimmed to null when it
   * is empty, so a note is either words or nothing.
   */
  note: z
    .string()
    .max(REPORT_NOTE_MAX_LENGTH)
    .optional()
    .transform((value) => {
      const trimmed = value?.trim() ?? "";
      return trimmed === "" ? null : trimmed;
    }),
});

@Controller("api/chat-reports")
export class ChatReportController {
  constructor(private readonly reports: ChatReportService) {}

  @Post()
  @HttpCode(201)
  @RequireCapability("chat:participate")
  async report(
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<{ reportId: string }> {
    const input = reportSchema.parse(body);
    return this.reports.report(
      requirePrincipal(request),
      input.messageId,
      input.note,
    );
  }

  /**
   * What the board has been asked to look at.
   *
   * It lists reported messages and never rooms. A board that has had no report
   * reads an empty queue, which is also the whole of what it can learn about
   * whether this cooperative has any groups at all. An account holding the
   * capability and no seat is told that the queue is not theirs, rather than
   * that nothing has been reported.
   */
  @Get()
  @RequireCapability("chat:moderate")
  async queue(
    @Req() request: RequestWithPrincipal,
  ): Promise<ChatReportQueueView> {
    return this.reports.queue(requirePrincipal(request));
  }

  @Post(":reportId/strike")
  @HttpCode(200)
  @RequireCapability("chat:moderate")
  async strike(
    @Param("reportId") reportId: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<ChatReportView> {
    return this.reports.strike(requirePrincipal(request), reportId);
  }

  @Post(":reportId/dismiss")
  @HttpCode(200)
  @RequireCapability("chat:moderate")
  async dismiss(
    @Param("reportId") reportId: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<ChatReportView> {
    return this.reports.dismiss(requirePrincipal(request), reportId);
  }
}
