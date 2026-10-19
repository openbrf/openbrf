import type { z } from "zod";

import type { ScannableText } from "../scannable-text.ts";
import type {
  BlockCategory,
  BlockDefinition,
  BlockIcon,
  BlockSchema,
  NamespacedBlockType,
} from "./definition.ts";
import { everyStringText } from "./every-string.ts";
import { serializeUnregistered } from "./registry.ts";
import { isRecord, type Zod } from "./text-runs.ts";

/**
 * A plugin's website block, as the registry holds it.
 *
 * A plugin declares its blocks in its manifest (@openbrf/plugin-sdk), and the
 * API registers a definition for each one while the plugin is serving. The
 * definition is made here, from the declaration, so the API's write path and
 * the page editor read one account of what such a block is: its stored shape,
 * the settings the board fills in, when it is ready to send and what of it the
 * guardrails scan.
 *
 * The shapes below are the manifest's own, restated rather than imported:
 * this package does not depend on the SDK, which is published to plugin
 * authors on a schedule of its own. The API holds the two against each other
 * where it can import both.
 *
 * What the block renders is not here. A plugin's renderer is the plugin's own
 * code, run by the API while it renders the page; the editor never runs it.
 */

/** A value one setting of a plugin's block may hold. */
export type PluginBlockSettingValue = string | number | boolean;

/** The settings of one plugin block on a page, by field key. */
export type PluginBlockSettings = Readonly<
  Record<string, PluginBlockSettingValue>
>;

/**
 * One block of a plugin's, as a page stores it.
 *
 * Its settings, and nothing else: what it shows is decided when the page is
 * rendered, by the plugin.
 */
export type PluginBlock = {
  type: NamespacedBlockType;
  settings: PluginBlockSettings;
};

interface PluginBlockFieldBase {
  key: string;
  /** In the plugin's own namespace. */
  labelKey: string;
  hintKey?: string | undefined;
  required: boolean;
}

/** One setting of a plugin's block, as its manifest declares it. */
export type PluginBlockField =
  | (PluginBlockFieldBase & {
      type: "text";
      default?: string | undefined;
      minLength?: number | undefined;
      maxLength?: number | undefined;
    })
  | (PluginBlockFieldBase & {
      type: "number";
      default?: number | undefined;
      min?: number | undefined;
      max?: number | undefined;
      integer: boolean;
    })
  | (PluginBlockFieldBase & {
      type: "boolean";
      default?: boolean | undefined;
    })
  | (PluginBlockFieldBase & {
      type: "select";
      default?: string | undefined;
      options: readonly { value: string; labelKey: string }[];
    });

/**
 * A plugin's block, as the API tells the editor about it.
 *
 * The type id is already composed - `<plugin id>/<name>` - and the label is a
 * key in the plugin's own namespace, `plugin-<id>`.
 */
export interface PluginBlockDeclaration {
  type: NamespacedBlockType;
  pluginId: string;
  labelKey: string;
  icon: BlockIcon;
  category: Exclude<BlockCategory, "layout">;
  fields: readonly PluginBlockField[];
}

/** The definition of a plugin's block, as the registry takes it. */
export type PluginBlockDefinition = BlockDefinition<PluginBlock>;

/**
 * The definition a plugin's declared block is registered under.
 *
 * Its label is the plugin's key and so is the add button's: the editor
 * translates it in the plugin's namespace and composes the button's words
 * around it, because a manifest names one label and not two.
 */
export function pluginBlockDefinition(
  declaration: PluginBlockDeclaration,
): PluginBlockDefinition {
  const { type, fields } = declaration;
  return {
    type,
    schema: (zod) => pluginBlockSchema(zod, type, fields),
    read: (stored) => {
      const settings = readPluginBlockSettings(fields, stored["settings"]);
      return settings === null ? null : { type, settings };
    },
    /*
     * Every string in the settings, as words and as addresses both. The
     * renderer is the plugin's code, so nothing here knows which of them it
     * prints or links to - the same scan a block of a plugin that is not
     * installed is held to, and the same answer for the block either way.
     */
    text: (block): ScannableText => everyStringText(block),
    editor: {
      label: declaration.labelKey,
      insert: declaration.labelKey,
      icon: declaration.icon,
      category: declaration.category,
      // Columns hold the paragraph, the heading and the picture only.
      nestable: false,
      create: () => ({ type, settings: initialSettings(fields) }),
      ready: (block) =>
        readPluginBlockSettings(fields, block.settings, "stored") !== null,
    },
  };
}

