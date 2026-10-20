import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { PAGE_CONTENT_LIMITS } from "../page-content-limits.ts";
import {
  type PluginBlockDeclaration,
  pluginBlockDefinition,
  readPluginBlockSettings,
} from "./plugin-blocks.ts";
import { CORE_BLOCKS, createBlockRegistry, PAGE_BLOCKS } from "./registry.ts";

/**
 * A plugin's block is registered from its declaration, so these hold the
 * definition made from one to the promises every other block keeps: the write
 * path refuses what the plugin would not accept, the reading never throws, and
 * the guardrails scan everything the plugin could print.
 */

const DECLARATION: PluginBlockDeclaration = {
  type: "laundry/schedule",
  pluginId: "laundry",
  labelKey: "blocks.schedule.label",
  icon: "calendar",
  category: "association",
  fields: [
    {
      key: "heading",
      labelKey: "blocks.schedule.heading",
      type: "text",
      required: true,
      maxLength: 80,
    },
    {
      key: "days",
      labelKey: "blocks.schedule.days",
      type: "number",
      required: false,
      integer: true,
      min: 1,
      max: 14,
      default: 7,
    },
    {
      key: "showFree",
      labelKey: "blocks.schedule.showFree",
      type: "boolean",
      required: false,
    },
    {
      key: "room",
      labelKey: "blocks.schedule.room",
      type: "select",
      required: false,
      options: [
        { value: "north", labelKey: "blocks.schedule.north" },
        { value: "south", labelKey: "blocks.schedule.south" },
      ],
    },
  ],
};

const definition = pluginBlockDefinition(DECLARATION);
const registry = createBlockRegistry([...CORE_BLOCKS, definition]);
const schema = registry.schema(z);

const SCHEDULE = {
  type: "laundry/schedule",
  settings: { heading: "Tvättstugan", days: 3, showFree: true, room: "north" },
} as const;

describe("a plugin's block, on the write path", () => {
  it("accepts the settings its declaration accepts", () => {
    expect(schema.parse(SCHEDULE)).toEqual(SCHEDULE);
  });

  it.each([
    ["a required text left empty", { heading: "" }],
    ["a text over its length", { heading: "x".repeat(81) }],
    ["a number outside its bounds", { heading: "Tvätt", days: 15 }],
    ["a choice it does not offer", { heading: "Tvätt", room: "attic" }],
  ])("refuses %s, at the setting", (_what, settings) => {
    const result = schema.safeParse({ type: "laundry/schedule", settings });

    expect(result.success).toBe(false);
    expect(
      result.error?.issues.some((issue) => issue.path[0] === "settings"),
    ).toBe(true);
  });

  /*
   * A value of the wrong kind aborts both halves of the block union, so it is
   * refused at the block, as a core block wrong at its root is (ADR 0006): the
   * refusal still names the block, which is what the editor points the board
   * at.
   */
  it.each([
    ["a required text left out", { days: 3 }],
    [
      "a fraction where an integer is declared",
      { heading: "Tvätt", days: 2.5 },
    ],
    ["a value of the wrong kind", { heading: "Tvätt", showFree: "yes" }],
  ])("refuses %s, at the block", (_what, settings) => {
    const result = schema.safeParse({ type: "laundry/schedule", settings });

    expect(result.success).toBe(false);
  });

  it("refuses a block with no settings at all when one is required", () => {
    expect(schema.safeParse({ type: "laundry/schedule" }).success).toBe(false);
  });

  it("refuses a field beside its settings", () => {
    const result = schema.safeParse({ ...SCHEDULE, script: "alert(1)" });

    expect(result.success).toBe(false);
  });

  it("drops a setting its declaration no longer has", () => {
    expect(
      schema.parse({
        type: "laundry/schedule",
        settings: { heading: "Tvätt", colour: "red" },
      }),
    ).toEqual({ type: "laundry/schedule", settings: { heading: "Tvätt" } });
  });

  it("refuses a block larger than an unregistered one may be", () => {
    // Read back as an unregistered block while the plugin is switched off,
    // so it must fit in one, or switching the plugin off would lose it.
    const wide = pluginBlockDefinition({
      ...DECLARATION,
      fields: [
        {
          key: "heading",
          labelKey: "blocks.schedule.heading",
          type: "text",
          required: true,
        },
      ],
    });
    const result = createBlockRegistry([...CORE_BLOCKS, wide])
      .schema(z)
      .safeParse({
        type: "laundry/schedule",
        settings: {
          heading: "x".repeat(PAGE_CONTENT_LIMITS.unregisteredBlock),
        },
      });

    expect(result.success).toBe(false);
  });

  it("is held to its settings only while it is registered", () => {
    // The core's registry alone keeps it as a plugin's block nobody has
    // registered, as it would while its plugin is switched off.
    expect(
      PAGE_BLOCKS.schema(z).safeParse({
        type: "laundry/schedule",
        settings: { days: 99 },
      }).success,
    ).toBe(true);
  });
});

describe("reading a plugin's block", () => {
  it("applies the declared defaults and drops what is not declared", () => {
    expect(
      readPluginBlockSettings(DECLARATION.fields, {
        heading: "Tvätt",
        colour: "red",
      }),
    ).toEqual({ heading: "Tvätt", days: 7 });
  });

  it.each([
    ["a list", []],
    ["a string", "settings"],
    ["a value the declaration refuses", { heading: "Tvätt", room: "attic" }],
    ["no answer to a required setting", {}],
  ])("reads %s as nothing, without throwing", (_what, stored) => {
    expect(readPluginBlockSettings(DECLARATION.fields, stored)).toBeNull();
  });

  it("reads the block itself through its definition", () => {
    expect(definition.read(SCHEDULE)).toEqual({
      type: "laundry/schedule",
      settings: {
        heading: "Tvättstugan",
        days: 3,
        showFree: true,
        room: "north",
      },
    });
    expect(definition.read({ type: "laundry/schedule" })).toBeNull();
  });
});

describe("a plugin's block, in the editor", () => {
  it("starts with the declared defaults, and a checkbox off", () => {
    expect(definition.editor.create()).toEqual({
      type: "laundry/schedule",
      settings: { days: 7, showFree: false },
    });
  });

  it("is sent once every required setting is answered", () => {
    const created = definition.editor.create();

    expect(registry.ready(created)).toBe(false);
    expect(
      registry.ready({
        ...created,
        settings: { ...created.settings, heading: "Tvätt" },
      }),
    ).toBe(true);
  });

  it("is offered under the plugin's own label", () => {
    expect(definition.editor).toMatchObject({
      label: "blocks.schedule.label",
      insert: "blocks.schedule.label",
      icon: "calendar",
      category: "association",
      nestable: false,
    });
  });
});

describe("what the guardrails scan on a plugin's block", () => {
  it("is every string in its settings, as words and as addresses", () => {
    const text = definition.text({
      type: "laundry/schedule",
      settings: { heading: "Ring 19121212-1212", room: "north" },
    });

    expect(text.words).toContain("19121212-1212");
    expect(text.addresses).toContain("Ring 19121212-1212");
  });

  it("is the same whether the block is registered or not", () => {
    expect(registry.text(SCHEDULE)).toEqual(PAGE_BLOCKS.text(SCHEDULE));
  });
});
