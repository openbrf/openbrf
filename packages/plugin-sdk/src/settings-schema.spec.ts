import { describe, expect, it } from "vitest";

import {
  defaultSettings,
  type PluginSettingsSchema,
  pluginSettingsSchema,
  settingsValidator,
} from "./settings-schema.ts";

function schema(fields: unknown[]): PluginSettingsSchema {
  return pluginSettingsSchema.parse({ fields });
}

describe("settingsValidator", () => {
  it("applies a declared default when the value is absent", () => {
    const validator = settingsValidator(
      schema([
        {
          key: "greeting",
          labelKey: "settings.greeting",
          type: "text",
          default: "Hej",
        },
      ]),
    );

    expect(validator.parse({})).toEqual({ greeting: "Hej" });
  });

  it("rejects an empty string for a required text field", () => {
    const validator = settingsValidator(
      schema([
        {
          key: "greeting",
          labelKey: "settings.greeting",
          type: "text",
          required: true,
        },
      ]),
    );

    expect(validator.safeParse({ greeting: "" }).success).toBe(false);
    expect(validator.safeParse({ greeting: "Hej" }).success).toBe(true);
  });

  it("leaves an optional field absent rather than inventing a value", () => {
    const validator = settingsValidator(
      schema([{ key: "note", labelKey: "settings.note", type: "text" }]),
    );

    expect(validator.parse({})).toEqual({});
  });

  it("enforces numeric bounds and integrality", () => {
    const validator = settingsValidator(
      schema([
        {
          key: "limit",
          labelKey: "settings.limit",
          type: "number",
          min: 1,
          max: 10,
          integer: true,
        },
      ]),
    );

    expect(validator.safeParse({ limit: 5 }).success).toBe(true);
    expect(validator.safeParse({ limit: 0 }).success).toBe(false);
    expect(validator.safeParse({ limit: 11 }).success).toBe(false);
    expect(validator.safeParse({ limit: 5.5 }).success).toBe(false);
  });

  it("restricts a select to its declared options", () => {
    const validator = settingsValidator(
      schema([
        {
          key: "mode",
          labelKey: "settings.mode",
          type: "select",
          options: [
            { value: "compact", labelKey: "settings.mode.compact" },
            { value: "full", labelKey: "settings.mode.full" },
          ],
        },
      ]),
    );

    expect(validator.safeParse({ mode: "compact" }).success).toBe(true);
    expect(validator.safeParse({ mode: "everything" }).success).toBe(false);
  });

  /**
   * A plugin that drops a setting in a new version must not be handed the old
   * value back as something it no longer understands.
   */
  it("strips a value the schema no longer declares", () => {
    const validator = settingsValidator(
      schema([{ key: "kept", labelKey: "settings.kept", type: "boolean" }]),
    );

    expect(validator.parse({ kept: true, removed: "old" })).toEqual({
      kept: true,
    });
  });

  it("rejects a settings key that is not an identifier", () => {
    expect(
      pluginSettingsSchema.safeParse({
        fields: [{ key: "__proto__", labelKey: "a", type: "text" }],
      }).success,
    ).toBe(false);
  });
});

describe("defaultSettings", () => {
  it("returns only the fields that declare a default", () => {
    const values = defaultSettings(
      schema([
        {
          key: "greeting",
          labelKey: "settings.greeting",
          type: "text",
          default: "Hej",
        },
        { key: "note", labelKey: "settings.note", type: "text" },
        {
          key: "enabled",
          labelKey: "settings.enabled",
          type: "boolean",
          default: false,
        },
      ]),
    );

    expect(values).toEqual({ greeting: "Hej", enabled: false });
  });
});

/**
 * A declaration is checked when the manifest is parsed, not when a value is
 * saved.
 *
 * Neither path a default takes goes through the field's own constraints.
 * `.default(value)` short-circuits an absent value and hands it back without
 * applying anything downstream, and `defaultSettings` reads the declaration
 * directly. So a contradictory field is accepted at install time and only
 * shows up as a plugin acting on a value it said it would never see, or as a
 * field a board cannot save whatever it types.
 */
describe("a contradictory field declaration", () => {
  function refuses(field: Record<string, unknown>): boolean {
    return !pluginSettingsSchema.safeParse({ fields: [field] }).success;
  }

  it("refuses a number default below its own minimum", () => {
    expect(
      refuses({
        key: "reminderDays",
        labelKey: "settings.reminderDays",
        type: "number",
        min: 10,
        default: 5,
      }),
    ).toBe(true);
  });

  it("refuses a number default above its own maximum", () => {
    expect(
      refuses({
        key: "rowLimit",
        labelKey: "settings.rowLimit",
        type: "number",
        max: 200,
        default: 500,
      }),
    ).toBe(true);
  });

  it("refuses a fractional default on an integer field", () => {
    expect(
      refuses({
        key: "rowLimit",
        labelKey: "settings.rowLimit",
        type: "number",
        integer: true,
        default: 2.5,
      }),
    ).toBe(true);
  });

  it("refuses a minimum above its own maximum", () => {
    expect(
      refuses({
        key: "rowLimit",
        labelKey: "settings.rowLimit",
        type: "number",
        min: 10,
        max: 5,
      }),
    ).toBe(true);
  });

  it("refuses a text default shorter than minLength", () => {
    expect(
      refuses({
        key: "heading",
        labelKey: "settings.heading",
        type: "text",
        minLength: 5,
        default: "ab",
      }),
    ).toBe(true);
  });

  it("refuses a text default longer than maxLength", () => {
    expect(
      refuses({
        key: "heading",
        labelKey: "settings.heading",
        type: "text",
        maxLength: 2,
        default: "far too long",
      }),
    ).toBe(true);
  });

  it("refuses a minLength above its own maxLength", () => {
    expect(
      refuses({
        key: "heading",
        labelKey: "settings.heading",
        type: "text",
        minLength: 10,
        maxLength: 2,
      }),
    ).toBe(true);
  });

  it("refuses a select default that is not one of its options", () => {
    expect(
      refuses({
        key: "grouping",
        labelKey: "settings.grouping",
        type: "select",
        default: "building",
        options: [
          { value: "address", labelKey: "settings.grouping.address" },
          { value: "floor", labelKey: "settings.grouping.floor" },
        ],
      }),
    ).toBe(true);
  });

  it("accepts a declaration whose bounds and default agree", () => {
    expect(
      refuses({
        key: "rowLimit",
        labelKey: "settings.rowLimit",
        type: "number",
        integer: true,
        min: 1,
        max: 200,
        default: 25,
      }),
    ).toBe(false);
  });

  it("names the field the declaration got wrong", () => {
    // The plugin author reads this at install time, so it has to point at the
    // field rather than at the manifest.
    const result = pluginSettingsSchema.safeParse({
      fields: [
        { key: "first", labelKey: "a", type: "boolean" },
        { key: "second", labelKey: "b", type: "number", min: 10, default: 5 },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toContain(
      "fields.1.default",
    );
  });
});
