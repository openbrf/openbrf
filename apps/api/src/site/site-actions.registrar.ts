import { Injectable, type OnModuleInit } from "@nestjs/common";
import type { ActionSurface } from "@openbrf/plugin-sdk";
import { PAGE_CONTENT_LIMITS } from "@openbrf/shared";
import { z } from "zod";

import {
  MENU_ACTION_ERRORS,
  PAGE_ACTION_ERRORS,
} from "../actions/action-errors";
import { CoreActionRegistrar } from "../actions/action-registrar";
import { actorOf } from "../actions/actor-of";
import {
  type ActionTarget,
  type CoreActionDefinition,
  targetFacts,
} from "../actions/core-action";
import { typedAction } from "../actions/typed-action";
import { type MenuItemInput, MenuWriteService } from "./menu-write.service";
import {
  PAGE_CONTENT_VERSION,
  registeredBlockSchema,
  submittedContent,
  submittedContentSchema,
} from "./page-content";
import {
  type PageAdminView,
  type PageSummary,
  PageWriteError,
  PagesWriteService,
} from "./pages-write.service";

/**
 * The association's website, as actions.
 *
 * Fourteen of them over the two things the board arranges - its pages and its
 * menu - and every one bound to a method of the same write service the board's
 * own screen calls. That is the whole point of registering them rather than
 * writing a second path: a page published by a connected app is published by
 * the code that runs the publication guardrails and writes the audit entry, so
 * there is no arrangement in which the two callers get different rules. Nothing
 * here decides whether the caller may act; the registry settled that, once,
 * before the handler ran.
 *
 * What these schemas do NOT offer is as deliberate as what they do.
 *
 *   No consent attestation is an input. `photoConsentConfirmed` is the board
 *   saying the publication consents exist for the identifiable people in a
 *   picture, which is an attestation a person makes and not a field a caller
 *   fills in. An action carrying it would let a connected app - or a model
 *   holding a token - assert it on the board's behalf and publish photographs
 *   of residents who have consented to nothing. Left out, the strict input
 *   answers 400 to a caller that invents the key, and the service's
 *   photo-consent-required refusal travels back unchanged: the board member
 *   confirms it in the web interface, or the page stays a draft.
 *
 *   `expectedRevision` is required on page_update. A save carries the whole
 *   page, so two callers who each read it and then wrote would leave the
 *   second one's copy standing and the first one's work gone; requiring the
 *   number a caller read means a model that means to rewrite a page has to
 *   read it first. page_set_status, page_unpublish, page_set_front_page and
 *   page_delete offer it as optional, because the service claims on it there
 *   too: sent, the act is refused if the page has been written since it was
 *   read; left out, the act proceeds as the route always has. Each of those
 *   acts carries nothing of the page's content, so a caller that never read
 *   the body is not made to.
 *
 *   Reads are bounded and answer with drafts. page_list is the summary read,
 *   never the editor's own unbounded list(), whose rows carry whole page
 *   bodies. The rows say the page's `status`, because a caller that is a model
 *   has to be able to tell what the street can see from what only the board
 *   can.
 *
 * The bodies of the state changes follow from the same reasoning: publishing,
 * taking down, choosing the front page and arranging answer with the page's facts
 * rather than with its body. The body is what page_get is for, and a caller
 * that publishes twenty pages should not carry twenty bodies back. Create and
 * update answer with the whole page, because the body is what they wrote and
 * echoing it is how a caller checks what was stored.
 */

/** As long a menu label as the write service will keep; it refuses past it. */
const MENU_LABEL_LIMIT = 60;

/*
 * The id of a row this platform handed out. Bounded because it travels in a
 * published document a model reads: an id is a cuid, and a caller sending a
 * paragraph in its place is refused before anything reaches the database.
 */
const idSchema = z.string().min(1).max(64);

/*
 * A page_list cursor: a sort order, a colon and the id of the last page read.
 * Bounded on its own rather than as an id, because it is longer than one - a
 * sign and ten digits of sort order in front of an id of the longest length.
 */
