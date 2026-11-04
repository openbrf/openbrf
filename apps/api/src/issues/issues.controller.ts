import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
} from "@nestjs/common";
import {
  ISSUE_CLOSING_OUTCOMES,
  ISSUE_COST_RESPONSIBILITIES,
  ISSUE_CONVERSATION_LIMITS,
  ISSUE_ENTRY_ANSWERS,
  ISSUE_FINDING_KINDS,
  ISSUE_FIT_LIMITS,
  ISSUE_HANDLED_BY,
  ISSUE_PRIORITIES,
  ISSUE_QUEUE_VIEWS,
  ISSUE_REPORT_LIMITS,
  ISSUE_REPORTER_GROUPS,
  ISSUE_SEARCH_LIMITS,
  ISSUE_STATUS_LIMITS,
  ISSUE_STATUS_MEANINGS,
  ISSUE_TYPE_LIMITS,
  ISSUE_WAITING_REASONS,
  MAINTENANCE_RESPONSIBILITIES,
  RESPONSIBILITY_GUIDE_LIMITS,
} from "@openbrf/shared";
import { z } from "zod";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import type { Principal } from "../authorization/capabilities";
import { RequireCapability } from "../authorization/require-capability.decorator";
import { isTooLarge, readSingleFile } from "../http/multipart";
import { MediaError } from "../media/media.service";
import { actingPersonId } from "../registers/acting-person";
import {
  type HandlerIssueMessageView,
  type IssueAttachmentView,
  IssueConversationService,
  type IssueNoteView,
  type ReporterIssueMessageView,
} from "./issue-conversation.service";
import type { IssueEntryView } from "./issue-fit-views";
import { IssueFitService } from "./issue-fit.service";
import {
  type ConfiguredIssuePlaceView,
  type IssuePlaceChoice,
  type IssuePlaceCount,
  IssuePlaceService,
} from "./issue-place.service";
import {
  type IssueSavedReplyView,
  IssueSavedReplyService,
} from "./issue-saved-reply.service";
import {
  type ConfiguredIssueTypeView,
  type IssueHandlerChoice,
  type IssueTypeView,
  IssueTypeService,
  type ReportableIssueTypeView,
} from "./issue-type.service";
import {
  type IssueResidentChoice,
  IssueResidentsService,
} from "./issue-residents.service";
import {
  type IssueApartmentView,
  type IssueBoardFilter,
  type IssueHandlerView,
  type IssuePhotoView,
  type IssueQueueCounts,
  type IssueQueueSnapshot,
  IssueService,
  type IssueTimelineStep,
  type OwnIssueView,
  type QueuedIssueView,
} from "./issue.service";
import {
  type ResponsibilityGuideView,
  ResponsibilityGuideService,
} from "./responsibility-guide.service";

const reportSchema = z.object({
  typeId: z.string().min(1),
  apartmentId: z.string().min(1).nullish(),
  location: z.string().max(ISSUE_REPORT_LIMITS.location).nullish(),
  placeId: z.string().min(1).max(64).nullish(),
  /** The limit is shared with the form; see `ISSUE_REPORT_LIMITS`. */
  description: z.string().min(1).max(ISSUE_REPORT_LIMITS.description),
  /** The post in the feed the report is made from, when it is. */
  postId: z.string().min(1).max(64).nullish(),
});

/**
 * A move to another status. The reason and the outcome are checked against
 * the target's meaning in the service, which is the only place that reads it.
 */
const statusMoveSchema = z.object({
  statusId: z.string().min(1).max(64),
  waitingReason: z.enum(ISSUE_WAITING_REASONS).optional(),
  outcome: z.enum(ISSUE_CLOSING_OUTCOMES).optional(),
});

/**
 * A handler's opening of an issue (decision 14).
 *
 * Strict, so a field this route no longer reads - a resident named by person
 * and apartment, as the address book named one - is refused rather than
 * dropped: dropped, it would file an internal issue for a handler who meant
 * to name somebody.
 */
const openSchema = z.strictObject({
  typeId: z.string().min(1).max(64),
  /** A residency the resident picker offered; absent for an internal issue. */
  residencyId: z.string().min(1).max(64).nullish(),
  location: z.string().max(ISSUE_REPORT_LIMITS.location).nullish(),
  placeId: z.string().min(1).max(64).nullish(),
  description: z.string().trim().min(1).max(ISSUE_REPORT_LIMITS.description),
});

