import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The public website's import boundary, as a test rather than as a convention.
 *
 * Nothing under src/site may import from the statutory registers, the address
 * book or the encryption layer. That is not a style rule: it is what makes "no
 * stored page can reach the register" a property of the module graph. A page's
 * body is written by a board member, and the argument that it cannot carry a
 * resident's personal identity number onto the street rests on there being no
 * path from this directory to the data at all.
 *
 * Asserted on the source rather than on a rendered page, because a rendering
 * test can only show that today's pages carry nothing. This shows that
 * tomorrow's cannot.
 *
 * What it does not say is that nothing here ever reaches a service which
 * decrypts. The public forms take a name and an address from the person filling
 * them in, and the services that store those - in src/contact and src/issues -
 * encrypt them like every other contact detail. A file here may call one of
 * those. The rule is about the direction: this directory may hand a stranger's
 * own details onward, and may not read the association's registers, which is
 * what the list below names.
 */

/*
 * Resolved from the package root rather than from this file's own location:
 * the API builds to CommonJS, where import.meta is not available. The second
 * assertion below is what makes a wrong path fail loudly instead of turning
 * this suite into one that checks nothing.
 */
const SITE_DIRECTORY = join(process.cwd(), "src", "site");

const FORBIDDEN = ["registers", "address-book", "crypto"] as const;

/**
 * The files the boundary is about: the ones that run in production.
 *
 * A suite is not part of the rendering path and legitimately reaches for the
 * encryption layer to arrange a person to sign in as. What matters is that no
 * file the server actually loads can.
 */
function isBoundedSource(name: string): boolean {
  return /\.tsx?$/.test(name) && !/\.(spec|int-spec)\.tsx?$/.test(name);
}

/**
 * Every production file under the directory, however deep it sits.
 *
 * A walk rather than one listing, because the boundary is about the module
 * graph and not about a directory: the day somebody groups the block types into
 * src/site/blocks, a check that read only the top level would keep passing
 * while covering none of them.
 */
function boundedSources(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...boundedSources(path));
    } else if (entry.isFile() && isBoundedSource(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

/**
 * Whether a source reaches one of the forbidden directories.
 *
 * Matched against the specifier rather than against one spelling of it. A file
 * a directory down writes "../../crypto/field-encryption.service", and an
 * import of the directory itself - which a barrel file would make resolvable -
 * ends at the name with no trailing slash. Both are the import this refuses,
 * and a name that merely starts with a forbidden one is not.
 */
function reaches(source: string, forbidden: string): boolean {
  return new RegExp(
    String.raw`["'](?:\.\./)+${forbidden}(?:/[^"']*)?["']`,
  ).test(source);
}

describe("the site module's imports", () => {
  it("reach neither the registers, the address book nor the encryption layer", () => {
    const offenders: string[] = [];

    for (const path of boundedSources(SITE_DIRECTORY)) {
      const source = readFileSync(path, "utf8");
      for (const forbidden of FORBIDDEN) {
        if (reaches(source, forbidden)) {
          offenders.push(`${relative(SITE_DIRECTORY, path)} -> ${forbidden}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("is asserted over a directory that actually has files in it", () => {
    // Without this, a rename of the directory would turn the check above into a
    // test that passes because it looked at nothing.
    expect(boundedSources(SITE_DIRECTORY).length).toBeGreaterThan(5);
  });
});
