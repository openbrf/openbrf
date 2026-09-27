/**
 * The release notes for one version of the platform, gathered from the
 * changelog of every package in the fixed group.
 *
 * Run with `node --test` from `pnpm lint:guards`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { releaseNotes } from "./release-notes.mjs";

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
