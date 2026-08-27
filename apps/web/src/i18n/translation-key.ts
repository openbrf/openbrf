import type { ParseKeys } from "i18next";

/**
 * A translation key, checked against the actual resources.
 *
 * Typed rather than left as `string` so a component naming a key that does not
 * exist fails to compile, instead of rendering the key itself to a board
 * member. Shared so the navigation and the sign-in screen cannot drift onto two
 * different definitions of "a key".
 */
export type TranslationKey = ParseKeys<"translation">;
