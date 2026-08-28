import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

/**
 * Bridging module resolution between the host and an installed plugin
 * (ADR 0003).
 *
 * Plugins live in /data/plugins, on a volume with no relationship to the
 * application's own node_modules. Node's CJS resolution walks up from the
 * plugin's directory through /data and /, and can never reach the host's
 * packages - so declaring @nestjs/* as peerDependencies does nothing at
 * runtime, which the spike measured directly.
 *
 * Two mechanisms fix that, and neither is sufficient alone:
 *
 *   NODE_PATH pointed at the host's node_modules, which CJS require honours
 *   as a fallback - and only as a fallback, so a copy sitting beside the
 *   plugin wins over it.
 *
 *   npm install --omit=peer, so no such copy is ever placed there. npm 7 and
 *   later installs peerDependencies automatically, and a second copy of
 *   @nestjs/common breaks dependency injection in ways that surface late.
 *
 * The identity assertion below is the check that the two actually worked. It
 * compares resolved file paths rather than trusting the absence of an error,
 * because a duplicate copy loads happily and fails much later at ModuleRef or
 * an instanceof.
 */

/**
 * Packages a plugin must share with the host rather than carry its own copy
 * of. Everything here holds process-wide state - a DI container, a metadata
 * registry - so a second copy is not a duplicate, it is a second and
 * disconnected system.
 */
export const HOST_SHARED_PACKAGES: readonly string[] = [
  "@nestjs/common",
  "@nestjs/core",
];

/**
 * A require whose resolution matches the running host's.
 *
 * The API is CommonJS in production and ESM under Vitest, so neither
 * `require` nor `import.meta.url` exists in both. __dirname is the accurate
 * base when it exists, because it is where the host's own modules resolve
 * from; the working directory is the fallback, and it is the same tree.
 */
function hostRequire(): NodeJS.Require {
  const base =
    typeof __dirname === "string" ? __dirname : resolve(process.cwd());
  return createRequire(join(base, "noop.js"));
}

/**
 * The node_modules directory a package actually resolved from.
 *
 * Derived from where the package really is rather than assembled from a guess
 * about the layout, so it stays right whether the application runs from src,
 * from dist, or from an image where the workspace has been flattened. Scoped
 * packages sit two levels below node_modules, unscoped ones one.
 */
function modulesDirectoryOf(packageName: string): string | null {
  try {
    // A package.json path is stable to resolve; a package's main entry may be
    // exports-mapped to a file several directories deep.
    const manifest = hostRequire().resolve(`${packageName}/package.json`);
    const depth = packageName.startsWith("@") ? 2 : 1;
    return resolve(dirname(manifest), ...Array<string>(depth).fill(".."));
  } catch {
    return null;
  }
}

/**
 * Every directory the shared host packages resolve from.
 *
 * Usually one, and that is the case the production image produces: npm builds
 * a flat tree, so every shared package sits in the same node_modules. It is
 * not the case under pnpm, whose isolated store gives each package its own
 * directory - so bridging only the first one would leave a plugin able to
 * resolve @nestjs/common and not @nestjs/core, and the difference would show
 * up in development and not in the image, which is the worst way round.
 */
export function hostModulesDirectories(
  packages: readonly string[] = HOST_SHARED_PACKAGES,
): string[] {
  const directories: string[] = [];
  for (const packageName of packages) {
    const directory = modulesDirectoryOf(packageName);
    if (directory !== null && !directories.includes(directory)) {
      directories.push(directory);
    }
  }
  return directories;
}

/** The directory the application's own NestJS resolves from. */
export function hostModulesDirectory(): string | null {
  return modulesDirectoryOf("@nestjs/common");
}

interface ModuleInternals {
  _initPaths?: () => void;
}

