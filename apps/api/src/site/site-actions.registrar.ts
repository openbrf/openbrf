import { Injectable, type OnModuleInit } from "@nestjs/common";
import type { ActionContext, ActionDefinition } from "@openbrf/plugin-sdk";
import { PAGE_CONTENT_LIMITS } from "@openbrf/shared";
import { z } from "zod";

import {
  MENU_ACTION_ERRORS,
  PAGE_ACTION_ERRORS,
} from "../actions/action-errors";
import { CoreActionRegistrar } from "../actions/action-registrar";
import { actorOf } from "../actions/actor-of";
import { type MenuItemInput, MenuWriteService } from "./menu-write.service";
import { MENU_GENERATED_KEYS } from "./menu.service";
import {
  PAGE_CONTENT_VERSION,
  submittedContent,
  submittedContentSchema,
} from "./page-content";
import {
  type PageAdminView,
  type PageSummary,
  PagesWriteService,
} from "./pages-write.service";

/**
 * The association's website, as actions.
 *
 * Fifteen of them over the two things the board arranges - its pages and its
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
 *   `expectedRevision` is required on page_update and offered nowhere else,
 *   because update is the one call that claims on it. A save carries the whole
 *   page, so two callers who each read it and then wrote would leave the
 *   second one's copy standing and the first one's work gone; requiring the
 *   number a caller read means a model that means to rewrite a page has to
 *   read it first. setPublished, setVisibility and remove accept no revision
 *   at all, and publishing a precondition the service would discard is worse
 *   than not offering one.
 *
 *   Reads are bounded and answer with drafts. page_list is the summary read,
 *   never the editor's own unbounded list(), whose rows carry whole page
 *   bodies. The rows say `published`, because a caller that is a model has to
 *   be able to tell what the street can see from what only the board can.
 *
 * The bodies of the state changes follow from the same reasoning: publishing,
 * taking down, changing an audience and arranging answer with the page's facts
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
 * The page parser's own shape rule for an address, published rather than left
 * for the service to refuse: a caller building a slug has to be able to see
 * what one may look like. Which slugs are RESERVED stays where it is answered -
 * that is a question about this instance's routes, and the refusal names the
 * address.
 */
const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);

const visibilityValues = z.enum(["PUBLIC", "MEMBER"]);

/*
 * The body, as the wire carries it.
 *
 * Blocks and nothing else. A stored body is `{ version, blocks }` and every
 * read returns both, but the version is this platform's own statement about the
 * shape it stored rather than something a caller chooses - so an input takes
 * the blocks and the handler puts the version on through submittedContent,
 * which is the one place the two shapes meet.
 */
const blocksSchema = submittedContentSchema.shape.blocks;

/**
 * What a page is, apart from its body.
 *
 * The nine facts PageSummary carries, reused as the whole of a summary output
 * and as the part of a page output that is not the body, so the two can never
 * describe the same field differently.
 */
const pageFacts = {
  id: idSchema.describe("The page, as this platform named it."),
  /*
   * A plain string on the way out, where the inputs carry the shape rule. What
   * is stored was written by the version that stored it, and an address a later
   * rule would refuse must not turn reading the page into a refusal - the same
   * reason the menu's generated key is a string here and an enum on the way in.
   */
  slug: z
    .string()
    .describe(
      "The address the page is served at, as one path segment under the site root.",
    ),
  title: z.string().describe("The page heading. It is the page's only h1."),
  visibility: visibilityValues.describe(
    "Who may read the page once it is published: PUBLIC is anybody, MEMBER is a signed-in member.",
  ),
  published: z
    .boolean()
    .describe(
      "Whether the page is on the website. A page is written as a draft, and publishing it is a separate act.",
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
  content: z
    .strictObject({
      version: z
        .literal(PAGE_CONTENT_VERSION)
        .describe("Which body shape this is. The platform's, not a caller's."),
      blocks: blocksSchema.describe(
        "The body, as the renderer reads it: the blocks this version understands and nothing else.",
      ),
    })
    .describe("The body as the board's own editor has it, draft included."),
});

/**
 * An entry as the board arranges it, with the state of whatever it points at.
 *
 * `generatedKey` is a plain string here and an enum on the way in. The column
 * holds whatever the version that wrote it knew, so a row naming a destination
 * this version has retired would fail an enum on the way out and take the whole
 * menu down with it - where the renderer simply leaves that entry out. An input
 * has the opposite duty: it must not accept a key that could never resolve.
 */