/**
 * What the board's screen narrows the queue to (decision 15). Strict, so a
 * parameter this route does not read is refused rather than ignored: ignored,
 * a misspelt filter would answer with the whole queue as if it were narrowed.
 *
 * `meaning` is one of the four meanings or `OPEN`, every meaning but done.
 * `q` is the search; blank is none.
 */
const boardFilterSchema = z.strictObject({
  meaning: z.enum([...ISSUE_STATUS_MEANINGS, "OPEN"]).optional(),
  typeId: z.string().min(1).max(64).optional(),
  /** Only the issues that name this common-area place (decision 30). */
  placeId: z.string().min(1).max(64).optional(),
  priority: z.enum(ISSUE_PRIORITIES).optional(),
  q: z.string().max(ISSUE_SEARCH_LIMITS.length).optional(),
});

const boardViewSchema = boardFilterSchema.extend({
  /** Absent reads every issue the reader handles, as before views. */
  view: z.enum(ISSUE_QUEUE_VIEWS).optional(),
});

/** The service's filter, from the parameters a route was given. */
function boardFilterOf(
  query: z.infer<typeof boardFilterSchema>,
): IssueBoardFilter {
  const search = query.q?.trim() ?? "";
  return {
    ...(query.meaning === undefined ? {} : { meaning: query.meaning }),
    ...(query.typeId === undefined ? {} : { typeId: query.typeId }),
    ...(query.placeId === undefined ? {} : { placeId: query.placeId }),
    ...(query.priority === undefined ? {} : { priority: query.priority }),
    ...(search === "" ? {} : { search }),
  };
}

/**
 * An issue message or an internal note. Never only whitespace: an empty
 * message would read to the reporter as the board saying nothing.
 */
const conversationSchema = z.strictObject({
  body: z.string().trim().min(1).max(ISSUE_CONVERSATION_LIMITS.body),
});

const savedReplySchema = z.strictObject({
  title: z
    .string()
    .trim()
    .min(1)
    .max(ISSUE_CONVERSATION_LIMITS.savedReplyTitle),
  body: z.string().trim().min(1).max(ISSUE_CONVERSATION_LIMITS.body),
  sortOrder: z.coerce.number().int().min(0).max(999).optional(),
});

const assignSchema = z.object({
  assigneePersonId: z.string().min(1).max(64).nullable(),
});

const prioritySchema = z.object({ priority: z.enum(ISSUE_PRIORITIES) });

/** A calendar date, or null for none; the service reads it as one. */
const targetDateSchema = z.object({
  targetDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
});

const accessSchema = z.object({ boardOnly: z.boolean() });

const calendarDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * The resident's answer to the entry question (decision 29). Strict, so a field
 * this route does not read - a door code sent as its own field, say - is
 * refused and not dropped.
 */
const entrySchema = z.strictObject({
  answer: z.enum(ISSUE_ENTRY_ANSWERS),
  note: z.string().max(ISSUE_FIT_LIMITS.entryNote).nullish(),
  pets: z.boolean().optional(),
  masterKey: z.boolean().optional(),
  until: calendarDay.nullish(),
});

const placeSchema = z.strictObject({
  placeId: z.string().min(1).max(64).nullable(),
});

const findingSchema = z.strictObject({
  kind: z.enum(ISSUE_FINDING_KINDS),
  inspectedOn: calendarDay,
  protocolAttachmentId: z.string().min(1).max(64),
  targetDate: calendarDay,
});

const placeInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(ISSUE_FIT_LIMITS.placeName),
  active: z.boolean().optional(),
  sortOrder: z.coerce.number().int().min(0).max(999).optional(),
});

/** Who pays, or null to say nothing again (decision 26). Never an amount. */
const costResponsibilitySchema = z.strictObject({
  costResponsibility: z.enum(ISSUE_COST_RESPONSIBILITIES).nullable(),
});

/**
 * The board's whole responsibility guide (decision 27). The limits are the
 * shared ones, which the service holds too; the text is trimmed and scanned
 * there, so a refusal it makes has a reason a screen can put a sentence to.
 */
const responsibilityGuideSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        part: z.string().trim().max(RESPONSIBILITY_GUIDE_LIMITS.part),
        responsibility: z.enum(MAINTENANCE_RESPONSIBILITIES),
        note: z
          .string()
          .trim()
          .max(RESPONSIBILITY_GUIDE_LIMITS.note)
          .nullable(),
      }),
    )
    .max(RESPONSIBILITY_GUIDE_LIMITS.items),
  adopted: z.boolean(),
  // The version the editor read, or null where it read a guide never saved.
  version: z.iso.datetime().nullable(),
});

const typeSchema = z.object({
  name: z.string().trim().min(1).max(ISSUE_TYPE_LIMITS.name),
  reporters: z.array(z.enum(ISSUE_REPORTER_GROUPS)).max(3),
  active: z.boolean().optional(),
  sortOrder: z.coerce.number().int().min(0).max(999).optional(),
  handledBy: z.enum(ISSUE_HANDLED_BY).optional(),
  defaultPriority: z.enum(ISSUE_PRIORITIES).optional(),
  defaultAssigneePersonId: z.string().min(1).max(64).nullable().optional(),
});

/** A status's label: the board's own text, and never only whitespace. */
const statusLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(ISSUE_STATUS_LIMITS.label);

const addStatusSchema = z.object({
  meaning: z.enum(ISSUE_STATUS_MEANINGS),
  label: statusLabelSchema,
});

const changeStatusSchema = z.object({
  label: statusLabelSchema,
  active: z.boolean().optional(),
  isDefault: z.literal(true).optional(),
  sortOrder: z.coerce
    .number()
    .int()
    .min(0)
    .max(ISSUE_STATUS_LIMITS.sortOrder)
    .optional(),
});

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
 * Reporting an issue, and reading one's own.
 *
 * The capability sits on the class, so a route added here later inherits it
 * rather than being open by omission. There is deliberately no @Public() route
 * anywhere in this module: the website's form is server-rendered by the site
 * layer, which calls the services directly, so the application exposes no
 * unauthenticated write surface for issues at all.
 */
@Controller("api/issues")
@RequireCapability("issues:report")
export class IssueReportController {
  constructor(
    private readonly issues: IssueService,
    private readonly types: IssueTypeService,
    private readonly guide: ResponsibilityGuideService,
    private readonly conversation: IssueConversationService,
    private readonly fit: IssueFitService,
    private readonly places: IssuePlaceService,
  ) {}

  /**
   * The common-area places a report may name (decision 30): the association's
   * short list, in the board's order. Names of rooms and yards, never homes.
   */
  @Get("places")
  async offeredPlaces(): Promise<IssuePlaceChoice[]> {
    return this.places.offered();
  }

  /**
   * The association's responsibility guide, shown before filing (decision
   * 27): the guide the board has adopted, or null while it is an example. A
   * reporter is never shown the example as if it were the association's
   * answer.
   */
  @Get("responsibility-guide")
  async responsibilityGuide(): Promise<{
    guide: ResponsibilityGuideView | null;
  }> {
    return { guide: await this.guide.readForReporter() };
  }

  /**
   * The types this account may report under.
   *
   * Filtered on the server for the principal asking. The list a resident gets
   * back is the list they may post against, and posting anything else is
   * answered as if that type did not exist.
   */
  @Get("types")
  async reportableTypes(
    @Req() request: RequestWithPrincipal,
  ): Promise<ReportableIssueTypeView[]> {
    return this.types.listReportable(requirePrincipal(request));
  }

  /** The reporter's own apartments, for the picker on the form. */
  @Get("apartments")
  async ownApartments(
    @Req() request: RequestWithPrincipal,
  ): Promise<IssueApartmentView[]> {
    return this.issues.ownApartments(requirePrincipal(request).personId);
  }

  @Get("mine")
  async listOwn(@Req() request: RequestWithPrincipal): Promise<OwnIssueView[]> {
    return this.issues.listOwn(requirePrincipal(request).personId);
  }

  @Post()
  @HttpCode(201)
  async report(
    @Req() request: RequestWithPrincipal,
    @Body() body: unknown,
  ): Promise<{ id: string }> {
    return this.issues.report(
      requirePrincipal(request),
      reportSchema.parse(body),
    );
  }

