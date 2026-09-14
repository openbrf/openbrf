import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  actionInputJsonSchema,
  actionOutputJsonSchema,
} from "./action-schema.ts";

/**
 * The conversion every published action schema goes through.
 *
 * Each case here is a way the document could quietly disagree with what the
 * service enforces. A caller that is a model reads the document and believes
 * it, so a disagreement is not a cosmetic defect: it is the platform telling
 * something to send a value it will then refuse, or accepting one it said it
 * would not.
 */

describe("what the published document says about unknown keys", () => {
  it("keeps a strict object strict", () => {
    const schema = actionInputJsonSchema(
      z.strictObject({ id: z.string() }),
      "news_get",
    );

    expect(schema.additionalProperties).toBe(false);
  });

  it("keeps it strict at every depth", () => {
    // The depth is the half that gets missed. A nested plain object emits no
    // additionalProperties at all while zod strips unknown keys at runtime,
    // which is the "answered saved and it was not" failure, on the surface a
    // model reads.
    const schema = actionInputJsonSchema(
      z.strictObject({
        page: z.strictObject({ slug: z.string() }),
      }),
      "page_update",
    );

    const page = (schema.properties as { page: Record<string, unknown> }).page;
    expect(page.additionalProperties).toBe(false);
  });

  it("says a plain object accepts them, which is why actions may not use one", () => {
    const schema = actionInputJsonSchema(
      z.object({ id: z.string() }),
      "news_get",
    );

    // Not a bug in the conversion: it is the honest rendering of a schema that
    // does not refuse unknown keys. The contract test over the catalogue is
    // what turns this into a refusal.
    expect(schema.additionalProperties).toBeUndefined();
  });
});

describe("what the document says a caller must send", () => {
  it("leaves a defaulted key optional", () => {
    // Under output mode a defaulted key is required, and a model reading that
    // supplies a value for every field the platform was happy to choose.
    const schema = actionInputJsonSchema(
      z.strictObject({ limit: z.number().default(20), id: z.string() }),
      "news_list",
    );

    expect(schema.required).toEqual(["id"]);
  });
});

describe("what cannot be published at all", () => {
  it("refuses a date, naming the action and the path", () => {
    expect(() =>
      actionInputJsonSchema(z.strictObject({ from: z.date() }), "news_list"),
    ).toThrow(/news_list.*from/s);
  });

  it("refuses a transform through the output helper", () => {
    /*
     * The asymmetry is real and is why both helpers run at registration. Under
     * input mode a transform is erased and the pre-transform type is emitted,
     * with no error; only output mode refuses. So the pair is what guarantees
     * that no action carries one.
     */
    const withTransform = z.strictObject({
      slug: z.string().transform((value) => value.trim()),
    });

    expect(() =>
      actionInputJsonSchema(withTransform, "news_create"),
    ).not.toThrow();
    expect(() => actionOutputJsonSchema(withTransform, "news_create")).toThrow(
      /news_create/,
    );
  });

  it("refuses a schema built with another copy of zod", () => {
    // A plugin that bundled its own zod produces schemas from a second realm.
    // They look right and convert wrong, so registration refuses them.
    const foreign = { "~standard": { version: 1, vendor: "elsewhere" } };

    expect(() =>
      actionInputJsonSchema(
        foreign as unknown as z.ZodType,
        "occupancy_summary",
      ),
    ).toThrow(/host's zod/);
  });
});

describe("what the document must never contain", () => {
  it("inlines a reused schema rather than naming it", () => {
    // A $ref points at a name invented from the position a schema held, and
    // that name would reach a committed artefact and a third-party client.
    const block = z.strictObject({ text: z.string() });
    const schema = actionInputJsonSchema(
      z.strictObject({ first: block, second: block }),
      "page_update",
    );

    expect(JSON.stringify(schema)).not.toContain("$ref");
    expect(schema.$defs).toBeUndefined();
  });

  it("describes every property it publishes", () => {
    // Not enforced by the converter; asserted here so the mechanism it rests
    // on is pinned. A described property survives conversion.
    const schema = actionInputJsonSchema(
      z.strictObject({ id: z.string().describe("The news item's id.") }),
      "news_get",
    );

    const id = (schema.properties as { id: Record<string, unknown> }).id;
    expect(id.description).toBe("The news item's id.");
  });
});