const menuItemSchema = z.strictObject({
  id: idSchema.describe("The entry, as this platform named it."),
  label: z.string().describe("What the menu says. The board's own words."),
  kind: z
    .enum(["PAGE", "GENERATED", "EXTERNAL"])
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
      "The page this entry opens, for a PAGE entry, and null otherwise.",
    ),
  generatedKey: z
    .string()
    .nullable()
    .describe(
      "The generated destination, for a GENERATED entry, and null otherwise.",
    ),
  url: z
    .string()
    .nullable()
    .describe("The address, for an EXTERNAL entry, and null otherwise."),
  page: z
    .strictObject({
      slug: z.string().describe("The address the page is served at."),
      title: z.string().describe("The page heading."),
      published: z
        .boolean()
        .describe("Whether the page is on the website at all."),
      visibility: visibilityValues.describe("Who may read the page."),
    })
    .nullable()
    .describe(
      "The state of the page this entry points at. A draft and a member-only page are both good entries, and both are invisible to a visitor with no session.",
    ),
});

/**
 * What an entry may point at, as one schema per kind.
 *
 * The menu controller's body schema is strict but unauthorable: it offers three
 * target fields and says nothing about which belongs to which kind, and its
 * generated key is any string of 64 characters. Which field a kind reads lives
 * in MenuWriteService, and a caller reading a published document cannot see
 * into it - so the rule is published here as a union a caller can satisfy
 * without guessing, and the four destinations this instance actually has are
 * named.
 */
const menuEntrySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z
      .literal("PAGE")
      .describe("An entry that opens one of the association's own pages."),
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
  }),
  z.strictObject({
    kind: z
      .literal("GENERATED")
      .describe("An entry that opens a page this platform generates."),
    label: z
      .string()
      .trim()
      .min(1)
      .max(MENU_LABEL_LIMIT)
      .describe(
        "What the menu says. A generated page has no title to borrow, so the entry needs one of its own.",
      ),
    generatedKey: z
      .enum(MENU_GENERATED_KEYS)
      .describe(
        "Which generated page. Each is offered only while the feature behind it is on, so an entry may be arranged and not rendered.",
      ),
    parentId: idSchema
      .nullable()
      .optional()
      .describe(
        "The entry to hang this one under, or absent for the top level.",
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
  }),
]);

type MenuEntry = z.output<typeof menuEntrySchema>;

/** The entry as the write service takes it: one target set, the others absent. */
function menuInput(entry: MenuEntry): MenuItemInput {
  const placement = { label: entry.label, parentId: entry.parentId ?? null };
  switch (entry.kind) {
    case "PAGE":
      return { kind: "PAGE", ...placement, pageId: entry.pageId };
    case "GENERATED":
      return {
        kind: "GENERATED",
        ...placement,
        generatedKey: entry.generatedKey,
      };
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
    visibility: page.visibility,
    published: page.published,
    publishedAt: page.publishedAt,
    sortOrder: page.sortOrder,
    revision: page.revision,
    updatedAt: page.updatedAt,
  };
}

/**
 * What every action here declares the same way.
 *
 * The three text keys are derived from the name rather than written out, so
 * that a definition copied to make the next one cannot keep the previous one's
 * title - a caller would then be shown a sentence about another action, and
 * nothing would fail. The group and its own title key are tied together for the
 * same reason.
 *
 * The surfaces are the platform's screens and a connected app. Not "ai": what
 * the AI package may reach is a decision of its own and is not made by the
 * feature that owns the pages.
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
    surfaces: ["ui", "mcp"],
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

/**
 * One definition, with its schemas and its handler typed together.
 *
 * The registry takes ActionDefinition<unknown, unknown>, and a handler that
 * takes a parsed input is not assignable to one that takes unknown - a function
 * parameter is contravariant. So the widening happens here, once, behind a
 * signature that ties each handler to the schema whose value it is actually
 * handed. The alternative is a cast at fifteen call sites, which is fifteen
 * places where a handler could be bound to another action's schema and the
 * compiler would have been told not to mind.
 */
