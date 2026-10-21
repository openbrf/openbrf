import { createRequire } from "node:module";
import { join, resolve } from "node:path";

/**
 * A require whose resolution matches the running host's.
 *
 * The API is CommonJS in production and ESM under Vitest, so neither
 * `require` nor `import.meta.url` exists in both. __dirname is the accurate
 * base when it exists, because it is where the host's own modules resolve
 * from; the working directory is the fallback, and it is the same tree.
 */
export function hostRequire(): NodeJS.Require {
  const base =
    typeof __dirname === "string" ? __dirname : resolve(process.cwd());
  return createRequire(join(base, "noop.js"));
}
