import { Injectable, type OnModuleInit } from "@nestjs/common";
import type { ActionContext, ActionDefinition } from "@openbrf/plugin-sdk";
import { PAGE_CONTENT_LIMITS } from "@openbrf/shared";
import { z } from "zod";

import { NEWS_ACTION_ERRORS } from "../actions/action-errors";
import { CoreActionRegistrar } from "../actions/action-registrar";
import { actorOf } from "../actions/actor-of";
import {
  PAGE_CONTENT_VERSION,
  proseBlockSchema,
  submittedContent,
} from "../site/page-content";
import {
  type NewsAdminView,
  type NewsSummary,
  NewsWriteService,
  type PublishNewsResult,
} from "./news-write.service";

/**
 * The association's news, reachable as actions.
 *
 * The same service the board's own screen writes through, declared a second
 * time for a caller that is not sitting at that screen. The two contracts are
 * deliberately not the same contract: this one is read by a model, so it is
 * narrower wherever the looser half of the HTTP route is a convenience a person
 * can be trusted with and a trap a model cannot.
 *
 * One thing is missing from it on purpose, and it is the reason this exists as
 * its own file rather than as a handful of extra routes.
 *
 * **Nothing here mails the members.** `PublishNewsInput` carries `sendEmail`
 * and `sendSms`, and no action below sets either. An email reaches every member
 * whose address the association holds, it cannot be recalled, and the mailing is
 * claimed exactly once - so something acting through a connected app may write
 * the association's news and put it on the website, and may never put it in
 * anybody's mailbox. `news_request_mailing` is the whole of what it can express,
 * and a board member answers the request on a screen. Because every input here
 * is a strict object, a caller that invents `sendEmail` is refused with a 400
 * rather than quietly having the key dropped - which is the failure that would
 * otherwise read, to whoever wrote the caller, exactly like a mailing that went
 * out.
 */

/**
 * The address an action may give a news item.
 *
 * Narrower than the board's own screen, which takes any trimmed eighty
 * characters. The slug is what the audit entry records as the fact of what was
 * published where, and eighty arbitrary characters chosen by a model is not a
 * fact anybody can read back later. The HTTP route keeps its looser schema: two
 * contracts over one service, deliberately. This one is a subset of the shape
 * the service itself enforces, so no address it publishes is one `isSlugShaped`
 * would then refuse.
 */
const ACTION_SLUG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * What every action in this group declares alike.
 *
 * One capability for all nine: writing news is publishing in the cooperative's
 * name, which is the act `site:manage` describes and the same grant the board's
 * screen sits behind - so an action is never a way to do something its caller
 * could not already do there.
 *
 * `personalData: []` because a news item is the association's own prose about
 * its own house. The one thing here that is about a person - who asked for a
 * mailing - is a boolean in the service's view and never a name.
 *
 * `surfaces` omits "ai": these are offered in the product and to a connected
 * app the board has switched on, and the AI package reaches nothing until it is
 * added here deliberately.
 *
 * `errors` is empty. The refusals below are the write service's own domain
 * errors and travel to the caller unchanged with their reason and status; what
 * a model should do about each of them - edit and retry, or never - is not yet
 * written down.
 */
const SHARED_DECLARATION = {
  capability: "site:manage",
  group: "news",
  groupTitleKey: "actions.group.news.title",
  openWorld: false,
  personalData: [],
  surfaces: ["ui", "mcp"],
  /*
   * Every refusal NewsWriteService can raise, with a verdict on each. A caller
   * that is a model needs to know that a taken address is worth another try
   * with a different one, and that a mailing already sent is not.
   */
  errors: NEWS_ACTION_ERRORS,
} as const satisfies Partial<ActionDefinition>;

/** The id of an item, as every read and every write here names it. */
const newsIdSchema = z
  .string()
  .min(1)
  .max(64)
  .describe("The id of the news item, as a list or a create answered with.");

const slugSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(ACTION_SLUG_SHAPE)
  .describe(
    "The address the item is published at, under /nyheter: lowercase words " +
      "and digits joined by single hyphens. It cannot be changed once the " +
      "members have been written to.",
  );

const titleSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe("The headline, as plain text.");

/**
 * The body: prose and nothing else.
 *
 * `proseBlockSchema` rather than the full block union, because the service
 * refuses everything else - `onlyProse` throws `unsupported-block` for any
 * block `isTextBlock` rejects - and a published document has to say the same
 * thing the runtime does. Offering all twelve block types to a caller that is a
 * model produces a 400 the document promised was valid.
 *
 * Bounded at the same number the write path accepts, for the same reason: a
 * longer list would be refused by `submittedContent` inside the handler, where
 * the refusal is no longer the caller's malformed input but this instance's
 * fault.
 */
