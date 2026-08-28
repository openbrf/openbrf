import { z } from "zod";

/**
 * A plugin's settings form, declared rather than drawn.
 *
 * The host renders it, validates against it, and stores the result. A plugin
 * therefore never ships a settings screen of its own, which is what keeps
 * plugin settings looking like the rest of the product and keeps the values
 * validated on the server rather than only in a form the plugin drew.
 *
 * Labels are i18n KEYS, resolved in the plugin's own namespace
 * (`plugin-<id>`, merged at runtime from its locales/{sv,en}.json). Inline
 * label text is deliberately not accepted: a manifest carrying English prose
 * would put an untranslatable string on a Swedish-first screen, and the
 * runtime merge already exists to hold that text.
 */

const settingsKeySchema = z
  .string()
  .min(1)
  .max(64)
  // A settings key becomes a JSON object key and a form field name. Keeping it
  // to an identifier shape means a stored value can never collide with a
  // prototype member or need escaping in either place.
  .regex(/^[a-z][a-zA-Z0-9_]*$/, "must be a lowerCamelCase identifier");

const translationKeySchema = z.string().min(1).max(200);

const baseFieldSchema = z.object({
  key: settingsKeySchema,
  labelKey: translationKeySchema,
  /** Help text under the field. Never the only carrier of a requirement. */
  hintKey: translationKeySchema.optional(),
  required: z.boolean().default(false),
});

const textFieldSchema = baseFieldSchema.extend({
  type: z.literal("text"),
  default: z.string().optional(),
  minLength: z.int().min(0).optional(),
  maxLength: z.int().min(1).max(10_000).optional(),
});

const numberFieldSchema = baseFieldSchema.extend({
  type: z.literal("number"),
  default: z.number().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  integer: z.boolean().default(false),
});

const booleanFieldSchema = baseFieldSchema.extend({
  type: z.literal("boolean"),
  default: z.boolean().optional(),
});

const selectFieldSchema = baseFieldSchema.extend({
  type: z.literal("select"),
  default: z.string().optional(),
  options: z
    .array(
      z.object({
        value: z.string().min(1).max(200),
        labelKey: translationKeySchema,
      }),
    )
    .min(1)
    .max(50),
});

export const pluginSettingsFieldSchema = z.discriminatedUnion("type", [
  textFieldSchema,
  numberFieldSchema,
  booleanFieldSchema,
  selectFieldSchema,
]);

export type PluginSettingsField = z.infer<typeof pluginSettingsFieldSchema>;

/**
 * Checks a field's bounds against each other and against its default.
 *
 * Done while the manifest is parsed rather than left to the validator, because
 * neither of the two paths a default takes goes through the field's
 * constraints. `.default(value)` short-circuits an absent value and returns it
 * without applying anything downstream, and `defaultSettings` reads the
 * declaration directly. A number field declaring `min: 10, default: 5` would
 * otherwise hand the plugin a 5 it said it would never see, and
 * `minLength: 10, maxLength: 2` would declare a field no submitted value can
 * satisfy - both of which are the plugin's mistake to hear about at install
 * time rather than the board's to discover at a save.
 */
