/**
 * Generates the default theme's CSS from the token contract.
 *
 * The output is committed, like a lockfile, rather than produced during the
 * build. Two reasons: the values must be in the first stylesheet the browser
 * parses, or the app flashes unstyled on every load; and a committed file makes
 * a palette change visible in review as a diff of actual colours.
 *
 * A test asserts the committed file still matches the contract, so it cannot
 * drift silently. Run this after changing any token value:
 *
 *   pnpm --filter @openbrf/web theme:generate
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildThemeStylesheet, PORTTAVLAN } from "@openbrf/tokens";

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, "..", "src", "theme", "porttavlan.generated.css");

const header = `/*
 * GENERATED FILE - do not edit.
 *
 * Produced from the token contract in packages/tokens by
 * apps/web/scripts/generate-theme-css.mjs. Change a colour there, then run
 * "pnpm --filter @openbrf/web theme:generate". A test fails if this file and
 * the contract disagree.
 */
`;

writeFileSync(target, `${header}\n${buildThemeStylesheet(PORTTAVLAN)}`, "utf8");
console.log(`Wrote ${target}`);