const pageCursorSchema = z.string().min(1).max(80);

/*
 * The page parser's own shape rule for an address, published rather than left
 * for the service to refuse: a caller building a slug has to be able to see
 * what one may look like. Which slugs are RESERVED stays where it is answered -
 * that is a question about this instance's routes, and the refusal names the
 * address.
 */
const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);

const statusValues = z.enum(["DRAFT", "MEMBERS_ONLY", "PUBLIC"]);

/*
 * The body, as the wire carries it.
 *
 * Blocks and nothing else. A stored body is `{ version, blocks }` and every
 * read returns both, but the version is this platform's own statement about the
 * shape it stored rather than something a caller chooses - so an input takes
 * the blocks and the handler puts the version on through submittedContent,
 * which is the one place the two shapes meet.
 *
 * Two of them, because a read and a write are held to different things. A read
 * returns every block the page holds, a plugin's whose plugin is not installed
 * included, so the caller sees what a save would carry. A write takes the
 * registered types only, because its published document has to be strict at
 * every depth and that block's fields are the ones nobody here can declare.
 */
const blocksSchema = submittedContentSchema.shape.blocks;
const writtenBlocksSchema = z
  .array(registeredBlockSchema)
  .max(PAGE_CONTENT_LIMITS.blocks);

/**
 * What a page is, apart from its body.
 *
 * The eleven facts PageSummary carries, reused as the whole of a summary output
 * and as the part of a page output that is not the body, so the two can never
 * describe the same field differently.
 */
const pageFacts = {
  id: idSchema.describe("The page, as this platform named it."),
  /*
   * A plain string on the way out, where the inputs carry the shape rule. What
   * is stored was written by the version that stored it, and an address a later
   * rule would refuse must not turn reading the page into a refusal. A
   * built-in page's is the product's own, and the account request form's is
   * the application's, under /app.
   */
  slug: z
    .string()
    .describe(
      "The address the page is served at, under the site root: one path segment for a page the board wrote.",
    ),
  title: z.string().describe("The page heading. It is the page's only h1."),
  status: statusValues.describe(
    "Whether the page is on the website and who may read it: DRAFT is nobody but the board, MEMBERS_ONLY is anyone signed in, PUBLIC is anybody. A page is written as a draft, and publishing it is a separate act.",
  ),
  frontPage: z
    .boolean()
    .describe(
      "Whether the root of the website serves this page. At most one page is the front page, and it is always PUBLIC.",
    ),
  slugFollowsTitle: z
    .boolean()
    .describe(
      "Whether a new title still moves the address. True until the page is first published or an address is sent by hand.",
    ),
  builtIn: z
    .enum(["NEWS", "CALENDAR", "BROKER_INFORMATION", "REQUEST_ACCOUNT"])
    .nullable()
    .describe(
      "Which built-in page this is, or null for a page the board wrote. A built-in page is put in the menu like any page, and only its title can be written: its body stays empty, its address is fixed, it is always PUBLIC, never the front page and never deleted.",
    ),
  publishedAt: z
    .string()
    .nullable()
    .describe(
      "When the page was first published, as an ISO instant, or null while it never has been.",
    ),
  sortOrder: z
    .int()
    .describe("Where the page sits in the arrangement page_reorder writes."),
  revision: z
    .int()
    .describe(
      "What this copy of the page is. Send it back as expectedRevision to rewrite the page; it is not a version anybody displays.",
    ),
  updatedAt: z
    .string()
    .describe("When the page was last written, as an ISO instant."),
};

const pageSummarySchema = z.strictObject(pageFacts);

const pageSchema = z.strictObject({
  ...pageFacts,
  inMenu: z
    .boolean()
    .describe(
      "Whether the menu has an entry for this page, wherever in it. Read from the menu itself; a page's write does not change it.",
    ),
  content: z
    .strictObject({
      version: z
        .literal(PAGE_CONTENT_VERSION)
        .describe("Which body shape this is. The platform's, not a caller's."),
      blocks: blocksSchema.describe(
        "The body, as the renderer reads it: the blocks this version understands, and any block of a plugin that is not installed, kept as stored and rendered as nothing.",
      ),
    })
    .describe("The body as the board's own editor has it, draft included."),
});

