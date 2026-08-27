import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildThemeStylesheet, PORTTAVLAN } from "@openbrf/tokens";
import { describe, expect, it } from "vitest";

/**
 * The default theme's CSS is committed rather than built, so the browser gets
 * the values in its first stylesheet and never flashes unstyled. That only
 * holds if the committed file actually matches the contract, which is what
 * this test guarantees.
 *
 * If this fails, a token value changed without the file being regenerated:
 *
 *   pnpm --filter @openbrf/web theme:generate
 */
describe("the committed theme stylesheet", () => {
  const path = join(import.meta.dirname, "porttavlan.generated.css");
  const committed = readFileSync(path, "utf8");

  it("matches what the token contract produces", () => {
    const expected = buildThemeStylesheet(PORTTAVLAN);

    // Compared on the declarations rather than the whole file so the header
    // comment can be edited without failing the test.
    expect(committed).toContain(expected);
  });

  it("still carries its do-not-edit header", () => {
    expect(committed).toContain("GENERATED FILE");
    expect(committed).toContain("theme:generate");
  });
});