/**
 * Puts the host's node_modules directories on NODE_PATH.
 *
 * Called before any plugin is loaded. Module._initPaths is Node's own routine
 * for re-reading NODE_PATH, and it has to be invoked explicitly because the
 * variable is otherwise read once at process start: setting it from inside the
 * process without this does nothing at all.
 *
 * Returns the first directory it bridged, or null when the host's modules
 * could not be located at all - in which case the caller reports and loads no
 * plugins, rather than loading them into a resolution that is going to fail
 * confusingly.
 */
export function bridgeHostResolution(
  directories: readonly string[] = hostModulesDirectories(),
): string | null {
  const hostModules = directories[0];
  if (hostModules === undefined) {
    return null;
  }

  const separator = process.platform === "win32" ? ";" : ":";
  const entries = (process.env.NODE_PATH ?? "")
    .split(separator)
    .filter((entry) => entry !== "");

  // Prepended in reverse so the first shared package's directory ends up
  // first, and idempotently so a second call does not grow the variable.
  for (const directory of [...directories].reverse()) {
    if (!entries.includes(directory)) {
      entries.unshift(directory);
    }
  }
  process.env.NODE_PATH = entries.join(separator);

  // Node exposes no public API for re-reading NODE_PATH. _initPaths is the
  // mechanism every tool that does this relies on; the alternative would be
  // re-executing the process with the variable set, which makes starting the
  // API a two-process affair for the sake of one string.
  const moduleInternals = hostRequire()("node:module") as ModuleInternals;
  moduleInternals._initPaths?.();

  return hostModules;
}

/**
 * Loads a plugin's prebuilt CJS bundle.
 *
 * require rather than import(): the bundles are CommonJS by contract
 * (ADR 0003), and only CJS resolution honours the NODE_PATH bridge that lets
 * them reach the host's packages at all. ESM resolution ignores NODE_PATH
 * entirely, which is recorded in the ADR as a revisit trigger.
 *
 * The default export is unwrapped, so a bundle written as an ES module and
 * compiled to CJS and one written as CJS both work.
 */
export function requirePluginBundle(entry: string): unknown {
  const loaded = hostRequire()(entry) as {
    default?: unknown;
    createPlugin?: unknown;
  };

  return loaded.createPlugin ?? loaded.default ?? loaded;
}

export interface ResolutionConflict {
  package: string;
  hostPath: string;
  pluginPath: string;
}

/**
 * Checks that a plugin resolves the shared host packages to the host's copies.
 *
 * Asserts identity, not the absence of an error. A duplicate copy of
 * @nestjs/common installed beside a plugin resolves fine, decorates fine, and
 * then fails at a ModuleRef lookup or an instanceof long after the install
 * looked successful - so the refusal has to happen here, where it can still be
 * reported as "this plugin was not registered".
 *
 * A package the plugin does not resolve at all is not a conflict: a plugin
 * that never touches NestJS is the common case, and demanding it resolve a
 * package it does not use would refuse exactly the plugins that follow the
 * contract most closely.
 */
export function findResolutionConflicts(
  pluginDirectory: string,
  packages: readonly string[] = HOST_SHARED_PACKAGES,
): ResolutionConflict[] {
  const conflicts: ResolutionConflict[] = [];
  const resolver = hostRequire();

  for (const packageName of packages) {
    const specifier = `${packageName}/package.json`;

    let hostPath: string;
    try {
      hostPath = resolver.resolve(specifier);
    } catch {
      // The host does not have it either, so there is no identity to violate.
      continue;
    }

    let pluginPath: string;
    try {
      // Resolving from the plugin's directory reproduces what the plugin's own
      // require would find, NODE_PATH fallback included - which is exactly the
      // question being asked.
      pluginPath = resolver.resolve(specifier, { paths: [pluginDirectory] });
    } catch {
      // The plugin cannot see it. Either it does not use it, or the bridge is
      // missing - and the bridge is checked once, at boot, by its caller.
      continue;
    }

    if (pluginPath !== hostPath) {
      conflicts.push({ package: packageName, hostPath, pluginPath });
    }
  }

  return conflicts;
}
