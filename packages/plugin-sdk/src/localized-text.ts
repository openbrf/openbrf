import { z } from "zod";

/**
 * Text written in both languages the interface is offered in.
 *
 * For what the board reads before anything has been downloaded: the catalog's
 * own name and description of an entry, and the parts of a declaration the
 * consent screen shows, such as a recipient's purpose. A plugin's locale files
 * reach the instance with its package, so a key into them would have no words
 * behind it on the screen that decides whether the package is fetched.
 *
 * Strict, so a misspelled language is refused rather than dropped.
 */
export const localizedTextSchema = z.strictObject({
  sv: z.string().min(1).max(500),
  en: z.string().min(1).max(500),
});

export type LocalizedText = z.infer<typeof localizedTextSchema>;
