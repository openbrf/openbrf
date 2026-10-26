import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePluginPackage, pluginPackageProblems } from "@openbrf/plugin-sdk";
import { describe, expect, it } from "vitest";
import en from "../locales/en.json";
import sv from "../locales/sv.json";

const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  openbrf: Record<string, unknown>;
  dependencies?: unknown;
};

/** What digital signage asks the board for, from docs/digital-signage.md. */
const SIGNAGE_PERMISSIONS = [
  "news:read",
  "calendar:read",
  "bookings:readAvailability",
  "media:read",
  "addresses:read",
];

describe("the manifest", () => {
  it("is read by the SDK's own parser", () => {
    const parsed = parsePluginPackage(packageJson);
    expect(parsed.ok).toBe(true);
  });

  it("extends digital signage at source, version 1, and hands it no personal data", () => {
    expect(packageJson.openbrf.extends).toEqual([
      { plugin: "signage", point: "source", version: 1 },
    ]);
    expect(packageJson.openbrf.personalData).toEqual([]);
    expect(packageJson.openbrf.extensionPoints).toBeUndefined();
  });

  it("asks for the one permission the handler uses, and none of the others digital signage holds", () => {
    // Holding addresses:read as digital signage does is not sharing it: the
    // board consents to each plugin's permissions apart.
    expect(packageJson.openbrf.permissions).toEqual(["addresses:read"]);
    for (const permission of SIGNAGE_PERMISSIONS.filter(
      (permission) => permission !== "addresses:read",
    )) {
      expect(packageJson.openbrf.permissions).not.toContain(permission);
    }
  });

  it("declares no runtime dependencies", () => {
    expect(packageJson.dependencies).toBeUndefined();
  });
});

describe("the locale files", () => {
  it("hold the same keys in Swedish and English", () => {
    expect(Object.keys(sv).sort()).toEqual(Object.keys(en).sort());
  });
});

describe("the source", () => {
  /** Every module specifier the addon's source imports or requires. */
  function specifiers(): string[] {
    const found = new Set<string>();
    for (const file of readdirSync("src")) {
      const text = readFileSync(join("src", file), "utf8");
      for (const match of text.matchAll(
        /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g,
      )) {
        found.add(match[1] as string);
      }
    }
    return [...found].sort();
  }

  it("imports the public SDK, NestJS and its own files, and nothing else", () => {
    const outside = specifiers().filter(
      (specifier) => !specifier.startsWith("."),
    );
    expect(outside).toEqual(["@nestjs/common", "@openbrf/plugin-sdk"]);
  });
});

describe("the packed package", () => {
  const [packed] = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json", "--silent"], {
      encoding: "utf8",
    }),
  ) as { files: { path: string }[] }[];
  const files = (packed?.files ?? []).map((file) => file.path).sort();
  const bundle = readFileSync("dist/server.cjs", "utf8");

  it("holds the server bundle, the locale files and the manifest, and none of the sources or tests", () => {
    expect(files).toEqual([
      "README.md",
      "dist/server.cjs",
      "locales/en.json",
      "locales/sv.json",
      "package.json",
    ]);
  });

  it("passes the checks the catalog runs before it lists a plugin", () => {
    expect(
      pluginPackageProblems({
        packageJson,
        files,
        serverBundle: bundle,
        locales: { sv, en },
      }),
    ).toEqual([]);
  });

  it("requires nothing at run time but NestJS from the host", () => {
    const required = [...bundle.matchAll(/require\("([^"]+)"\)/g)].map(
      (match) => match[1],
    );
    expect([...new Set(required)]).toEqual(["@nestjs/common"]);
  });
});