/** An entry as the board arranges it, with the state of whatever it points at. */
const menuItemSchema = z.strictObject({
  id: idSchema.describe("The entry, as this platform named it."),
  label: z.string().describe("What the menu says. The board's own words."),
  kind: z
    .enum(["PAGE", "EXTERNAL"])
    .describe(
      "What the entry points at, which decides which target field is set.",
    ),
  parentId: idSchema
    .nullable()
    .describe("The entry this one hangs under, or null at the top level."),
  sortOrder: z.int().describe("Where the entry sits within its own level."),
  pageId: idSchema
    .nullable()
    .describe(
      "The page this entry opens, for a PAGE entry, and null otherwise. A built-in page is a page.",
    ),
  url: z
    .string()
    .nullable()
    .describe("The address, for an EXTERNAL entry, and null otherwise."),
  membersOnly: z
    .boolean()
    .describe(
      "Whether the entry is offered to signed-in visitors alone, whoever may open what it points at.",
    ),
  page: z
    .strictObject({
      slug: z.string().describe("The address the page is served at."),
      title: z.string().describe("The page heading."),
      status: statusValues.describe(
        "Whether the page is on the website and who may read it.",
      ),
      builtIn: pageFacts.builtIn,
    })
    .nullable()
    .describe(
      "The state of the page this entry points at. A draft and a member-only page are both good entries, and both are invisible to a visitor with no session. The account request form's entry is offered only while the association takes account requests, and only to a visitor with no session.",
    ),
});

/**
 * What an entry may point at, as one schema per kind.
 *
 * The menu controller's body schema is strict but unauthorable: it offers both
 * target fields and says nothing about which belongs to which kind. Which
 * field a kind reads lives in MenuWriteService, and a caller reading a
 * published document cannot see into it - so the rule is published here as a
 * union a caller can satisfy without guessing.
 *
 * The news index, the calendar, the broker information page and the account
 * request form are built-in pages, found with page_list and named by their
 * page id like any other. They were a kind of their own, GENERATED, before
 * they became pages; a caller still holding that schema is refused with this
 * one rather than having its entry read as something it did not mean.
 */
const menuEntrySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z
      .literal("PAGE")
      .describe(
        "An entry that opens one of the association's pages, its own or a built-in one.",
      ),
    label: z
      .string()
      .trim()
      .max(MENU_LABEL_LIMIT)
      .default("")
      .describe(
        "What the menu says. Empty borrows the page's own title, cut to fit a menu on a telephone.",
      ),
    pageId: idSchema.describe("The page the entry opens."),
    parentId: idSchema
      .nullable()
      .optional()
      .describe(
        "The entry to hang this one under, or absent for the top level. The menu has two levels and no more.",
      ),
    membersOnly: z
      .boolean()
      .optional()
      .describe(
        "Whether the entry is offered to signed-in visitors alone, whoever may open what it points at. It narrows and never widens: an entry for a draft or a member-only page is never shown to a visitor with no session. Absent, a new entry is for whoever may open its target and a changed one keeps what it had.",
      ),
  }),
  z.strictObject({
    kind: z
      .literal("EXTERNAL")
      .describe("An entry that leads somewhere outside this instance."),
    label: z
      .string()
      .trim()
      .min(1)
      .max(MENU_LABEL_LIMIT)
      .describe(
        "What the menu says. An address has no title to borrow, so the entry needs one of its own.",
      ),
    url: z
      .string()
      .regex(/^https:\/\//)
      .max(PAGE_CONTENT_LIMITS.link)
      .describe(
        "Where it leads. https only: this is a standing invitation printed on every page of the website, and http would hand the reader's traffic to whoever is between them.",
      ),
    parentId: idSchema
      .nullable()
      .optional()
      .describe(
        "The entry to hang this one under, or absent for the top level.",
      ),
    membersOnly: z
      .boolean()
      .optional()
      .describe(
        "Whether the entry is offered to signed-in visitors alone, whoever may open what it points at. It narrows and never widens: an entry for a draft or a member-only page is never shown to a visitor with no session. Absent, a new entry is for whoever may open its target and a changed one keeps what it had.",
      ),
  }),
]);

