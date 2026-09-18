import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ActionErrorSpec } from "@openbrf/plugin-sdk";
import {
  FACTS_ACTION_ERRORS,
  MENU_ACTION_ERRORS,
  MOTION_ACTION_ERRORS,
  NEWS_ACTION_ERRORS,
  NEWS_COMMENT_ACTION_ERRORS,
  PAGE_ACTION_ERRORS,
} from "./action-errors";

/** Every list in the file, so a new one cannot be left out of a rule below. */
const EVERY_LIST = [
  PAGE_ACTION_ERRORS,
  NEWS_ACTION_ERRORS,
  MENU_ACTION_ERRORS,
  FACTS_ACTION_ERRORS,
  NEWS_COMMENT_ACTION_ERRORS,
  MOTION_ACTION_ERRORS,
];

/**
 * That every refusal a service can raise is published with the actions bound
 * to it.
 *
 * The failure this prevents is quiet. A service gains a refusal reason, the
 * screens get a sentence for it because the browser's map is typed over the
 * union, and the published contract does not - so a caller that is a model
 * meets an opaque code with no verdict, gives up on something it could have
 * fixed, or retries something that can never work. Read from the source's own
 * union rather than from a list kept beside it, because a list kept beside it
 * is the thing that would drift.
 */

// Relative to the package root, as site-boundary.spec.ts reads source: this
// package compiles to CommonJS, where import.meta is not available.
const API = join(process.cwd(), "src");
const REPO = join(process.cwd(), "..", "..");

/** The members of an exported string union, read from the source it lives in. */
function reasonsOf(path: string, name: string): string[] {
  const source = readFileSync(join(API, path), "utf8");
  const start = source.indexOf(`export type ${name} =`);
  expect(start, `${name} is not declared in ${path}`).toBeGreaterThan(-1);
  const declaration = source.slice(start, source.indexOf(";", start));
  return [...declaration.matchAll(/"([a-z-]+)"/g)].map(
    (match) => match[1] ?? "",
  );
}

function declared(specs: readonly ActionErrorSpec[]): string[] {
  return specs.map((entry) => entry.reason).sort();
}

describe("what a caller is told about a refusal", () => {
  it.each([
    [
      "pages",
      "site/pages-write.service.ts",
      "PageWriteReason",
      PAGE_ACTION_ERRORS,
    ],
    [
      "news",
      "news/news-write.service.ts",
      "NewsWriteReason",
      NEWS_ACTION_ERRORS,
    ],
    [
      "menu",
      "site/menu-write.service.ts",
      "MenuWriteReason",
      MENU_ACTION_ERRORS,
    ],
    [
      "the association's facts",
      "site/association-facts.service.ts",
      "AssociationFactsReason",
      FACTS_ACTION_ERRORS,
    ],
    [
      "a comment thread",
      "news/news-comment.error.ts",
      "NewsCommentReason",
      NEWS_COMMENT_ACTION_ERRORS,
    ],
    [
      "the motion queue",
      "motions/motion.error.ts",
      "MotionReason",
      MOTION_ACTION_ERRORS,
    ],
  ])("covers every reason %s can raise", (_name, path, union, specs) => {
    expect(declared(specs)).toEqual([...reasonsOf(path, union)].sort());
  });

  it("gives each refusal a verdict a caller can act on", () => {
    for (const specs of EVERY_LIST) {
      for (const entry of specs) {
        expect(["never", "after-edit", "after-backoff"]).toContain(entry.retry);
      }
    }
  });

  it("names a sentence that exists, in both languages", () => {
    // The board's own screens already show these. A second set written for
    // callers would be a second thing to keep true, and the first time the two
    // disagreed a person and a model would be told different stories about the
    // same refusal.
    const locales = ["sv", "en"].map((locale) =>
      JSON.parse(
        readFileSync(
          join(REPO, "packages/i18n/src/locales", `${locale}.json`),
          "utf8",
        ),
      ),
    );

    const read = (root: unknown, key: string): unknown =>
      key
        .split(".")
        .reduce<unknown>(
          (held, part) =>
            typeof held === "object" && held !== null
              ? (held as Record<string, unknown>)[part]
              : undefined,
          root,
        );

    for (const specs of EVERY_LIST) {
      for (const entry of specs) {
        for (const locale of locales) {
          expect(
            read(locale, entry.messageKey),
            `${entry.reason} -> ${entry.messageKey}`,
          ).toBeTypeOf("string");
        }
      }
    }
  });

  it("says a photograph consent can never be retried into", () => {
    // The confirmation is the board attesting that the consents exist, so it
    // is not an input an action may supply and no retry reaches past it.
    const consent = PAGE_ACTION_ERRORS.find(
      (entry) => entry.reason === "photo-consent-required",
    );
    expect(consent?.retry).toBe("never");
  });

  it("says a mailing that has gone out can never be retried into", () => {
    for (const reason of ["address-mailed", "already-mailed"]) {
      expect(
        NEWS_ACTION_ERRORS.find((entry) => entry.reason === reason)?.retry,
      ).toBe("never");
    }
  });

  it("says a comment written too fast is worth waiting out", () => {
    /*
     * The product's first `after-backoff`, and the reason the verdict exists.
     * `too-many-comments` answers 429 and is time-bounded - twenty comments per
     * ten minutes per author - so the answer changes on its own with nothing
     * the caller can send. A model told `never` would give up on a thread it
     * could have written to a minute later; one told `after-edit` would rewrite
     * a comment that was never the problem.
     */
    expect(
      NEWS_COMMENT_ACTION_ERRORS.find(
        (entry) => entry.reason === "too-many-comments",
      )?.retry,
    ).toBe("after-backoff");
  });

  it("says an issued notice can never be retried into", () => {
    // A general meeting cannot decide a matter its notice did not take up, so
    // once the notice has gone out nothing a caller sends puts an item on that
    // meeting or takes one off it.
    expect(
      MOTION_ACTION_ERRORS.find(
        (entry) => entry.reason === "meeting-notice-issued",
      )?.retry,
    ).toBe("never");
  });

  it("says an item another board member moved is worth reading again", () => {
    // The opposite case, and the one a verdict has to tell apart from it: the
    // motion is exactly as open as it was, and re-reading the queue and
    // deciding again is what a person does here.
    expect(
      MOTION_ACTION_ERRORS.find(
        (entry) => entry.reason === "meeting-changed-meanwhile",
      )?.retry,
    ).toBe("after-edit");
  });
});
