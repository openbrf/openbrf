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

  it("reports a host package declared as a runtime dependency, once", () => {
    const problems = pluginPackageProblems(
      withPackageJson((packageJson) => {
        packageJson["dependencies"] = {
          "@nestjs/common": "^12.0.0",
          "date-fns": "^4.0.0",
        };
      }),
    );

    expect(problems).toEqual([
      expect.stringMatching(
        /^package\.json lists date-fns under dependencies\./,
      ),
      expect.stringMatching(
        /^package\.json lists @nestjs\/common under dependencies\. The host shares its own copy/,
      ),
    ]);
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

  /** The problems for the valid bundle with one more line in it. */
  function problemsWith(line: string): readonly string[] {
    return pluginPackageProblems({
      ...validPackage(),
      serverBundle: `${SERVER_BUNDLE}\n${line}`,
    });
  }

  const FOREIGN =
    /^The server bundle requires lodash\. Its only externals may be the host packages/;
  const COMPUTED =
    "The server bundle calls require with something other than a string literal, so what it loads cannot be checked.";

  // Every spelling a call to require can take reaches the same check: a space
  // or a line break before the parenthesis is still a call, and one pattern
  // that did not see it would let a foreign module through unexamined.
  it.each([
    ["a space before the parenthesis", 'require ("lodash");'],
    ["a line break before the parenthesis", 'require\n("lodash");'],
    ["a comment before the parenthesis", 'require /* bundled */ ("lodash");'],
    ["a member call", 'module.require("lodash");'],
    ["an optional call", 'require?.("lodash");'],
    ["an optional member call", 'module?.require("lodash");'],
    ["an escaped letter in the name", 'requ\\u0069re("lodash");'],
    ["a braced escape in the name", '\\u{72}equire("lodash");'],
  ])("reports a foreign module required with %s", (_how, line) => {
    expect(problemsWith(line)).toEqual([expect.stringMatching(FOREIGN)]);
  });

  it.each([
    ["a template literal", "require(`lodash`);"],
    ["a concatenation", 'require("lo" + "dash");'],
    ["a space and a variable", "require (name);"],
  ])("reports a specifier written as %s as not checkable", (_how, line) => {
    expect(problemsWith(line)).toEqual([COMPUTED]);
  });

  /*
   * Node's built-in modules resolve from any directory, the data volume
   * included, and a plugin already runs in the host's process: refusing one
   * would guard nothing. What the rule protects against is a package that
   * cannot be resolved from where an installed plugin sits.
   */
  it.each([
    'require("node:crypto");',
    'require("fs");',
    'require("fs/promises");',
    'require ("node:path");',
  ])("allows Node's built-in module in %s", (line) => {
    expect(problemsWith(line)).toEqual([]);
  });

  // Allowed because it resolves, not because it is harmless: this is not a
  // check of what a plugin can do, which is read by a person before listing.
  it("allows child_process: the check is about installing, not about capability", () => {
    expect(problemsWith('require("child_process");')).toEqual([]);
  });

  // The host's node_modules is a fallback for every lookup, so a path inside
  // a host package resolves exactly as the package itself does.
  it.each(['require("zod/v4");', 'require("@nestjs/common/decorators");'])(
    "allows a path inside a host package in %s",
    (line) => {
      expect(problemsWith(line)).toEqual([]);
    },
  );

  it("still reports a package whose name only starts like a host package's", () => {
    expect(problemsWith('require("zod-extra");')).toEqual([
      expect.stringMatching(/^The server bundle requires zod-extra\./),
    ]);
  });

  // None of these is a call to the loader, so none of them may fail a
  // package that makes no such call.
  it.each([
    ["a line comment", "// we require(config) at boot"],
    ["a block comment", "/* require(name) */"],
    ["a string", 'const hint = "call require(name) first";'],
    ["template text", "const hint = `call require(name) first`;"],
    ["a regular expression", "const pattern = /require\\(/;"],
    ["another object's method", "ctx.require(name);"],
    ["an optional method call", "ctx?.require(name);"],
    ["a function of that name", "function require(name) { return name; }"],
    ["a reference that is not called", "const resolve = require.resolve;"],
    [
      "an object's method",
      "const loader = { require(name) { return name; } };",
    ],
    ["a class's method", "class Loader { static require(name) {} }"],
    ["an accessor", "const loader = { get require() { return 1; } };"],
    ["a method with a default", 'const o = { require(n = f("x")) {} };'],
    ["a private method", "class Loader { #require(name) {} }"],
    ["a call to a private method", "this.#require(name);"],
    ["a method's body opened after a comment", "({ require(n) /* c */ {} });"],
  ])("does not read require in %s as a call", (_how, line) => {
    expect(problemsWith(line)).toEqual([]);
  });

  it("still reads the calls inside a method named require", () => {
    expect(
      problemsWith('const o = { require(n) { return require("lodash"); } };'),
    ).toEqual([expect.stringMatching(FOREIGN)]);
  });

  it("reads a call followed by a block on the next line as a call", () => {
    // The line break ends the statement, so this is a call and then a block.
    expect(problemsWith('require("lodash")\n{ start(); }')).toEqual([
      expect.stringMatching(FOREIGN),
    ]);
  });

  it("counts a call whose parenthesis is never closed", () => {
    expect(problemsWith('require("lodash"')).toEqual([COMPUTED]);
  });

  // Each of these once hid the require after it from the check.
  it.each([
    ["a division after an increment", 'a++ / b; const l = require("lodash");'],
    ["a division after a decrement", 'a-- / b; const l = require("lodash");'],
    ["a line comment ended by CR", '// note\rrequire("lodash");'],
    ["a line comment ended by U+2028", '// note\u2028require("lodash");'],
    ["a line comment ended by U+2029", '// note\u2029require("lodash");'],
    ["a string ended by CR", 'const s = "open\rrequire("lodash");'],
    [
      "a string continued over CRLF",
      'const s = "a\\\r\nb"; require("lodash");',
    ],
    ["a regular expression ended by CR", 'const r = /open\rrequire("lodash");'],
    [
      "a regular expression ended by U+2028",
      'const r = /a\u2028require("lodash");',
    ],
    [
      "an escaped line break in a regular expression",
      'const r = /a\\\nrequire("lodash");',
    ],
  ])("still reads the require after %s", (_how, line) => {
    expect(problemsWith(line)).toEqual([expect.stringMatching(FOREIGN)]);
  });

  // U+2028 may stand inside a string, so it does not end one.
  it("reads a string holding U+2028 to its closing quote", () => {
    expect(problemsWith('const s = "a\u2028 require(name)";')).toEqual([]);
  });

  it("reads `?.` before a digit as a conditional, not an optional chain", () => {
    expect(problemsWith('const n = a ?.5 : require("lodash");')).toEqual([
      expect.stringMatching(FOREIGN),
    ]);
  });

  it("reads a require inside a template's substitution", () => {
    expect(problemsWith("const text = `${require(name)}`;")).toEqual([
      COMPUTED,
    ]);
    expect(problemsWith('const text = `a ${require("lodash")} b`;')).toEqual([
      expect.stringMatching(FOREIGN),
    ]);
  });

  it("still reads the calls after a quote inside a regular expression", () => {
    expect(
      problemsWith('const quote = /"/g;\nconst lodash = require("lodash");'),
    ).toEqual([expect.stringMatching(FOREIGN)]);
  });

  // Comments between the word and its parenthesis once made the reading
  // backtrack exponentially: forty of them ran for hours.
  it("reads a bundle of adjacent comments in linear time", () => {
    const hostile = `require${"/**/".repeat(50_000)}x`;
    const started = performance.now();
    expect(problemsWith(hostile)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it.each([
    ["nested calls", `${"require(".repeat(50_000)}"x"${")".repeat(50_000)}`],
    ["line comments", "// c\n".repeat(50_000)],
    ["escaped names", "requ\\u0069re;".repeat(50_000)],
    ["method parameter lists", "({ require() /**/ {} });".repeat(20_000)],
  ])("reads a bundle of many %s in linear time", (_what, hostile) => {
    const started = performance.now();
    problemsWith(hostile);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("still reports a package that only shares a built-in's name as a prefix", () => {
    expect(problemsWith('require("fs-extra");')).toEqual([
      expect.stringMatching(/^The server bundle requires fs-extra\./),
    ]);
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