type MenuEntry = z.output<typeof menuEntrySchema>;

/** The entry as the write service takes it: one target set, the others absent. */
function menuInput(entry: MenuEntry): MenuItemInput {
  const placement = {
    label: entry.label,
    parentId: entry.parentId ?? null,
    membersOnly: entry.membersOnly,
  };
  switch (entry.kind) {
    case "PAGE":
      return { kind: "PAGE", ...placement, pageId: entry.pageId };
    case "EXTERNAL":
      return { kind: "EXTERNAL", ...placement, url: entry.url };
  }
}

/** A written page, narrowed to the facts about it. */
function factsOf(page: PageAdminView): PageSummary {
  return {
    id: page.id,
    slug: page.slug,
    title: page.title,
    status: page.status,
    frontPage: page.frontPage,
    slugFollowsTitle: page.slugFollowsTitle,
    builtIn: page.builtIn,
    publishedAt: page.publishedAt,
    sortOrder: page.sortOrder,
    revision: page.revision,
    updatedAt: page.updatedAt,
  };
}

/** What the preview of a held call says about a page. */
type PageFact = "title" | "slug" | "status" | "frontPage";

/**
 * The page a held call names, for its preview (`CoreActionDefinition`): its
 * title, address and who reads it as they stand, and what the call sets,
 * worked out from the page as it was read. Whether it is the front page is a
 * fact only of the call that makes it one.
 */
function pageTarget<Input extends { id: string }>(
  pages: PagesWriteService,
  sets: (
    input: Input,
    page: PageAdminView,
  ) =>
    | Partial<Record<PageFact, string | boolean>>
    | Promise<Partial<Record<PageFact, string | boolean>>>,
): ActionTarget<Input> {
  return {
    kind: "page",
    id: (input) => input.id,
    read: async (input) => {
      const page = await pages.byId(input.id).catch(nullWhenGone);
      if (page === null) {
        return null;
      }
      const after = await sets(input, page);
      return targetFacts(
        {
          title: page.title,
          slug: page.slug,
          status: page.status,
          ...("frontPage" in after ? { frontPage: page.frontPage } : {}),
        },
        after,
      );
    },
  };
}

function nullWhenGone(cause: unknown): null {
  if (cause instanceof PageWriteError && cause.reason === "not-found") {
    return null;
  }
  throw cause;
}

/**
 * The page actions the AI package's site and news assistant is offered (ADR
 * 0038, "News and pages on `ai`"): reading the pages, writing one, and deciding
 * who reads it. Every write it makes there is held as a pending change for the
 * person who asked to confirm (ADR 0039).
 *
 * The rest stay off "ai". `page_delete` has no undo. `page_set_front_page`,
 * `page_reorder` and the menu shape the whole website rather than what one
 * page says, which is the board's decision on its own screen and not an edit
 * from a prompt.
 */
const ON_AI: ReadonlySet<string> = new Set([
  "page_list",
  "page_get",
  "page_create",
  "page_update",
  "page_set_status",
  "page_unpublish",
]);

/**
 * What every action here declares the same way.
 *
 * The three text keys are derived from the name rather than written out, so
 * that a definition copied to make the next one cannot keep the previous one's
 * title - a caller would then be shown a sentence about another action, and
 * nothing would fail. The group and its own title key are tied together for the
 * same reason.
 *
 * The surfaces are the platform's screens and a connected app, and "ai" for
 * the actions in `ON_AI` below.
 */
