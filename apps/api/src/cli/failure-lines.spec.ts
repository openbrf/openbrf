import { beforeAll, describe, expect, it } from "vitest";

import { FALLBACK_LOCALE, I18nService } from "../i18n/i18n.service";
import type { PluginRecord } from "../plugins/plugin-registry.service";
import { failureLines } from "./failure-lines";

/**
 * What `openbrf plugin list` prints for a failed install.
 *
 * The sentence the admin screen shows, from the same translations, and the
 * English the server threw beneath it - and for a row from before failures
 * carried a code, that English alone, as it was always printed.
 */

const i18n = new I18nService();

beforeAll(async () => {
  await i18n.init();
});

function record(overrides: Partial<PluginRecord>): PluginRecord {
  return {
    lastError: null,
    failure: null,
    ...overrides,
  } as PluginRecord;
}

describe("failureLines", () => {
  const t = () => i18n.translatorFor(FALLBACK_LOCALE);

  it("prints nothing for a row that did not fail", () => {
    expect(failureLines(record({}), t())).toEqual([]);
  });

  it("prints the sentence and then what was thrown", () => {
    const lines = failureLines(
      record({
        lastError:
          "PluginInstallError: The plugin downloads used their 480000 ms before this one could start.",
        failure: {
          reason: "download-budget-spent",
          detail: { budgetMs: 480_000 },
        },
      }),
      t(),
    );

    expect(lines).toEqual([
      "  last error   The run's downloads had used up their 480 seconds before this plugin's turn came, so it was not downloaded. Installing again starts a new run.",
      "  cause        PluginInstallError: The plugin downloads used their 480000 ms before this one could start.",
    ]);
  });

  it("prints a row from before failures carried a code as it stands", () => {
    const lines = failureLines(
      record({ lastError: "Error: Digest mismatch: the catalog declares ..." }),
      t(),
    );

    expect(lines).toEqual([
      "  last error   Error: Digest mismatch: the catalog declares ...",
    ]);
  });

  it("keeps what an archive named off the terminal's controls", () => {
    const held = "\u001b]0;pwned\u0007x\n  status       installed";
    const lines = failureLines(
      record({
        lastError: `PluginInstallError: The archive for @acme/booking@1.0.0 holds ${held}@1.0.0.`,
        failure: {
          reason: "archive-package-mismatch",
          detail: {
            packageName: "@acme/booking",
            version: "1.0.0",
            heldName: held,
            heldVersion: "1.0.0",
          },
        },
      }),
      t(),
    );

    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).not.toMatch(/\p{Cc}/u);
    }
    expect(lines[0]).toContain("\\x1b]0;pwned\\x07x\\n  status");
  });
});