function action<Input extends z.ZodType, Output extends z.ZodType>(
  definition: Omit<ActionDefinition, "input" | "output" | "handler"> & {
    readonly input: Input;
    readonly output: Output;
    readonly handler: (
      input: z.output<Input>,
      context: ActionContext,
    ) => Promise<z.output<Output>>;
  },
): ActionDefinition {
  return definition as unknown as ActionDefinition;
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
  private pageActions(): readonly ActionDefinition[] {
    return [
      action({
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
          cursor: idSchema
            .optional()
            .describe(
              "The nextCursor from the previous call. Absent starts at the first page of the list.",
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

      action({
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

      action({
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
          slug: slugSchema.describe(
            "The address to serve the page at: lowercase letters, digits and hyphens, starting on a letter or digit.",
          ),
          title: z
            .string()
            .trim()
            .min(1)
            .max(200)
            .describe("The page heading. It becomes the page's only h1."),
          blocks: blocksSchema.describe(
            "The body. Text carries its marks as runs rather than as markup, and there is no block that can hold HTML.",
          ),
          visibility: visibilityValues.describe(
            "Who may read the page once it is published.",
          ),
        }),
        output: pageSchema,
        handler: async (input, context) =>
          this.pages.create(
            {
              slug: input.slug,
              title: input.title,
              content: submittedContent({ blocks: input.blocks }),
              visibility: input.visibility,
            },
            actorOf(context),
          ),
      }),

      action({
        ...shared("page_update", "pages"),
        effect: "write",
        idempotent: true,
        additive: false,
        needsConfirmation: false,
        personalData: ["photograph"],
        input: z.strictObject({
          id: idSchema.describe("The page to rewrite."),
          slug: slugSchema.describe(
            "The address to serve the page at. Changing it moves the page.",
          ),
          title: z
            .string()
            .trim()
            .min(1)
            .max(200)
            .describe("The page heading, as it is to read from now on."),
          blocks: blocksSchema.describe(
            "The whole body, not the part of it that changed: what is sent is what the page becomes.",
          ),
          expectedRevision: z
            .int()
            .nonnegative()
            .describe(
              "The page's revision as it was read. The write is refused if somebody else has written the page since, so read the page first.",
            ),
        }),
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
       * Publishing and taking down are two actions rather than one carrying a
       * boolean. A caller that is a model reads a name and cannot get the sense
       * of a flag backwards, and the two are not the same act: one can put a
       * photograph of a resident in front of the street and the other can only
       * take one away.
       */
      action({
        ...shared("page_publish", "pages"),
        effect: "write",
        // Publishing a published page changes nothing and records nothing.
        idempotent: true,
        additive: false,
        needsConfirmation: false,
        personalData: ["photograph"],
        input: z.strictObject({
          id: idSchema.describe("The page to put on the website."),
        }),
        output: pageSummarySchema,
        handler: async (input, context) =>
          factsOf(
            await this.pages.setPublished(
              input.id,
              { published: true },
              actorOf(context),
            ),
          ),
      }),

      action({
        ...shared("page_unpublish", "pages"),
        effect: "write",
        idempotent: true,
        additive: false,
        needsConfirmation: false,
        personalData: [],
        input: z.strictObject({
          id: idSchema.describe(
            "The page to take off the website. It is kept as a draft.",
          ),
        }),
        output: pageSummarySchema,
        handler: async (input, context) =>
          factsOf(
            await this.pages.setPublished(
              input.id,
              { published: false },
              actorOf(context),
            ),
          ),
      }),

      action({
        ...shared("page_set_visibility", "pages"),
        effect: "write",
        idempotent: true,
        additive: false,
        needsConfirmation: false,
        personalData: ["photograph"],
        input: z.strictObject({
          id: idSchema.describe("The page whose audience is to change."),
          visibility: visibilityValues.describe(
            "Who may read the page: PUBLIC is anybody, MEMBER is a signed-in member.",
          ),
        }),
        output: pageSummarySchema,
        handler: async (input, context) =>
          factsOf(
            await this.pages.setVisibility(
              input.id,
              { visibility: input.visibility },
              actorOf(context),
            ),
          ),
      }),

      action({
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

      action({
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
            "The page to remove. A published page comes off the website with it.",
          ),
        }),
        output: z.strictObject({
          deleted: z
            .literal(true)
            .describe(
              "The page is gone. A refusal is an error rather than a false here.",
            ),
        }),
        handler: async (input, context) => {
          await this.pages.remove(input.id, actorOf(context));
          return { deleted: true } as const;
        },
      }),
    ];
  }

  /** The site menu: what is offered, and in what order. */
  private menuActions(): readonly ActionDefinition[] {
    return [
      /*
       * The one list here with no bound on it. A menu is two levels of a dozen
       * entries printed on every page of the website, the rows carry no body,
       * and arranging one means holding all of it: a cursor here would be a
       * caller reordering a level it had only half read.
       */
      action({
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

      /*
       * The destinations a GENERATED entry may name.
       *
       * The same four the menu_create document carries in its GENERATED branch,
       * as a read of its own: a caller that offers the board a choice asks the
       * platform what it has rather than taking the list out of a schema it was
       * handed, and an instance that gains a generated page answers differently
       * the day it does.
       */
      action({
        ...shared("menu_generated_keys", "menu"),
        effect: "read",
        idempotent: true,
        additive: false,
        needsConfirmation: false,
        personalData: [],
        input: z.strictObject({}),
        output: z.strictObject({
          keys: z
            .array(z.enum(MENU_GENERATED_KEYS))
            .describe(
              "Every generated destination, in the order the editor offers them.",
            ),
        }),
        handler: async (_input, _context) => ({
          keys: [...MENU_GENERATED_KEYS],
        }),
      }),

      action({
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

      action({
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

      action({
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

      action({
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
