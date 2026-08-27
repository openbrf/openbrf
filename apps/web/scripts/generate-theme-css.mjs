/**
 * Generates the default theme's CSS from the token contract.
 *
 * The output is committed, like a lockfile, rather than produced during the
 * build. Two reasons: the values must be in the first stylesheet the browser
 * parses, or the app flashes unstyled on every load; and a committed file makes
 * a palette change visible in review as a diff of actual colours.
 *
 * Run with --check to verify the committed file matches the contract without
 * writing, which is what CI does so the two cannot drift silently.
 *
 * Run this after changing any token value:
 *
 *   pnpm --filter @openbrf/web theme:generate
 */
import { readFileSync, writeFileSync } from "node:fs";
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

const contents = `${header}\n${buildThemeStylesheet(PORTTAVLAN)}`;

if (process.argv.includes("--check")) {
  let committed = "";
  try {
    committed = readFileSync(target, "utf8");
  } catch {
    console.error(
      `Missing ${target}. Run: pnpm --filter @openbrf/web theme:generate`,
    );
    process.exit(1);
  }

  if (committed !== contents) {
    console.error(
      `${target} is out of date with the token contract.\n` +
        "Run: pnpm --filter @openbrf/web theme:generate",
    );
    process.exit(1);
  }

  console.log("Theme stylesheet matches the token contract.");
} else {
  writeFileSync(target, contents, "utf8");
  console.log(`Wrote ${target}`);
}