function shared(name: string, group: "pages" | "menu") {
  return {
    name,
    titleKey: `actions.${name}.title`,
    descriptionKey: `actions.${name}.description`,
    group,
    groupTitleKey: `actions.group.${group}.title`,
    capability: "site:manage",
    openWorld: false,
    surfaces: (ON_AI.has(name)
      ? ["ui", "mcp", "ai"]
      : ["ui", "mcp"]) satisfies readonly ActionSurface[],
    /*
     * Every refusal the bound service can raise, with a verdict on each.
     *
     * The registry lets a domain refusal travel untouched, so a caller gets
     * the reason and the status either way; what it would not get is whether
     * trying again could ever work. A model told only "page-changed" cannot
     * tell that re-reading and reapplying is the answer, and one told
     * "photo-consent-required" cannot tell that nothing it sends will help.
     * The spec beside the list asserts it covers the service's whole union.
     */
    errors: group === "menu" ? MENU_ACTION_ERRORS : PAGE_ACTION_ERRORS,
  } as const;
}

@Injectable()
export class SiteActionsRegistrar implements OnModuleInit {
  constructor(
    private readonly pages: PagesWriteService,
    private readonly menu: MenuWriteService,
    private readonly registrar: CoreActionRegistrar,
  ) {}

  onModuleInit(): void {
    this.registrar.register("site", [
      ...this.pageActions(),
      ...this.menuActions(),
    ]);
  }