function checkFieldConstraints(
  field: PluginSettingsField,
  index: number,
  ctx: z.RefinementCtx,
): void {
  const reject = (message: string, key: string): void => {
    ctx.addIssue({
      code: "custom",
      message,
      path: ["fields", index, key],
    });
  };

  switch (field.type) {
    case "text": {
      if (
        field.minLength !== undefined &&
        field.maxLength !== undefined &&
        field.minLength > field.maxLength
      ) {
        reject("minLength must not be greater than maxLength", "minLength");
      }
      if (field.default === undefined) {
        return;
      }
      if (
        field.minLength !== undefined &&
        field.default.length < field.minLength
      ) {
        reject("the default is shorter than minLength", "default");
      }
      if (
        field.maxLength !== undefined &&
        field.default.length > field.maxLength
      ) {
        reject("the default is longer than maxLength", "default");
      }
      return;
    }
    case "number": {
      if (
        field.min !== undefined &&
        field.max !== undefined &&
        field.min > field.max
      ) {
        reject("min must not be greater than max", "min");
      }
      if (field.default === undefined) {
        return;
      }
      if (field.integer && !Number.isInteger(field.default)) {
        reject("the default is not an integer", "default");
      }
      if (field.min !== undefined && field.default < field.min) {
        reject("the default is below min", "default");
      }
      if (field.max !== undefined && field.default > field.max) {
        reject("the default is above max", "default");
      }
      return;
    }
    case "select": {
      if (
        field.default !== undefined &&
        !field.options.some((option) => option.value === field.default)
      ) {
        reject("the default is not one of the declared options", "default");
      }
      return;
    }
    case "boolean":
      return;
  }
}

export const pluginSettingsSchema = z
  .object({
    fields: z
      .array(pluginSettingsFieldSchema)
      .max(50)
      .refine(
        (fields) =>
          new Set(fields.map((field) => field.key)).size === fields.length,
        { message: "field keys must be unique" },
      ),
  })
  .superRefine((declaration, ctx) => {
    declaration.fields.forEach((field, index) => {
      checkFieldConstraints(field, index, ctx);
    });
  });

export type PluginSettingsSchema = z.infer<typeof pluginSettingsSchema>;

export type PluginSettingsValues = Record<string, string | number | boolean>;

/**
 * Builds the validator for one settings declaration.
 *
 * Produced from the declaration rather than written by the plugin, so the
 * form the host renders and the values the host stores can never disagree
 * about what is acceptable. Unknown keys are stripped: a plugin that drops a
 * setting in a new version must not leave the old value behind to be handed
 * back to it as something it no longer understands.
 */
export function settingsValidator(
  schema: PluginSettingsSchema,
): z.ZodType<PluginSettingsValues> {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const field of schema.fields) {
    shape[field.key] = fieldValidator(field);
  }

  return z.object(shape).strip() as unknown as z.ZodType<PluginSettingsValues>;
}

function fieldValidator(field: PluginSettingsField): z.ZodTypeAny {
  switch (field.type) {
    case "text": {
      let text = z.string();
      if (field.minLength !== undefined) {
        text = text.min(field.minLength);
      }
      if (field.maxLength !== undefined) {
        text = text.max(field.maxLength);
      }
      // A required text field rejects the empty string. Without this a form
      // submitted with the field untouched would satisfy "required" with a
      // value the plugin has to treat as missing anyway.
      return optionality(field.required ? text.min(1) : text, field);
    }
    case "number": {
      let number = field.integer ? z.number().int() : z.number();
      if (field.min !== undefined) {
        number = number.min(field.min);
      }
      if (field.max !== undefined) {
        number = number.max(field.max);
      }
      return optionality(number, field);
    }
    case "boolean":
      return optionality(z.boolean(), field);
    case "select":
      return optionality(
        z.enum(field.options.map((option) => option.value)),
        field,
      );
  }
}

/**
 * Applies the declared default and, for an optional field, tolerates absence.
 *
 * A default makes the field satisfied whether or not it was submitted, which
 * is why it is applied before the optional wrapper rather than after.
 */
function optionality(
  validator: z.ZodTypeAny,
  field: PluginSettingsField,
): z.ZodTypeAny {
  if (field.default !== undefined) {
    return validator.default(field.default);
  }
  return field.required ? validator : validator.optional();
}

/** The values a fresh installation starts with, from the declared defaults. */
export function defaultSettings(
  schema: PluginSettingsSchema,
): PluginSettingsValues {
  const values: PluginSettingsValues = {};
  for (const field of schema.fields) {
    if (field.default !== undefined) {
      values[field.key] = field.default;
    }
  }
  return values;
}