const blocksSchema = z
  .array(proseBlockSchema)
  .max(PAGE_CONTENT_LIMITS.blocks)
  .describe(
    "The body, as a list of blocks. A news item holds paragraphs and " +
      "headings only.",
  );

const visibilitySchema = z
  .enum(["PUBLIC", "MEMBER"])
  .describe(
    "Who may read it: PUBLIC for anybody on the website, MEMBER for the " +
      "people who live in the house.",
  );

/** One channel of a mailing, as counts and never as people. */
const deliveryReportSchema = z.strictObject({
  pending: z
    .int()
    .describe("Members the mailing was claimed for and not yet handed over."),
  sent: z.int().describe("Members the message reached."),
  failed: z.int().describe("Members it could not be delivered to."),
  notConfigured: z
    .boolean()
    .describe(
      "Whether a delivery failed because this instance has no provider for " +
        "the channel.",
    ),
});

/**
 * A news item as the board's own editor sees it, drafts included.
 *
 * Every read here answers with this, `published` and all: a caller that cannot
 * tell a draft from a notice on the website cannot decide anything about it.
 *
 * The mailing columns are in it because they are the answer to "have the
 * members already been told", which is exactly what something that may not mail
 * them needs to know before it asks for a mailing. They are instants and counts;
 * no field on this view can carry a member's name.
 */
const adminViewSchema = z.strictObject({
  id: z.string().describe("The id of the news item."),
  slug: z.string().describe("The address it is published at, under /nyheter."),
  title: z.string().describe("The headline."),
  content: z
    .strictObject({
      version: z.literal(PAGE_CONTENT_VERSION).describe("The body's version."),
      blocks: z
        .array(proseBlockSchema)
        .describe("The body, as the website would render it."),
    })
    .describe("The body, read back the way the website reads it."),
  visibility: z.enum(["PUBLIC", "MEMBER"]).describe("Who may read it."),
  published: z
    .boolean()
    .describe("Whether it is on the website, rather than a draft."),
  publishedAt: z.iso
    .datetime()
    .nullable()
    .describe("When it was first published, or null while it never has been."),
  emailQueuedAt: z.iso
    .datetime()
    .nullable()
    .describe(
      "When the mailing to the members was claimed, or null: they have not " +
        "been mailed about this item and can be, once.",
    ),
  smsQueuedAt: z.iso
    .datetime()
    .nullable()
    .describe("When the text message to the members was claimed, or null."),
  delivery: z
    .strictObject({
      email: deliveryReportSchema.describe("How the mailing is going."),
      sms: deliveryReportSchema.describe("How the text message is going."),
    })
    .describe("How each channel of a claimed mailing is going."),
  mailingRequested: z
    .boolean()
    .describe(
      "Whether a mailing to the members has been asked for and is waiting " +
        "for a board member to answer it.",
    ),
  updatedAt: z.iso.datetime().describe("When it was last written to."),
});

/** A news item without its body, which is what a page of them holds. */
const summarySchema = z.strictObject({
  id: z.string().describe("The id of the news item."),
  slug: z.string().describe("The address it is published at, under /nyheter."),
  title: z.string().describe("The headline."),
  published: z
    .boolean()
    .describe("Whether it is on the website, rather than a draft."),
  visibility: z.enum(["PUBLIC", "MEMBER"]).describe("Who may read it."),
  publishedAt: z.iso
    .datetime()
    .nullable()
    .describe("When it was first published, or null while it never has been."),
  updatedAt: z.iso.datetime().describe("When it was last written to."),
  mailingRequested: z
    .boolean()
    .describe("Whether a mailing to the members has been asked for."),
});

/**
 * One definition, with its handler typed by its own input schema.
 *
 * The registry holds `ActionDefinition<unknown, unknown>`, whose handler takes
 * an unknown; a handler written against the schema beside it is not assignable
 * to that, and the alternative is nine handlers that each begin by parsing
 * their argument a second time. The widening is sound because dispatch
 * validates the input against this very schema before the handler is reached,
 * so the value a handler is given is the one its type describes.
 */
function newsAction<Input, Output>(
  action: ActionDefinition<Input, Output>,
): ActionDefinition {
  return action as ActionDefinition;
}