/**
 * The strict shape the write path accepts.
 *
 * Strict about the block - a field beside `settings` is refused - and about
 * every value it declares. A setting it does not declare is dropped rather
 * than refused: it is one the plugin had before an upgrade took it away, and
 * refusing the page over it would leave the board unable to save a page it
 * cannot see the reason in. The plugin's own settings form drops one the same
 * way.
 *
 * Held to the size an unregistered block may have as well. A plugin can be
 * switched off, and its blocks are then read as unregistered ones: one larger
 * than that would be dropped on the next read, and deleted on the next save.
 */
function pluginBlockSchema(
  zod: Zod,
  type: NamespacedBlockType,
  fields: readonly PluginBlockField[],
): BlockSchema<PluginBlock> {
  const shape: Record<string, z.ZodType> = {};
  for (const field of fields) {
    const value = fieldSchema(zod, field);
    shape[field.key] =
      field.required && field.default === undefined ? value : value.optional();
  }
  return zod
    .strictObject({
      type: zod.literal(type),
      // Prefaulted rather than defaulted: a default is returned unparsed, so
      // a block sent with no settings at all would skip every required one.
      settings: zod.object(shape).prefault({}),
    })
    .refine((block) => serializeUnregistered(block) !== null, {
      message: "the block is larger than a page holds",
    }) as unknown as BlockSchema<PluginBlock>;
}

function fieldSchema(zod: Zod, field: PluginBlockField): z.ZodType {
  switch (field.type) {
    case "text": {
      let text = zod.string();
      if (field.minLength !== undefined) {
        text = text.min(field.minLength);
      }
      if (field.maxLength !== undefined) {
        text = text.max(field.maxLength);
      }
      // A required text left empty is not an answer the plugin can use.
      return field.required ? text.min(1) : text;
    }
    case "number": {
      let number = field.integer ? zod.int() : zod.number();
      if (field.min !== undefined) {
        number = number.min(field.min);
      }
      if (field.max !== undefined) {
        number = number.max(field.max);
      }
      return number;
    }
    case "boolean":
      return zod.boolean();
    case "select":
      return zod
        .string()
        .refine((value) =>
          field.options.some((option) => option.value === value),
        );
  }
}

/**
 * The settings of a stored block, as a plugin may be handed them.
 *
 * Total: never throws. A declared setting the block does not hold takes its
 * default; a setting it holds that the declaration no longer has is dropped;
 * and a value the declaration refuses - a select whose option an upgrade
 * removed, a required text nobody filled in - makes the whole reading null,
 * because a block rendered with a value the board did not choose would be a
 * guess published under the association's name.
 *
 * `defaults` is "stored" for the editor's question of whether the block is
 * ready to send: it is asked of what the block holds, and the defaults are
 * only a fallback a renderer gets.
 */
export function readPluginBlockSettings(
  fields: readonly PluginBlockField[],
  stored: unknown,
  defaults: "applied" | "stored" = "applied",
): PluginBlockSettings | null {
  if (stored !== undefined && !isRecord(stored)) {
    return null;
  }
  const values = isRecord(stored) ? stored : {};
  const settings: Record<string, PluginBlockSettingValue> = {};
  for (const field of fields) {
    const value = Object.hasOwn(values, field.key)
      ? values[field.key]
      : undefined;
    if (value === undefined) {
      if (field.default !== undefined) {
        if (defaults === "applied") {
          settings[field.key] = field.default;
        }
        continue;
      }
      if (field.required) {
        return null;
      }
      continue;
    }
    if (!acceptsValue(field, value)) {
      return null;
    }
    settings[field.key] = value;
  }
  return settings;
}

function acceptsValue(
  field: PluginBlockField,
  value: unknown,
): value is PluginBlockSettingValue {
  switch (field.type) {
    case "text":
      return (
        typeof value === "string" &&
        (!field.required || value.length > 0) &&
        (field.minLength === undefined || value.length >= field.minLength) &&
        (field.maxLength === undefined || value.length <= field.maxLength)
      );
    case "number":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        (!field.integer || Number.isInteger(value)) &&
        (field.min === undefined || value >= field.min) &&
        (field.max === undefined || value <= field.max)
      );
    case "boolean":
      return typeof value === "boolean";
    case "select":
      return (
        typeof value === "string" &&
        field.options.some((option) => option.value === value)
      );
  }
}

/**
 * What a block holds when the board has just added it.
 *
 * The declared defaults, and a checkbox's off where it declares none: a
 * checkbox always has a value, and one the board never touched is off. A text
 * or a choice with no default is left for the board to fill in, and the block
 * is not sent until it has been.
 */
function initialSettings(
  fields: readonly PluginBlockField[],
): PluginBlockSettings {
  const settings: Record<string, PluginBlockSettingValue> = {};
  for (const field of fields) {
    if (field.default !== undefined) {
      settings[field.key] = field.default;
    } else if (field.type === "boolean") {
      settings[field.key] = false;
    }
  }
  return settings;
}