  /** The board's pages: reading them, writing them, and deciding who reads them. */
  private pageActions(): readonly CoreActionDefinition[] {
    return [
      typedAction({
        ...shared("page_list", "pages"),
        effect: "read",
        idempotent: true,
        additive: false,
        needsConfirmation: false,
        personalData: [],
        input: z.strictObject({
          limit: z
            .int()
            .min(1)
            .max(50)
            .default(20)
            .describe("How many pages to return at once."),
          cursor: pageCursorSchema
            .optional()
            .describe(
              "The nextCursor from the previous call. Absent starts at the first page of the list. A cursor from an earlier release of OpenBRF answers not-found; start the list again without one.",
            ),
          publishedOnly: z
            .boolean()
            .optional()
            .describe(
              "Narrows the list to the pages that are on the website. Absent lists drafts as well.",
            ),
        }),
        output: z.strictObject({
          pages: z
            .array(pageSummarySchema)
            .describe(
              "The pages, in the order the board arranged them, without their bodies.",
            ),
          nextCursor: z
            .string()
            .nullable()
            .describe(
              "Send this back as cursor to read the next lot, or null at the end of the list.",
            ),
        }),
        handler: async (input, _context) =>
          this.pages.listSummaries({
            limit: input.limit,
            cursor: input.cursor,
            publishedOnly: input.publishedOnly,
          }),
      }),

      typedAction({
        ...shared("page_get", "pages"),
        effect: "read",
        idempotent: true,
        additive: false,
        needsConfirmation: false,
        // A body may carry a picture, and a picture of the association's own
        // residents is the personal data a page can hold.
        personalData: ["photograph"],
        input: z.strictObject({
          id: idSchema.describe("The page to read, as page_list gives its id."),
        }),
        output: pageSchema,
        handler: async (input, _context) => this.pages.byId(input.id),
      }),

      typedAction({
        ...shared("page_create", "pages"),
        effect: "write",
        // Two calls with the same body are two pages, and the second is refused
        // only because the address is taken.
        idempotent: false,
        // A new page overwrites nothing anybody wrote.
        additive: true,
        needsConfirmation: false,
        personalData: ["photograph"],
        input: z.strictObject({
          slug: slugSchema
            .optional()
            .describe(
              "The address to serve the page at: lowercase letters, digits and hyphens, starting on a letter or digit. Absent, the address is made from the title and numbered when it is taken, and it moves with the title until the page is first published.",
            ),
          title: z
            .string()
            .trim()
            .min(1)
            .max(200)
            .describe("The page heading. It becomes the page's only h1."),
          blocks: writtenBlocksSchema.describe(
            "The body. Text carries its marks as runs rather than as markup, and there is no block that can hold HTML.",
          ),
          /*
           * The one field this action had that the page no longer does, kept
           * so the name keeps its shape: an MCP client holding the tool list
           * from before status replaced visibility still sends it, and this
           * strict schema would otherwise refuse every page it creates. It is
           * accepted and ignored rather than stored, because a new page is a
           * draft that nobody but the board reads either way, and who may read
           * it is decided when its status is set - by page_set_status, whose
           * aliases refuse the old publish input rather than guess an audience
           * from it.
           */
          visibility: z
            .enum(["PUBLIC", "MEMBER"])
            .optional()
            .describe(
              "Deprecated and ignored. A new page is always a draft; choose who may read it with page_set_status when it is ready.",
            ),
        }),
        output: pageSchema,
        handler: async (input, context) =>
          this.pages.create(
            {
              slug: input.slug,
              title: input.title,
              content: submittedContent({ blocks: input.blocks }),
            },
            actorOf(context),
          ),
      }),

      typedAction({
        ...shared("page_update", "pages"),
        effect: "write",
        idempotent: true,
        additive: false,
        needsConfirmation: false,
        personalData: ["photograph"],
        input: z.strictObject({
          id: idSchema.describe("The page to rewrite."),
          slug: slugSchema
            .optional()
            .describe(
              "An address to serve the page at from now on, which it then keeps whatever its title. Absent keeps the address - or, while the page still follows its title, moves it to the one the new title gives.",
            ),
          title: z
            .string()
            .trim()
            .min(1)
            .max(200)
            .describe("The page heading, as it is to read from now on."),
          blocks: writtenBlocksSchema.describe(
            "The whole body, not the part of it that changed: what is sent is what the page becomes. A block of a plugin that is not installed cannot be sent back, so a page holding one is refused until it is removed or the plugin is installed again.",
          ),
          expectedRevision: z
            .int()
            .nonnegative()
            .describe(
              "The page's revision as it was read. The write is refused if somebody else has written the page since, so read the page first.",
            ),
        }),
        /*
         * The address the save would write rather than the one sent: a page
         * still following its title moves to the address a new title gives
         * when none is sent, and the person confirming is to see that.
         */
        target: pageTarget(
          this.pages,
          async (
            input: { id: string; title: string; slug?: string },
            page,
          ) => ({
            title: input.title,
            slug: await this.pages.slugAfterUpdate(page, input),
          }),
        ),
        output: pageSchema,
        handler: async (input, context) =>
          this.pages.update(
            input.id,
            {
              slug: input.slug,
              title: input.title,
              content: submittedContent({ blocks: input.blocks }),
              expectedRevision: input.expectedRevision,
            },
            actorOf(context),
          ),
      }),

      /*
       * One status of three, named rather than a flag, so a caller that is a
       * model reads which way the act goes and cannot get its sense backwards.
       *
       * It replaced page_publish and page_set_visibility, which each set half
       * of what is now one choice. Their names are carried onto it rather than
       * reused for a new shape: an MCP client holding last week's tool list
       * calls the old name with the old input, and is refused by this strict
       * schema with what it should have sent rather than having the call read
       * as something it did not mean. page_unpublish keeps its own name and
       * shape, because what it does has not changed.
       */
      typedAction({
        ...shared("page_set_status", "pages"),
        deprecatedAliases: ["page_publish", "page_set_visibility"],
        effect: "write",
        // Giving a page the status it has changes nothing and records nothing.
        idempotent: true,
        additive: false,
        needsConfirmation: false,
        personalData: ["photograph"],
        input: z.strictObject({
          id: idSchema.describe("The page whose status is to change."),
          status: statusValues.describe(
            "DRAFT takes the page off the website, MEMBERS_ONLY publishes it to anyone signed in, PUBLIC publishes it to anybody. The front page stays PUBLIC.",
          ),
          expectedRevision: z
            .int()
            .nonnegative()
            .optional()
            .describe(
              "The page's revision as it was read. Sent, the act is refused if somebody else has written the page since; left out, it proceeds as it always has.",
            ),
        }),
        output: pageSummarySchema,
        target: pageTarget(
          this.pages,
          (input: { id: string; status: PageAdminView["status"] }) => ({
            status: input.status,
          }),
        ),
        handler: async (input, context) =>
          factsOf(
            await this.pages.setStatus(
              input.id,
              {
                status: input.status,
                expectedRevision: input.expectedRevision,
              },
              actorOf(context),
            ),
          ),
      }),

      typedAction({
        ...shared("page_unpublish", "pages"),
        effect: "write",
        idempotent: true,
        additive: false,
        needsConfirmation: false,
        personalData: [],
        input: z.strictObject({
          id: idSchema.describe(
            "The page to take off the website. It is kept as a draft. The front page cannot be taken off until another page is chosen as the front page.",
          ),
          expectedRevision: z
            .int()
            .nonnegative()
            .optional()
            .describe(
              "The page's revision as it was read. Sent, the act is refused if somebody else has written the page since; left out, it proceeds as it always has.",
            ),
        }),
        output: pageSummarySchema,
        target: pageTarget(this.pages, () => ({ status: "DRAFT" })),
        handler: async (input, context) =>
          factsOf(
            await this.pages.setStatus(
              input.id,
              { status: "DRAFT", expectedRevision: input.expectedRevision },
              actorOf(context),
            ),
          ),
      }),

      typedAction({
        ...shared("page_set_front_page", "pages"),
        effect: "write",
        // Choosing the front page again changes nothing and records nothing.
        idempotent: true,
        additive: false,
        needsConfirmation: false,
        personalData: [],
        input: z.strictObject({
          id: idSchema.describe(
            "The page the root of the website is to serve. It has to be PUBLIC; the page that was the front page stops being it.",
          ),
          expectedRevision: z
            .int()
            .nonnegative()
            .optional()
            .describe(
              "The page's revision as it was read. Sent, the act is refused if somebody else has written the page since; left out, it proceeds as it always has.",
            ),
        }),
        output: pageSummarySchema,
        target: pageTarget(this.pages, () => ({ frontPage: true })),
        handler: async (input, context) =>
          factsOf(
            await this.pages.setFrontPage(
              input.id,
              { expectedRevision: input.expectedRevision },
              actorOf(context),
            ),
          ),
      }),

      typedAction({
        ...shared("page_reorder", "pages"),
        effect: "write",
        idempotent: true,
        additive: false,
        needsConfirmation: false,
        personalData: [],
        input: z.strictObject({
          ids: z
            .array(idSchema)
            .min(1)
            .max(500)
            .describe(
              "The pages in the order they are to sit in. Ids this instance does not have are ignored, so a stale row cannot lose the whole arrangement.",
            ),
        }),
        output: z.strictObject({
          pages: z
            .array(pageSummarySchema)
            .describe("Every page, in the order it now sits in."),
        }),
        /*
         * The service answers with every page including its body, which is the
         * payload page_list exists to bound. What this call changed is the
         * arrangement, so the arrangement is what it answers with.
         */
        handler: async (input, context) => ({
          pages: (await this.pages.reorder(input.ids, actorOf(context))).map(
            (page) => factsOf(page),
          ),
        }),
      }),

      typedAction({
        ...shared("page_delete", "pages"),
        effect: "delete",
        idempotent: true,
        additive: false,
        // A delete has no undo, and the registry refuses to register one that
        // says otherwise.
        needsConfirmation: true,
        personalData: [],
        input: z.strictObject({
          id: idSchema.describe(
            "The page to remove. A published page comes off the website with it. The front page cannot be removed until another page is chosen as the front page.",
          ),
          expectedRevision: z
            .int()
            .nonnegative()
            .optional()
            .describe(
              "The page's revision as it was read. Sent, the act is refused if somebody else has written the page since; left out, it proceeds as it always has.",
            ),
        }),
        output: z.strictObject({
          deleted: z
            .literal(true)
            .describe(
              "The page is gone. A refusal is an error rather than a false here.",
            ),
        }),
        target: pageTarget(this.pages, () => ({})),
        handler: async (input, context) => {
          await this.pages.remove(
            input.id,
            input.expectedRevision === undefined
              ? {}
              : { expectedRevision: input.expectedRevision },
            actorOf(context),
          );
          return { deleted: true } as const;
        },
      }),
    ];
  }