/**
 * A published item as an action answers with it: the board's own view, without
 * the two counts `publish` adds.
 *
 * Neither can be anything but null here, because no action asks for a mailing.
 * Naming them in the published document would tell a caller that mailing is
 * something these actions do, and the count of members reached is the
 * register's answer to give rather than this one's.
 */
function withoutMailingCounts(result: PublishNewsResult): NewsAdminView {
  const { mailedTo: _mailed, textedTo: _texted, ...view } = result;
  return view;
}

@Injectable()
export class NewsActionsRegistrar implements OnModuleInit {
  constructor(
    private readonly news: NewsWriteService,
    private readonly registrar: CoreActionRegistrar,
  ) {}

  onModuleInit(): void {
    this.registrar.register("news", [
      newsAction({
        ...SHARED_DECLARATION,
        name: "news_list",
        titleKey: "actions.news_list.title",
        descriptionKey: "actions.news_list.description",
        effect: "read",
        idempotent: true,
        additive: false,
        needsConfirmation: false,
        /*
         * Bounded, and onto listSummaries rather than list().
         *
         * The board's screen reads every item with every body, which is the
         * right answer for a person scrolling one page and the wrong one for a
         * caller reading into a context window. A page of summary rows makes
         * reading a body a second, deliberate call.
         */
        input: z.strictObject({
          limit: z
            .int()
            .min(1)
            .max(50)
            .default(20)
            .describe("How many items to fetch, at most fifty."),
          cursor: z
            .string()
            .min(1)
            .max(64)
            .optional()
            .describe(
              "Where to carry on from, as the previous answer's nextCursor.",
            ),
          publishedOnly: z
            .boolean()
            .optional()
            .describe(
              "Only items that are on the website. Drafts are included when " +
                "this is left out.",
            ),
        }),
        output: z.strictObject({
          news: z.array(summarySchema).describe("The items, newest first."),
          nextCursor: z
            .string()
            .nullable()
            .describe(
              "What to pass as the next cursor, or null at the end of the list.",
            ),
        }),
        handler: async (
          input,
        ): Promise<{ news: NewsSummary[]; nextCursor: string | null }> =>
          this.news.listSummaries({
            limit: input.limit,
            cursor: input.cursor,
            publishedOnly: input.publishedOnly,
          }),
      }),

      newsAction({
        ...SHARED_DECLARATION,
        name: "news_get",
        titleKey: "actions.news_get.title",
        descriptionKey: "actions.news_get.description",
        effect: "read",
        idempotent: true,
        additive: false,
        needsConfirmation: false,
        input: z.strictObject({ id: newsIdSchema }),
        output: adminViewSchema,
        handler: async (input): Promise<NewsAdminView> =>
          this.news.byId(input.id),
      }),

      newsAction({
        ...SHARED_DECLARATION,
        name: "news_create",
        titleKey: "actions.news_create.title",
        descriptionKey: "actions.news_create.description",
        effect: "write",
        idempotent: false,
        // The one additive action here: it writes a draft nobody can read yet
        // and overwrites nothing anybody has written.
        additive: true,
        needsConfirmation: false,
        input: z.strictObject({
          slug: slugSchema,
          title: titleSchema,
          blocks: blocksSchema,
        }),
        output: adminViewSchema,
        handler: async (
          input,
          context: ActionContext,
        ): Promise<NewsAdminView> =>
          this.news.create(
            {
              slug: input.slug,
              title: input.title,
              content: submittedContent({ blocks: input.blocks }),
              // Whoever is acting, and never an argument. Who wrote the
              // association's words is only knowable while they are being
              // written, and it is not a caller's to claim on somebody's
              // behalf.
              authorPersonId: context.principal.personId,
            },
            actorOf(context),
          ),
      }),

      newsAction({
        ...SHARED_DECLARATION,
        name: "news_update",
        titleKey: "actions.news_update.title",
        descriptionKey: "actions.news_update.description",
        effect: "write",
        idempotent: true,
        additive: false,
        needsConfirmation: false,
        input: z.strictObject({
          id: newsIdSchema,
          slug: slugSchema,
          title: titleSchema,
          blocks: blocksSchema,
        }),
        output: adminViewSchema,
        handler: async (
          input,
          context: ActionContext,
        ): Promise<NewsAdminView> =>
          this.news.update(
            input.id,
            {
              slug: input.slug,
              title: input.title,
              content: submittedContent({ blocks: input.blocks }),
            },
            actorOf(context),
          ),
      }),

      newsAction({
        ...SHARED_DECLARATION,
        name: "news_publish",
        titleKey: "actions.news_publish.title",
        descriptionKey: "actions.news_publish.description",
        effect: "write",
        idempotent: true,
        additive: false,
        needsConfirmation: false,
        /*
         * The audience travels with the publication, and the mailing does not.
         *
         * Publishing a news item is one decision about who it is for - that is
         * what puts the audience into the audit entry the publication leaves -
         * so the field is here, optional, and the item keeps the audience it
         * has when it is left out. `sendEmail` and `sendSms` are not here and
         * never will be: see the note at the top of this file.
         */
        input: z.strictObject({
          id: newsIdSchema,
          visibility: visibilitySchema.optional(),
        }),
        output: adminViewSchema,
        handler: async (
          input,
          context: ActionContext,
        ): Promise<NewsAdminView> =>
          withoutMailingCounts(
            await this.news.publish(
              input.id,
              { published: true, visibility: input.visibility },
              actorOf(context),
            ),
          ),
      }),

      newsAction({
        ...SHARED_DECLARATION,
        name: "news_unpublish",
        titleKey: "actions.news_unpublish.title",
        descriptionKey: "actions.news_unpublish.description",
        effect: "write",
        idempotent: true,
        additive: false,
        // Not a delete, and not confirmed as one: the item stays, as the draft
        // it was before, and can be published again.
        needsConfirmation: false,
        input: z.strictObject({ id: newsIdSchema }),
        output: adminViewSchema,
        handler: async (
          input,
          context: ActionContext,
        ): Promise<NewsAdminView> =>
          withoutMailingCounts(
            await this.news.publish(
              input.id,
              { published: false },
              actorOf(context),
            ),
          ),
      }),

      newsAction({
        ...SHARED_DECLARATION,
        name: "news_set_visibility",
        titleKey: "actions.news_set_visibility.title",
        descriptionKey: "actions.news_set_visibility.description",
        effect: "write",
        idempotent: true,
        additive: false,
        needsConfirmation: false,
        input: z.strictObject({
          id: newsIdSchema,
          visibility: visibilitySchema,
        }),
        output: adminViewSchema,
        handler: async (
          input,
          context: ActionContext,
        ): Promise<NewsAdminView> => {
          /*
           * The audience is written by `publish` and by nothing else, and that
           * method takes the publication state in the same call: there is no
           * visibility-only route, deliberately, because a second writer of
           * that column would be a second place the publication's audit entry
           * could be missed.
           *
           * So the current state is read and handed straight back, and what
           * this trades away is the moment between the two calls: a publish
           * that lands in it would be undone by this write. The alternative is
           * that second writer, which costs more than the window does.
           */
          const current = await this.news.byId(input.id);
          return withoutMailingCounts(
            await this.news.publish(
              input.id,
              { published: current.published, visibility: input.visibility },
              actorOf(context),
            ),
          );
        },
      }),

      newsAction({
        ...SHARED_DECLARATION,
        name: "news_delete",
        titleKey: "actions.news_delete.title",
        descriptionKey: "actions.news_delete.description",
        effect: "delete",
        idempotent: true,
        additive: false,
        // The registry refuses to register a delete that does not say this, and
        // the reason is the same one that makes it true here: the row goes, the
        // delivery ledger goes with it, and there is no undo.
        needsConfirmation: true,
        input: z.strictObject({ id: newsIdSchema }),
        output: z.strictObject({
          deleted: z
            .literal(true)
            .describe("That the news item no longer exists."),
        }),
        handler: async (
          input,
          context: ActionContext,
        ): Promise<{ deleted: true }> => {
          await this.news.remove(input.id, actorOf(context));
          return { deleted: true };
        },
      }),

      newsAction({
        ...SHARED_DECLARATION,
        name: "news_request_mailing",
        titleKey: "actions.news_request_mailing.title",
        descriptionKey: "actions.news_request_mailing.description",
        effect: "write",
        idempotent: true,
        additive: false,
        /*
         * No confirmation, because this asks rather than sends. What it writes
         * is a notice on the item that a board member sees and answers; the
         * send itself is confirmed by that person, on a screen, and cannot be
         * reached from here at all.
         */
        needsConfirmation: false,
        input: z.strictObject({ id: newsIdSchema }),
        output: z.strictObject({
          requestedAt: z.iso
            .datetime()
            .describe(
              "When the request was recorded. A second ask leaves the first " +
                "one standing and answers with its instant.",
            ),
        }),
        handler: async (
          input,
          context: ActionContext,
        ): Promise<{ requestedAt: string }> =>
          this.news.requestMailing(input.id, actorOf(context)),
      }),
    ]);
  }
}
