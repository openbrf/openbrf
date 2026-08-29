import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

describe("the site module's imports", () => {
  it("reach neither the registers, the address book nor the encryption layer", () => {
    const offenders: string[] = [];

    for (const entry of readdirSync(SITE_DIRECTORY, { withFileTypes: true })) {
      if (!entry.isFile() || !isBoundedSource(entry.name)) {
        continue;
      }
      const source = readFileSync(join(SITE_DIRECTORY, entry.name), "utf8");
      for (const forbidden of FORBIDDEN) {
        // Both spellings a relative import can take from this directory.
        if (
          source.includes(`"../${forbidden}/`) ||
          source.includes(`'../${forbidden}/`)
        ) {
          offenders.push(`${entry.name} -> ${forbidden}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("is asserted over a directory that actually has files in it", () => {
    // Without this, a rename of the directory would turn the check above into a
    // test that passes because it looked at nothing.
    expect(
      readdirSync(SITE_DIRECTORY).filter(isBoundedSource).length,
    ).toBeGreaterThan(5);
  });
});