  /** The site menu: what is offered, and in what order. */
  private menuActions(): readonly CoreActionDefinition[] {
    return [
      /*
       * The one list here with no bound on it. A menu is two levels of a dozen
       * entries printed on every page of the website, the rows carry no body,
       * and arranging one means holding all of it: a cursor here would be a
       * caller reordering a level it had only half read.
       */
      typedAction({
        ...shared("menu_list", "menu"),
        effect: "read",
        idempotent: true,
        additive: false,
        needsConfirmation: false,
        personalData: [],
        input: z.strictObject({}),
        output: z.strictObject({
          items: z
            .array(menuItemSchema)
            .describe(
              "Every entry, both levels, flat: each row names its parent, and a row with no parent is a top-level entry.",
            ),
        }),
        handler: async (_input, _context) => ({
          items: await this.menu.list(),
        }),
      }),

      typedAction({
        ...shared("menu_create", "menu"),
        effect: "write",
        idempotent: false,
        // A new entry at the end of its level overwrites nothing.
        additive: true,
        needsConfirmation: false,
        personalData: [],
        input: z.strictObject({
          /*
           * Nested under a key rather than being the whole input: the published
           * input document has to be an object at its root, and a union is not
           * one.
           */
          entry: menuEntrySchema.describe(
            "The entry to add, at the end of its level.",
          ),
        }),
        output: menuItemSchema,
        handler: async (input, context) =>
          this.menu.create(menuInput(input.entry), actorOf(context)),
      }),

      typedAction({
        ...shared("menu_update", "menu"),
        effect: "write",
        idempotent: true,
        additive: false,
        needsConfirmation: false,
        personalData: [],
        input: z.strictObject({
          id: idSchema.describe("The entry to rewrite."),
          entry: menuEntrySchema.describe(
            "The whole entry, not the part of it that changed: what it says, what it points at, and where it hangs. An entry sent without a parent is an entry at the top level.",
          ),
        }),
        output: menuItemSchema,
        handler: async (input, context) =>
          this.menu.update(input.id, menuInput(input.entry), actorOf(context)),
      }),

      typedAction({
        ...shared("menu_reorder", "menu"),
        effect: "write",
        idempotent: true,
        additive: false,
        needsConfirmation: false,
        personalData: [],
        input: z.strictObject({
          parentId: idSchema
            .nullable()
            .default(null)
            .describe(
              "The level to arrange: null is the top level, and an id is what hangs under that entry.",
            ),
          ids: z
            .array(idSchema)
            .min(1)
            .max(200)
            .describe(
              "The entries in the order they are to sit in. Ids outside that level are ignored, so arranging a dropdown can never take an entry out of it.",
            ),
        }),
        output: z.strictObject({
          items: z
            .array(menuItemSchema)
            .describe("Every entry, in the order it now sits in."),
        }),
        handler: async (input, context) => ({
          items: await this.menu.reorder(
            input.parentId,
            input.ids,
            actorOf(context),
          ),
        }),
      }),

      typedAction({
        ...shared("menu_remove", "menu"),
        effect: "delete",
        idempotent: true,
        additive: false,
        needsConfirmation: true,
        personalData: [],
        input: z.strictObject({
          id: idSchema.describe(
            "The entry to remove. Whatever hangs under it goes with it, because a dropdown is the entry it hangs from.",
          ),
        }),
        output: z.strictObject({
          deleted: z
            .literal(true)
            .describe(
              "The entry is gone. A refusal is an error rather than a false here.",
            ),
        }),
        handler: async (input, context) => {
          await this.menu.remove(input.id, actorOf(context));
          return { deleted: true } as const;
        },
      }),
    ];
  }
}