  /**
   * Attaches a photograph to one's own report.
   *
   * Multipart rather than JSON, like the logo upload: the bytes travel as
   * bytes, and the size limit is enforced by the parser as they arrive rather
   * than after the whole body is in the process.
   */
  @Post(":id/photos")
  @HttpCode(201)
  async attachPhoto(
    @Param("id") id: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<IssuePhotoView> {
    const principal = requirePrincipal(request);

    const file = await readSingleFile(request).catch((cause: unknown) => {
      if (isTooLarge(cause)) {
        throw new MediaError("The file is larger than allowed.", "too-large");
      }
      throw cause;
    });

    if (file === null) {
      throw new MediaError("The request carried no file.", "no-file");
    }

    return this.issues.attachPhoto({
      issueId: id,
      reporterPersonId: principal.personId,
      bytes: file.bytes,
      fileName: file.fileName,
    });
  }

  /**
   * Answers the entry question on one's own report (decision 29): whether the
   * association or its contractor may enter the apartment it is about. A note
   * that reads like a door code is refused.
   */
  @Put(":id/entry-permission")
  async answerEntry(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<{ entry: IssueEntryView | null }> {
    return {
      entry: await this.fit.answerEntry(
        requirePrincipal(request).personId,
        id,
        entrySchema.parse(body),
      ),
    };
  }

  /** Withdraws the answer to the entry question. */
  @Delete(":id/entry-permission")
  async withdrawEntry(
    @Param("id") id: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<{ entry: IssueEntryView | null }> {
    return {
      entry: await this.fit.withdrawEntry(
        requirePrincipal(request).personId,
        id,
      ),
    };
  }

  /**
   * The conversation on one's own report: one's own messages, and the
   * handlers' signed with a role and never a name (decision 19).
   */
  @Get(":id/messages")
  async messages(
    @Param("id") id: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<ReporterIssueMessageView[]> {
    return this.conversation.reporterThread(
      requirePrincipal(request).personId,
      id,
    );
  }

  /** Writes on one's own report. */
  @Post(":id/messages")
  @HttpCode(201)
  async reply(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<ReporterIssueMessageView> {
    return this.conversation.replyAsReporter(
      requirePrincipal(request).personId,
      id,
      conversationSchema.parse(body).body,
    );
  }
}

/**
 * The triage queue.
 *
 * Its own base path rather than a route under the reporting controller, because
 * the capability covers the whole class: one @RequireCapability("issues:report")
 * and one @RequireCapability("issues:handle") on the same controller would be a
 * route that is open to the wrong half of the house.
 */
@Controller("api/issue-queue")
@RequireCapability("issues:handle")
export class IssueQueueController {
  constructor(
    private readonly issues: IssueService,
    private readonly types: IssueTypeService,
    private readonly residents: IssueResidentsService,
    private readonly guide: ResponsibilityGuideService,
    private readonly conversation: IssueConversationService,
    private readonly savedReplies: IssueSavedReplyService,
    private readonly fit: IssueFitService,
    private readonly places: IssuePlaceService,
  ) {}

  /**
   * The common-area places with how many of the issues this reader handles
   * name each (decision 30): the count that makes a repeat fault visible.
   */
  @Get("places")
  async placeCounts(
    @Req() request: RequestWithPrincipal,
  ): Promise<IssuePlaceCount[]> {
    return this.places.counts(actingPersonId(request));
  }

  /**
   * The responsibility guide as a handler reads it when deciding who pays:
   * adopted or not, and labelled as an example while it is not (decision 27).
   */
  @Get("responsibility-guide")
  async responsibilityGuide(): Promise<ResponsibilityGuideView> {
    return this.guide.read();
  }

  /**
   * Every type the reader handles, with its statuses, which is what a handler
   * moves an issue between and opens one under.
   *
   * Under issues:handle rather than the catalogue's issues:configure, because
   * moving an issue needs its type's statuses and the property manager, who
   * handles issues, does not configure them. It reads what `issue_type_list`
   * already gives the same holder (ADR 0040): the board's names for its
   * categories and their statuses, and counts. A type the board keeps to
   * itself is left out for the property manager (ADR 0054).
   */
  @Get("types")
  async listTypes(
    @Req() request: RequestWithPrincipal,
  ): Promise<IssueTypeView[]> {
    return this.issues.handledTypes(actingPersonId(request));
  }

  /**
   * One view of the queue - Mina, Ej tilldelade, Försenade or Alla - narrowed
   * by status, type, priority and a search (decision 15). With no parameters,
   * every issue the reader handles.
   */
  @Get()
  async list(
    @Req() request: RequestWithPrincipal,
    @Query() query: unknown,
  ): Promise<QueuedIssueView[]> {
    const parsed = boardViewSchema.parse(query);
    return this.issues.listQueue(
      actingPersonId(request),
      parsed.view ?? "ALL",
      boardFilterOf(parsed),
    );
  }

  /**
   * How many issues each view holds under the same filter, counted as the
   * views are read: the numbers on the screen's views and, with
   * `meaning=OPEN` alone, the board's front page.
   */
  @Get("counts")
  async counts(
    @Req() request: RequestWithPrincipal,
    @Query() query: unknown,
  ): Promise<IssueQueueCounts> {
    return this.issues.countQueue(
      actingPersonId(request),
      boardFilterOf(boardFilterSchema.parse(query)),
    );
  }

  /**
   * What the queue screen draws: one view's issues and every view's count
   * under the same filter, read at one moment, so a count never disagrees
   * with the list beside it. Takes the parameters the list does.
   */
  @Get("snapshot")
  async snapshot(
    @Req() request: RequestWithPrincipal,
    @Query() query: unknown,
  ): Promise<IssueQueueSnapshot> {
    const parsed = boardViewSchema.parse(query);
    return this.issues.readQueueSnapshot(
      actingPersonId(request),
      parsed.view ?? "ALL",
      boardFilterOf(parsed),
    );
  }

  /** Opens an issue for a named resident, or with no reporter (decision 14). */
  @Post()
  @HttpCode(201)
  async open(
    @Req() request: RequestWithPrincipal,
    @Body() body: unknown,
  ): Promise<QueuedIssueView> {
    return this.issues.open(requirePrincipal(request), openSchema.parse(body));
  }

  /**
   * The apartments a handler names a resident from, by designation (the
   * resident picker, ADR 0054).
   */
  @Get("apartments")
  async apartments(
    @Req() request: RequestWithPrincipal,
  ): Promise<IssueApartmentView[]> {
    return this.residents.apartments(actingPersonId(request));
  }

  /**
   * Who lives in one apartment today, by name, a protected resident's
   * withheld, keyed by residency. No search, and nobody who has moved out or
   * not yet in. Audited.
   */
  @Get("apartments/:apartmentId/residents")
  async residentsOf(
    @Param("apartmentId") apartmentId: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<IssueResidentChoice[]> {
    return this.residents.residents(actingPersonId(request), apartmentId);
  }

  /**
   * The association's saved replies, which a handler starts a message from
   * (decision 17). Read by every handler; written under issues:configure.
   */
  @Get("saved-replies")
  async listSavedReplies(): Promise<IssueSavedReplyView[]> {
    return this.savedReplies.list();
  }

  /** The conversation with the reporter, each handler's message named. */
  @Get(":id/messages")
  async messages(
    @Param("id") id: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<HandlerIssueMessageView[]> {
    return this.conversation.handlerThread(actingPersonId(request), id);
  }

  /** Writes to the reporter, signed with the writer's role (decision 19). */
  @Post(":id/messages")
  @HttpCode(201)
  async reply(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<HandlerIssueMessageView> {
    return this.conversation.replyAsHandler(
      actingPersonId(request),
      id,
      conversationSchema.parse(body).body,
    );
  }

  /** The handlers' internal notes, which the reporter never reads. */
  @Get(":id/notes")
  async notes(
    @Param("id") id: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<IssueNoteView[]> {
    return this.conversation.notes(actingPersonId(request), id);
  }

  @Post(":id/notes")
  @HttpCode(201)
  async addNote(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<IssueNoteView> {
    return this.conversation.addNote(
      actingPersonId(request),
      id,
      conversationSchema.parse(body).body,
    );
  }

  /** The files the handlers attached for each other. */
  @Get(":id/attachments")
  async attachments(
    @Param("id") id: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<IssueAttachmentView[]> {
    return this.conversation.attachments(actingPersonId(request), id);
  }

  /**
   * Attaches an image or a PDF for the other handlers. Multipart, as a
   * reporter's photograph is.
   */
  @Post(":id/attachments")
  @HttpCode(201)
  async attach(
    @Param("id") id: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<IssueAttachmentView> {
    const handlerPersonId = actingPersonId(request);
    const file = await readSingleFile(request).catch((cause: unknown) => {
      if (isTooLarge(cause)) {
        throw new MediaError("The file is larger than allowed.", "too-large");
      }
      throw cause;
    });
    if (file === null) {
      throw new MediaError("The request carried no file.", "no-file");
    }
    return this.conversation.attach({
      issueId: id,
      handlerPersonId,
      bytes: file.bytes,
      fileName: file.fileName,
    });
  }

  /** Who the issue may be assigned to: names, and nothing else. */
  @Get(":id/handlers")
  async handlers(
    @Param("id") id: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<IssueHandlerView[]> {
    return this.issues.handlers(actingPersonId(request), id);
  }

  /** Who did what to the issue, and when (decision 16). */
  @Get(":id/timeline")
  async timeline(
    @Param("id") id: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<IssueTimelineStep[]> {
    return this.issues.timeline(actingPersonId(request), id);
  }

  @Post(":id/assignee")
  async assign(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<QueuedIssueView> {
    return this.issues.assign(
      id,
      assignSchema.parse(body).assigneePersonId,
      actingPersonId(request),
    );
  }

  @Post(":id/priority")
  async setPriority(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<QueuedIssueView> {
    return this.issues.setPriority(
      id,
      prioritySchema.parse(body).priority,
      actingPersonId(request),
    );
  }

  @Post(":id/target-date")
  async setTargetDate(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<QueuedIssueView> {
    return this.issues.setTargetDate(
      id,
      targetDateSchema.parse(body).targetDate,
      actingPersonId(request),
    );
  }

  /** Closes the issue to all but the board, or opens it again (decision 13). */
  @Post(":id/access")
  async setAccess(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<QueuedIssueView> {
    return this.issues.setBoardOnly(
      id,
      accessSchema.parse(body).boardOnly,
      actingPersonId(request),
    );
  }

  /** Sets the common-area place the issue is about, or takes it off. */
  @Put(":id/place")
  async setPlace(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<QueuedIssueView> {
    return this.fit.setPlace(
      actingPersonId(request),
      id,
      placeSchema.parse(body).placeId,
    );
  }

  /**
   * Records the resident's answer to the entry question, given to a handler
   * by telephone or at the door (decision 29).
   */
  @Put(":id/entry-permission")
  async answerEntry(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<{ entry: IssueEntryView | null }> {
    return {
      entry: await this.fit.answerEntryAsHandler(
        actingPersonId(request),
        id,
        entrySchema.parse(body),
      ),
    };
  }

  @Delete(":id/entry-permission")
  async withdrawEntry(
    @Param("id") id: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<{ entry: IssueEntryView | null }> {
    return {
      entry: await this.fit.withdrawEntryAsHandler(actingPersonId(request), id),
    };
  }

  /**
   * Marks the issue as a finding of an OVK, lift or fire inspection, with its
   * protocol and a real target date (decision 31).
   */
  @Put(":id/finding")
  async markFinding(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<QueuedIssueView> {
    return this.fit.markFinding(
      actingPersonId(request),
      id,
      findingSchema.parse(body),
    );
  }

  @Delete(":id/finding")
  async removeFinding(
    @Param("id") id: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<QueuedIssueView> {
    return this.fit.removeFinding(actingPersonId(request), id);
  }

  /** Who pays for the issue (decision 26). The value, never an amount. */
  @Post(":id/cost-responsibility")
  async setCostResponsibility(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<QueuedIssueView> {
    return this.issues.setCostResponsibility(
      id,
      costResponsibilitySchema.parse(body).costResponsibility,
      actingPersonId(request),
    );
  }

  @Post(":id/status")
  async setStatus(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<QueuedIssueView> {
    return this.issues.setStatus(
      id,
      statusMoveSchema.parse(body),
      actingPersonId(request),
    );
  }
}

/**
 * The board's own catalogue of issue types.
 *
 * issues:configure rather than association:manage: which problems residents are
 * asked to sort their reports into is the board's vocabulary for its building,
 * the way the retention policy is the board's decision about its data.
 */
@Controller("api/issue-types")
@RequireCapability("issues:configure")
export class IssueTypeAdminController {
  constructor(private readonly types: IssueTypeService) {}

  @Get()
  async list(): Promise<ConfiguredIssueTypeView[]> {
    return this.types.listConfigured();
  }

  /**
   * Who a type's issues may be given to by default: every handler, by name
   * and nothing else, each marked with whether the board keeps them on a type
   * handled by the board only.
   */
  @Get("handlers")
  async handlers(): Promise<IssueHandlerChoice[]> {
    return this.types.handlerChoices();
  }

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown): Promise<ConfiguredIssueTypeView> {
    return this.types.create(typeSchema.parse(body));
  }

  @Put(":id")
  async update(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<ConfiguredIssueTypeView> {
    return this.types.update(
      id,
      typeSchema.parse(body),
      actingPersonId(request),
    );
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@Param("id") id: string): Promise<void> {
    await this.types.remove(id);
  }

  /** Adds a status to a type, under one of the four meanings. */
  @Post(":id/statuses")
  @HttpCode(201)
  async addStatus(
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<ConfiguredIssueTypeView> {
    return this.types.addStatus(id, addStatusSchema.parse(body));
  }

  /**
   * Renames a status, switches it on or off, moves it, or makes it the default
   * of its meaning. There is no route that removes one: a status is switched
   * off, so the issues that stood in it keep saying where they stood.
   */
  @Put(":id/statuses/:statusId")
  async changeStatus(
    @Param("id") id: string,
    @Param("statusId") statusId: string,
    @Body() body: unknown,
  ): Promise<ConfiguredIssueTypeView> {
    return this.types.updateStatus(
      id,
      statusId,
      changeStatusSchema.parse(body),
    );
  }
}

/**
 * The board's responsibility guide (ansvarsfördelning, decision 27): which
 * part of the home the association maintains and which the tenant-owner does,
 * as the board reads its own bylaws.
 *
 * issues:configure, as the type catalogue is: it is the board's account of
 * its building for the people who report to it. A base path of its own,
 * because the catalogue's routes take a type's identifier where this would
 * sit.
 */
@Controller("api/responsibility-guide")
@RequireCapability("issues:configure")
export class ResponsibilityGuideAdminController {
  constructor(private readonly guide: ResponsibilityGuideService) {}

  @Get()
  async read(): Promise<ResponsibilityGuideView> {
    return this.guide.read();
  }

  /** Replaces the whole guide, and adopts it or withdraws the adoption. */
  @Put()
  async save(@Body() body: unknown): Promise<ResponsibilityGuideView> {
    return this.guide.save(responsibilityGuideSchema.parse(body));
  }
}

/**
 * The association's saved replies (decision 17), which the board writes for
 * its handlers. issues:configure, as the type catalogue is: they are the
 * board's words, sent in its name.
 */
@Controller("api/issue-saved-replies")
@RequireCapability("issues:configure")
export class IssueSavedReplyAdminController {
  constructor(private readonly savedReplies: IssueSavedReplyService) {}

  @Get()
  async list(): Promise<IssueSavedReplyView[]> {
    return this.savedReplies.list();
  }

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown): Promise<IssueSavedReplyView> {
    return this.savedReplies.create(savedReplySchema.parse(body));
  }

  @Put(":id")
  async update(
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<IssueSavedReplyView> {
    return this.savedReplies.update(id, savedReplySchema.parse(body));
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@Param("id") id: string): Promise<void> {
    await this.savedReplies.remove(id);
  }
}

/**
 * The association's list of common-area places (decision 30), which the board
 * keeps. issues:configure, as the type catalogue is: the list is the board's
 * vocabulary for its building.
 */
@Controller("api/issue-places")
@RequireCapability("issues:configure")
export class IssuePlaceAdminController {
  constructor(private readonly places: IssuePlaceService) {}

  @Get()
  async list(): Promise<ConfiguredIssuePlaceView[]> {
    return this.places.configured();
  }

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown): Promise<ConfiguredIssuePlaceView> {
    return this.places.create(placeInputSchema.parse(body));
  }

  @Put(":id")
  async update(
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<ConfiguredIssuePlaceView> {
    return this.places.update(id, placeInputSchema.parse(body));
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@Param("id") id: string): Promise<void> {
    await this.places.remove(id);
  }
}
