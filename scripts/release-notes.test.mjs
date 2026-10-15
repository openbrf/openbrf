/**
 * The release notes for one version of the platform, gathered from the
 * changelog of every package in the fixed group.
 *
 * Run with `node --test` from `pnpm lint:guards`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { BODY_LIMIT, releaseBody, releaseNotes } from "./release-notes.mjs";

/** The shape `changeset version` writes, for two packages of one release. */
const API_CHANGELOG = `# @openbrf/api

## 0.2.0

### Minor Changes

- 1a2b3c4: Publish the platform as a container image.

  An instance names its version when it starts.

- 5d6e7f8: Let an operator size the connection pool.

### Patch Changes

- 9a8b7c6: Refuse a runtime role name PostgreSQL reserves.
- Updated dependencies [1a2b3c4]
  - @openbrf/shared@0.2.0

## 0.1.0

### Minor Changes

- 0f0f0f0: The first release.
`;

const WEB_CHANGELOG = `# @openbrf/web

## 0.2.0

### Minor Changes

- 1a2b3c4: Publish the platform as a container image.

  An instance names its version when it starts.

### Patch Changes

- 3c3c3c3: Show the booking screen's retry after a failed read.
- Updated dependencies [1a2b3c4]
  - @openbrf/i18n@0.2.0
  - @openbrf/shared@0.2.0

## 0.1.0

### Minor Changes

- 0f0f0f0: The first release.
`;

const CHANGELOGS = [
  { name: "@openbrf/api", text: API_CHANGELOG },
  { name: "@openbrf/web", text: WEB_CHANGELOG },
];

/** The fixed group, of which the two changelogs above are a part. */
const GROUP = [
  "@openbrf/api",
  "@openbrf/web",
  "@openbrf/i18n",
  "@openbrf/shared",
];

test("an entry two packages share is given once", () => {
  const notes = releaseNotes("0.2.0", CHANGELOGS);

  assert.equal(
    notes.split("Publish the platform as a container image.").length - 1,
    1,
  );
  // The whole entry, its second paragraph included.
  assert.match(notes, /An instance names its version when it starts\./);
});

