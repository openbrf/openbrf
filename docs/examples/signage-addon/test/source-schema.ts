import { z } from "zod";

/**
 * The `source` point's shapes and limits, version 1, as docs/digital-signage.md
 * documents them: the addon's own copy, to check its answers against before a
 * screen does.
 *
 * Digital signage holds the authoritative schema and the host holds every
 * answer to it, refusing the whole answer with `output-invalid` for one string
 * over its limit or one key the point does not name. So each string is checked
 * against its own limit here, and every object is strict.
 */

export const sourceInputSchema = z.strictObject({
  screen: z.strictObject({
    id: z.string().min(1).max(64),
    addressId: z.string().min(1).max(64).nullable(),
    placement: z.enum(["inside", "outside"]),
    locale: z.enum(["sv", "en"]),
  }),
});

const HEADING = 200;

const textSlide = z.strictObject({
  kind: z.literal("text"),
  heading: z.string().max(HEADING),
  body: z.array(z.string().max(2_000)).max(40),
});

const tableSlide = z.strictObject({
  kind: z.literal("table"),
  heading: z.string().max(HEADING),
  columns: z.array(z.string().max(80)).min(1).max(4),
  rows: z.array(z.array(z.string().max(200)).max(4)).max(60),
});

const doorsSlide = z.strictObject({
  kind: z.literal("doors"),
  heading: z.string().max(HEADING),
  doors: z
    .array(
      z.strictObject({
        floor: z.int().min(-20).max(200).nullable(),
        apartment: z.string().min(1).max(20),
        names: z.array(z.string().min(1).max(80)).max(12),
      }),
    )
    .max(120),
});

export const sourceOutputSchema = z.strictObject({
  slides: z
    .array(z.discriminatedUnion("kind", [textSlide, tableSlide, doorsSlide]))
    .max(8),
});
