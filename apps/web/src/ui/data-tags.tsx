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
