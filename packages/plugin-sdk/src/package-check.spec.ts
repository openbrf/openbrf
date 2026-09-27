import { describe, expect, it } from "vitest";

import { PLUGIN_API_VERSION } from "./api-version.ts";
import {
  HOST_SHARED_PACKAGES,
  type PluginPackageContents,
  pluginPackageProblems,
} from "./package-check.ts";

/**
 * The check an author's CI and the catalog both run on a packed plugin.
 *
 * Each case starts from a package with nothing wrong and breaks one thing, so
 * a case can only pass by the check noticing that one thing: a problem found
 * for some other reason would show up in the valid package's case first.
 */

const SERVER_BUNDLE = [
  '"use strict";',
  'Object.defineProperty(exports, "__esModule", { value: true });',
  "exports.createPlugin = void 0;",
  'const common_1 = require("@nestjs/common");',
  'const zod_1 = require("zod");',
  "const createPlugin = (host) => ({ module: class OccupancyModule {} });",
  "exports.createPlugin = createPlugin;",
].join("\n");

function validPackage(): PluginPackageContents {
  return {
    packageJson: {
      name: "@openbrf/example-plugin",
      version: "1.0.0",
      license: "MIT-0",
      openbrf: {
        apiVersion: PLUGIN_API_VERSION,
        id: "occupancy",
        entry: { server: "dist/server.cjs", client: "dist/remoteEntry.js" },
        permissions: ["addressBook:read"],
        view: { titleKey: "title" },
      },
      devDependencies: {
        "@nestjs/common": "12.1.0",
        "@openbrf/plugin-sdk": "^1.0.0",
      },
      peerDependencies: { "@nestjs/common": "^12.0.0", zod: "^4.6.2" },
    },
    files: [
      "package.json",
      "dist/server.cjs",
      "dist/remoteEntry.js",
      "locales/sv.json",
      "locales/en.json",
    ],
    serverBundle: SERVER_BUNDLE,
    locales: {
      sv: { title: "Boende", settings: { heading: "Rubrik" } },
      en: { title: "Occupancy", settings: { heading: "Heading" } },
    },
  };
}

function withPackageJson(
  change: (packageJson: Record<string, unknown>) => void,
): PluginPackageContents {
  const contents = validPackage();
  const packageJson = structuredClone(contents.packageJson) as Record<
    string,
    unknown
  >;
  change(packageJson);
  return { ...contents, packageJson };
}

describe("pluginPackageProblems", () => {
  it("finds nothing wrong with a valid package", () => {
    expect(pluginPackageProblems(validPackage())).toEqual([]);
  });

  it("reports the manifest's own issues, naming the field", () => {
    const problems = pluginPackageProblems(
      withPackageJson((packageJson) => {
        (packageJson["openbrf"] as Record<string, unknown>)["id"] = "Not Valid";
      }),
    );

    expect(problems).toEqual([
      expect.stringMatching(
        /^The manifest in package\.json is invalid at openbrf\.id: /,
      ),
    ]);
  });

  it("reports a runtime dependency", () => {
    // The installer's npm would go to a registry for it, and an instance never
    // contacts one.
    const problems = pluginPackageProblems(
      withPackageJson((packageJson) => {
        packageJson["dependencies"] = { "date-fns": "^4.0.0" };
      }),
    );

    expect(problems).toEqual([
      expect.stringMatching(
        /^package\.json lists date-fns under dependencies\./,
      ),
    ]);
  });

  it("reports a bundled dependency listed as an array", () => {
    const problems = pluginPackageProblems(
      withPackageJson((packageJson) => {
        packageJson["bundleDependencies"] = ["date-fns"];
      }),
    );

    expect(problems).toEqual([
      expect.stringMatching(/date-fns under bundleDependencies/),
    ]);
  });

  it("reports a host package declared anywhere but as a peer", () => {
    const problems = pluginPackageProblems(
      withPackageJson((packageJson) => {
        packageJson["dependencies"] = { "@nestjs/common": "^12.0.0" };
      }),
    );

    expect(problems).toContainEqual(
      expect.stringMatching(
        /^package\.json lists @nestjs\/common under dependencies\. The host shares its own copy/,
      ),
    );
  });

  it("reports a declared entry the package does not contain", () => {
    // What the loader would skip as entry-missing after the restart.
    const contents = validPackage();
    const problems = pluginPackageProblems({
      ...contents,
      files: contents.files.filter((file) => file !== "dist/remoteEntry.js"),
    });

    expect(problems).toEqual([
      "The manifest declares dist/remoteEntry.js as the client entry, and the package does not contain it.",
    ]);
  });

  it("finds an entry declared with a leading ./", () => {
    const problems = pluginPackageProblems(
      withPackageJson((packageJson) => {
        (packageJson["openbrf"] as Record<string, unknown>)["entry"] = {
          server: "./dist/server.cjs",
        };
      }),
    );

    expect(problems).toEqual([]);
  });

  it("reports a server bundle requiring a package the host does not share", () => {
    // An installed plugin sits on the data volume, where only the host
    // packages are bridged in; anything else would fail to resolve at boot.
    const problems = pluginPackageProblems({
      ...validPackage(),
      serverBundle: `${SERVER_BUNDLE}\nconst lodash = require("lodash");`,
    });

    expect(problems).toEqual([
      expect.stringMatching(
        /^The server bundle requires lodash\. Its only externals/,
      ),
    ]);
  });

  it("reports a require whose target is not a string literal", () => {
    const problems = pluginPackageProblems({
      ...validPackage(),
      serverBundle: `${SERVER_BUNDLE}\nconst name = "lodash";\nconst lodash = require(name);`,
    });

    expect(problems).toEqual([
      "The server bundle calls require with something other than a string literal, so what it loads cannot be checked.",
    ]);
  });

  it("does not mistake a spaced literal for a computed require", () => {
    const problems = pluginPackageProblems({
      ...validPackage(),
      serverBundle: `${SERVER_BUNDLE}\nconst core = require( "@nestjs/core" );`,
    });

    expect(problems).toEqual([]);
  });

  it("reports a server bundle that does not export createPlugin", () => {
    const problems = pluginPackageProblems({
      ...validPackage(),
      serverBundle: SERVER_BUNDLE.replaceAll(
        "exports.createPlugin",
        "exports.create",
      ),
    });

    expect(problems).toEqual([
      "The server bundle does not assign exports.createPlugin. The host loads it with require and reads that export.",
    ]);
  });

  it("reports a key the English locale has and the Swedish one lacks", () => {
    const contents = validPackage();
    const problems = pluginPackageProblems({
      ...contents,
      locales: {
        ...contents.locales,
        en: {
          title: "Occupancy",
          settings: { heading: "Heading", hint: "A hint" },
        },
      },
    });

    expect(problems).toEqual([
      "locales/sv.json lacks settings.hint, which locales/en.json has. The two carry identical keys.",
    ]);
  });

  it("reports a missing locale file", () => {
    const contents = validPackage();
    const problems = pluginPackageProblems({
      ...contents,
      files: contents.files.filter((file) => file !== "locales/en.json"),
      locales: { sv: contents.locales.sv },
    });

    expect(problems).toEqual(["The package has no locales/en.json."]);
  });

  it("names the packages a plugin shares with the host", () => {
    expect(HOST_SHARED_PACKAGES).toEqual([
      "@nestjs/common",
      "@nestjs/core",
      "zod",
    ]);
  });
});
