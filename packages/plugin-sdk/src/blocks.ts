import { z } from "zod";

import type { PluginSettingsValues } from "./settings-schema.ts";
import { pluginSettingsSchema } from "./settings-schema.ts";

/**
 * Blocks a plugin adds to the association's website.
 *
 * A page on the website is a list of blocks, never markup (ADR 0006), and a
 * plugin's block is one more type in that list. The manifest declares it - its
 * name, how the page editor offers it and the settings the board fills in - and
 * the server bundle registers the function that renders it. The host does the
 * rest: it offers the block in the editor, validates the settings on every
 * save, calls the render function while it renders the page, and decides what
 * of the answer reaches the visitor's browser.
 *
 * What the render function returns is a small tree of elements rather than a
 * string of HTML. The host reads it against a short list of elements and
 * attributes and prints what passes through the same renderer as the rest of
 * the page, so a script, a stylesheet, an event handler or a picture from
 * another host has no way into the markup however the tree was built. The
 * website's content security policy refuses all four as well; the list is what
 * keeps the page from carrying them at all.
 */

/**
 * The name of one block, unique within its plugin.
 *
 * The block's type id is composed by the host as `<plugin id>/<name>`, which is
 * what a page stores, so two plugins cannot claim one type and no plugin can
 * claim one of the core's. The name has a core block's own shape: a
 * lowerCamelCase word of at most 32 characters.
 */
export const PLUGIN_BLOCK_NAME_PATTERN = /^[a-z][a-zA-Z0-9]{0,31}$/;

/** The type id a page stores a plugin's block under. */
export function pluginBlockType(pluginId: string, name: string): string {
  return `${pluginId}/${name}`;
}

/**
 * The pictures the page editor can show beside a plugin's block.
 *
 * A name rather than an image, as for the core's blocks: the editor draws each
 * one in the theme's own colours, and a manifest carries no markup. `plugin` is
 * the one to choose when none of the others says what the block is.
 */
export const PLUGIN_BLOCK_ICONS = [
  "plugin",
  "paragraph",
  "heading",
  "image",
  "form",
  "news",
  "calendar",
  "documents",
  "people",
  "facts",
  "contact",
  "questions",
] as const;
export type PluginBlockIcon = (typeof PLUGIN_BLOCK_ICONS)[number];

/**
 * Where the page editor files a plugin's block.
 *
 * The core's categories, less `layout`: a layout block arranges other blocks,
 * and a plugin's block holds none.
 */
export const PLUGIN_BLOCK_CATEGORIES = [
  "text",
  "media",
  "association",
] as const;
export type PluginBlockCategory = (typeof PLUGIN_BLOCK_CATEGORIES)[number];

/**
 * One block a plugin declares, as the manifest carries it.
 *
 * `labelKey` is an i18n key in the plugin's own namespace, like every other
 * label a manifest names. The settings are the same declaration the plugin's
 * own settings form is made of, and the page editor renders them as a form on
 * the block: one set of values per block on a page, validated by the host on
 * every save.
 */
export const pluginBlockSchema = z.strictObject({
  name: z
    .string()
    .regex(
      PLUGIN_BLOCK_NAME_PATTERN,
      "must be a lowerCamelCase word of at most 32 characters",
    ),
  labelKey: z.string().min(1).max(200),
  icon: z.enum(PLUGIN_BLOCK_ICONS).default("plugin"),
  category: z.enum(PLUGIN_BLOCK_CATEGORIES).default("association"),
  settingsSchema: pluginSettingsSchema.default({ fields: [] }),
});

export type PluginBlockDeclaration = z.infer<typeof pluginBlockSchema>;

/**
 * The blocks a manifest declares. At most sixteen, each name once.
 *
 * A name appearing twice would be one type id with two renderers, and a page
 * that holds it would render with whichever registered last.
 */
export const pluginBlocksSchema = z
  .array(pluginBlockSchema)
  .max(16)
  .superRefine((blocks, ctx) => {
    const seen = new Set<string>();
    for (const [index, block] of blocks.entries()) {
      if (seen.has(block.name)) {
        ctx.addIssue({
          code: "custom",
          path: [index, "name"],
          message: `two blocks are declared with the name "${block.name}"`,
        });
      }
      seen.add(block.name);
    }
  });

/**
 * The elements a rendered block may contain.
 *
 * Text and its structure, and nothing that loads, runs or styles anything. An
 * element outside this list is left out together with everything inside it,
 * because what an unknown element holds is not text the plugin meant a reader
 * to see: the body of a script, a stylesheet, a template.
 *
 * Headings start at the second level, as a page's own blocks do: the page's
 * title is its first-level heading.
 */
