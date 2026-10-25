import { readFile, rm } from "node:fs/promises";
import { builtinModules } from "node:module";

import { build } from "esbuild";

/**
 * Builds the server entry point: one CommonJS bundle, `dist/server.cjs`.
 *
 * An installed plugin sits on the instance's data volume, where nothing but
 * Node's built-ins and the packages the host shares can be resolved. The
 * host's packages, named under `peerDependencies`, are left external: a second
 * copy of NestJS would be a second, disconnected framework. The locale files
 * are bundled in, since the handler reads them itself.
 */
const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const hostShared = Object.keys(packageJson.peerDependencies);

await rm(new URL("../dist", import.meta.url), { recursive: true, force: true });
await build({
  entryPoints: ["src/entry.cjs"],
  outfile: "dist/server.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: [
    ...hostShared,
    ...hostShared.map((name) => `${name}/*`),
    ...builtinModules,
    "node:*",
  ],
  logLevel: "info",
});