test("an entry only one package carries is kept", () => {
  // Several changesets name the web client alone, so notes read from one
  // package's changelog would drop them.
  const notes = releaseNotes("0.2.0", CHANGELOGS);

  assert.match(notes, /Show the booking screen's retry after a failed read\./);
  assert.match(notes, /Let an operator size the connection pool\./);
});

test("the dependency bumps inside the group are left out", () => {
  const notes = releaseNotes("0.2.0", CHANGELOGS, GROUP);

  assert.doesNotMatch(notes, /Updated dependencies/);
  assert.doesNotMatch(notes, /@openbrf\/shared@0\.2\.0/);
});

test("a bump of a package outside the group is kept, once", () => {
  // A change to the design tokens alone bumps the platform too, and without
  // this line its notes would say nothing changed.
  const bump = (name, commit) =>
    `# ${name}\n\n## 0.2.1\n\n### Patch Changes\n\n` +
    `- Updated dependencies [${commit}]\n` +
    "  - @openbrf/tokens@0.3.0\n  - @openbrf/shared@0.2.1\n";
  const notes = releaseNotes(
    "0.2.1",
    [
      { name: "@openbrf/api", text: bump("@openbrf/api", "1a2b3c4") },
      { name: "@openbrf/web", text: bump("@openbrf/web", "5d6e7f8") },
    ],
    GROUP,
  );

  assert.equal(
    notes,
    "## Patch Changes\n\n- Updated dependencies\n  - @openbrf/tokens@0.3.0\n",
  );
});

test("minor entries come before patch entries", () => {
  const notes = releaseNotes("0.2.0", CHANGELOGS);

  const minor = notes.indexOf("Let an operator size the connection pool.");
  const patch = notes.indexOf(
    "Refuse a runtime role name PostgreSQL reserves.",
  );
  assert.ok(minor !== -1 && patch !== -1 && minor < patch, notes);
});

test("only the version asked for is read", () => {
  const notes = releaseNotes("0.2.0", CHANGELOGS);

  assert.doesNotMatch(notes, /The first release\./);
});

test("a package in the group with no section for the version fails", () => {
  // Every package in a fixed group is released together, so a missing section
  // is a changelog that was not generated for this version, not a quiet one.
  assert.throws(
    () =>
      releaseNotes("0.3.0", [
        ...CHANGELOGS,
        { name: "@openbrf/i18n", text: "# @openbrf/i18n\n\n## 0.1.0\n" },
      ]),
    /@openbrf\/api has no section for 0\.3\.0/,
  );
  assert.throws(
    () =>
      releaseNotes("0.2.0", [
        ...CHANGELOGS,
        { name: "@openbrf/i18n", text: "# @openbrf/i18n\n\n## 0.1.0\n" },
      ]),
    /@openbrf\/i18n has no section for 0\.2\.0/,
  );
});

/** The characters GitHub counts, not UTF-16 code units. */
const characters = (text) => [...text].length;

/**
 * A changelog for 0.2.0 with the given number of entries under each heading,
 * each about 500 characters of Swedish text and an emoji, which is two UTF-16
 * code units and one character. Each is named for its heading and place.
 */
function longChangelog(name, headings) {
  const sections = Object.entries(headings).map(
    ([heading, count]) =>
      `### ${heading}\n\n` +
      Array.from(
        { length: count },
        (_, index) =>
          `- ${name.slice(-3)}-${heading[0]}${index}: Åtgärda bokningen 🎉 ${"å".repeat(450)}\n`,
      ).join("\n"),
  );
  return {
    name,
    text: `# ${name}\n\n## 0.2.0\n\n${sections.join("\n")}`,
    directory: `packages/${name.split("/")[1]}`,
  };
}

/** Fifteen entries: major first, then minor, then patch. */
const LONG = [
  longChangelog("@openbrf/api", { "Minor Changes": 4, "Patch Changes": 5 }),
  longChangelog("@openbrf/web", { "Major Changes": 2, "Patch Changes": 4 }),
];
const LIMIT = 4000;

/** The entries of some notes, in order. */
const entriesOf = (markdown) =>
  markdown.split("\n").filter((line) => line.startsWith("- "));

test("a body that fits is the notes, unchanged", () => {
  const notes = releaseNotes("0.2.0", CHANGELOGS, GROUP);

  assert.equal(releaseBody("0.2.0", CHANGELOGS, GROUP), notes);
  // Exactly at the limit still fits.
  assert.equal(
    releaseBody("0.2.0", CHANGELOGS, GROUP, characters(notes)),
    notes,
  );
});

test("a body over the limit is within it and keeps whole entries only", () => {
  const notes = releaseNotes("0.2.0", LONG);
  assert.ok(characters(notes) > LIMIT);

  const body = releaseBody("0.2.0", LONG, undefined, LIMIT);

  assert.ok(characters(body) <= LIMIT, String(characters(body)));
  // The notes' own first entries, none cut short.
  const kept = entriesOf(body);
  assert.ok(kept.length > 0 && kept.length < entriesOf(notes).length);
  assert.deepEqual(kept, entriesOf(notes).slice(0, kept.length));
  // As many as fit: one more would not have.
  assert.ok(
    characters(releaseBody("0.2.0", LONG, undefined, LIMIT + 600)) >
      characters(body),
  );
});

test("a trimmed body keeps the sections in the order of the notes", () => {
  const body = releaseBody("0.2.0", LONG, undefined, LIMIT);

  assert.match(
    body,
    /^## Major Changes\n[^]*\n## Minor Changes\n[^]*\n## Patch Changes\n/,
  );
  // The patch entries come last, so the first ones left out are patches.
  assert.match(entriesOf(body).at(-1), /^- \w+-P\d+:/);
});

test("a heading none of whose entries fit is left out", () => {
  const body = releaseBody("0.2.0", LONG, undefined, 1500);

  assert.match(body, /^## Major Changes\n/);
  assert.doesNotMatch(body, /^## (Minor|Patch) Changes$/m);
});

test("a trimmed body ends with the number left out and every changelog", () => {
  const body = releaseBody("0.2.0", LONG, undefined, LIMIT);
  const closing = body.trimEnd().split("\n").at(-1);

  const left = 15 - entriesOf(body).length;
  assert.ok(closing.startsWith(`${left} of 15 entries are left out`), closing);
  assert.ok(closing.includes("release-notes-0.2.0.md"), closing);
  for (const directory of ["api", "web"]) {
    assert.ok(
      closing.includes(
        `(https://github.com/openbrf/openbrf/blob/v0.2.0/packages/${directory}/CHANGELOG.md)`,
      ),
      closing,
    );
  }
});

test("the limit counts characters, not UTF-16 code units", () => {
  const body = releaseBody("0.2.0", LONG, undefined, LIMIT);

  assert.ok(characters(body) <= LIMIT);
  // Each kept entry has an emoji, so counted as code units it would be over.
  assert.ok(body.length > characters(body));
});

test("a limit no entry fits in leaves only the closing line", () => {
  const body = releaseBody("0.2.0", LONG, undefined, 600);

  assert.doesNotMatch(body, /^## /m);
  assert.ok(body.startsWith("15 of 15 entries are left out"), body);
});

test("the default limit leaves a margin under the 125,000 GitHub refuses", () => {
  assert.ok(BODY_LIMIT <= 120_000);
});