export const PLUGIN_BLOCK_ELEMENTS = [
  "p",
  "h2",
  "h3",
  "h4",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "strong",
  "em",
  "small",
  "code",
  "blockquote",
  "a",
  "br",
  "span",
  "div",
  "section",
  "table",
  "caption",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "time",
] as const;
export type PluginBlockElementName = (typeof PLUGIN_BLOCK_ELEMENTS)[number];

/**
 * The attributes an element may carry, by element. Every other one is left out.
 *
 *   href      on `a`: http, https, mailto or a path on this instance. Any other
 *             address - `javascript:` above all - leaves the link out and keeps
 *             its text. A link to another host is given noopener and
 *             noreferrer by the host.
 *   dateTime  on `time`: the machine-readable date beside the one shown.
 *   scope     on `th`: `row`, `col`, `rowgroup` or `colgroup`.
 *
 * No `class`, no `style` and no `id`: the theme decides how the website looks,
 * and the host wraps every plugin's block in one element the theme can style.
 */
export const PLUGIN_BLOCK_ATTRIBUTES: Readonly<
  Partial<Record<PluginBlockElementName, readonly string[]>>
> = {
  a: ["href"],
  time: ["dateTime"],
  th: ["scope"],
};

/** One element of a rendered block. */
export interface PluginBlockElement {
  readonly tag: PluginBlockElementName;
  readonly attributes?: Readonly<Record<string, string>>;
  readonly children?: readonly PluginBlockNode[];
}

/**
 * A piece of a rendered block: text, or an element.
 *
 * Text is text. It is escaped as it is printed, so `"<b>"` reads as the three
 * characters and is never an element.
 */
export type PluginBlockNode = string | PluginBlockElement;

/** What a render function answers with. Null, or nothing, renders nothing. */
export type PluginBlockContent =
  PluginBlockNode | readonly PluginBlockNode[] | null | undefined;

/**
 * What a block's render function is told.
 *
 * The block's own settings, already validated against its declaration with
 * the declared defaults applied, and the reader's language with a translation
 * function in the plugin's own namespace. Nothing about the reader: the same
 * page is rendered for a visitor with no account and for a member, and what a
 * block may say must not depend on who is reading it.
 */
export interface PluginBlockRenderContext {
  /** The block's type id, `<plugin id>/<name>`. */
  readonly type: string;
  readonly settings: PluginSettingsValues;
  /** The language the page is being rendered in: `sv` or `en`. */
  readonly locale: string;
  /** Translates a key from the plugin's own locale files. */
  readonly t: (
    key: string,
    values?: Readonly<Record<string, string | number>>,
  ) => string;
  /**
   * Aborted when the host stops waiting for this block.
   *
   * A render that has not answered within PLUGIN_BLOCK_RENDER_TIMEOUT_MS is
   * left off the page, and the page is sent without it. The host cannot stop
   * the plugin's code, so a render doing slow work of its own should hand this
   * on to whatever it is waiting for.
   */
  readonly signal: PluginBlockAbortSignal;
}

/**
 * The part of an `AbortSignal` a render function is given.
 *
 * Stated rather than taken from a platform's types, because this package
 * compiles against the language alone. The host hands a real `AbortSignal`, so
 * it can be passed on to `fetch` and to anything else that takes one.
 */
export interface PluginBlockAbortSignal {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

/**
 * How long the host waits for one block to render, in milliseconds.
 *
 * Every block on a page renders at the same time, so this is also about the
 * longest a plugin can add to a page's answer. A website's front page has to
 * answer quickly for a visitor with no account, and a block that cannot is
 * left off rather than waited for.
 */
export const PLUGIN_BLOCK_RENDER_TIMEOUT_MS = 2000;

/** What a plugin hands the host for one block its manifest declared. */
export interface PluginBlockRegistration {
  /** The block's name as the manifest declares it, not its type id. */
  readonly name: string;
  readonly render: (
    context: PluginBlockRenderContext,
  ) => PluginBlockContent | Promise<PluginBlockContent>;
}

export interface PluginBlocks {
  /**
   * Registers the render function of a block the manifest declared.
   *
   * Callable from the module factory onwards, as `host.actions.register` is: a
   * call made before the application exists is kept until it does. A name the
   * manifest does not declare stops the plugin serving and is reported as
   * `block-refused`. A declared block with no render function registered is
   * not offered in the page editor, and a page that already holds one shows
   * nothing in its place.
   */
  register: (registration: PluginBlockRegistration) => void;
}
