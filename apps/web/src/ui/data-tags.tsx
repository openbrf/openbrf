import type { ReactElement } from "react";

/**
 * The `<data>` tag of a translated sentence that carries register data.
 *
 * A date or a time set in the UI face is a defect (DESIGN.md, the Mono-Grid
 * Rule), but the sentence around it is prose and stays in the UI face. A
 * translation wraps the value in `<data>{{value}}</data>` and is rendered with
 * `<Trans components={DATA_TAGS} />`, so each language keeps the value where
 * its own sentence wants it.
 */
export const DATA_TAGS = { data: <span className="font-data" /> };

/**
 * Text somebody typed, for a self-closing tag of a translated sentence.
 *
 * `<Trans>` interpolates its `values` into the translation before it parses the
 * tags in it, and interpolation does not escape (React escapes what it renders),
 * so a name such as `Kim </0>` would close the sentence early and `Kim <data>`
 * would open a tag. A translation that names somebody carries the name as a
 * self-closing tag, `<name/>`, and is rendered with
 * `components={{ ...DATA_TAGS, name: literal(name) }}`: the name is a child of
 * the component rather than part of the string, so it is never parsed. The tag
 * must be self-closing: `<name></name>` would replace the name with the empty
 * content between the tags.
 */
export function literal(text: string): ReactElement {
  return <>{text}</>;
}
