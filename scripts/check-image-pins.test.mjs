/**
 * How the image-pin check reads a reference and when it refuses.
 *
 * Run with `node --test` from `pnpm lint:guards`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  disagreements,
  fromImagesOf,
  fromLineCount,
  pinsOf,
  semgrepFailures,
  semgrepImageOf,
} from "./check-image-pins.mjs";

const DIGEST = `sha256:${"a".repeat(64)}`;
const OTHER = `sha256:${"b".repeat(64)}`;
const PIN = `postgres:18-alpine@${DIGEST}`;

test("the registry in front of a reference is not part of its pin", () => {
  for (const image of [
    PIN,
    `public.ecr.aws/docker/library/${PIN}`,
    `docker.io/library/${PIN}`,
  ]) {
    assert.deepEqual(pinsOf(`    image: ${image}\n`, "postgres"), [PIN]);
  }
});

test("a comment, another image and an image without a digest are not pins", () => {
  const source = [
    `# image: ${PIN}`,
    `    image: postgres:18-alpine`,
    `    image: ghcr.io/axllent/mailpit:v1@${DIGEST}`,
    `    image: mypostgres:18-alpine@${DIGEST}`,
  ].join("\n");
  assert.deepEqual(pinsOf(source, "postgres"), []);
});

test("files that agree on the pin raise nothing", () => {
  assert.deepEqual(
    disagreements(
      new Map([
        ["a.yml", [PIN]],
        ["b.yml", [PIN]],
      ]),
    ),
    [],
  );
});

test("a different digest in one file is refused", () => {
  const failures = disagreements(
    new Map([
      ["a.yml", [PIN]],
      ["b.yml", [`postgres:18-alpine@${OTHER}`]],
    ]),
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /not the same in every file/);
});

test("a file with no pin in it is refused rather than skipped", () => {
  const failures = disagreements(
    new Map([
      ["a.yml", [PIN]],
      ["b.yml", []],
    ]),
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /b\.yml names no Postgres image/);
});

const SEMGREP = `semgrep/semgrep:1.179.0@${DIGEST}`;

test("the image of a FROM line is read without its flags, alias or comments", () => {
  const source = [
    `# FROM ignored:1@${DIGEST}`,
    `FROM --platform=linux/amd64 ${SEMGREP} AS scan`,
    "from alpine:3",
  ].join("\n");
  assert.deepEqual(fromImagesOf(source), [SEMGREP, "alpine:3"]);
});

test("a flag on a FROM line with no image after it is not read as the image", () => {
  assert.deepEqual(fromImagesOf("FROM --platform=linux/amd64\n"), []);
});

test("one FROM line pinned by digest raises nothing", () => {
  assert.deepEqual(semgrepFailures(fromImagesOf(`FROM ${SEMGREP}\n`)), []);
});

test("a FROM line without a digest is refused", () => {
  for (const image of [
    "semgrep/semgrep:1.179.0",
    "semgrep/semgrep",
    "semgrep/semgrep@sha256:abc",
  ]) {
    const failures = semgrepFailures(fromImagesOf(`FROM ${image}\n`));
    assert.equal(failures.length, 1);
    assert.match(failures[0], /not pinned by digest/);
  }
});

test("no FROM line, or a second one, is refused", () => {
  for (const images of [[], [SEMGREP, SEMGREP]]) {
    const failures = semgrepFailures(images);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /exactly one FROM/);
  }
});

test("a FROM line that names no image still counts as a FROM line", () => {
  const source = `FROM ${SEMGREP}\nFROM --platform=linux/amd64\n`;
  assert.equal(fromLineCount(source), 2);
  assert.equal(fromLineCount(`# FROM x\nFROM ${SEMGREP}\n`), 1);
  const failures = semgrepFailures(fromImagesOf(source), fromLineCount(source));
  assert.equal(failures.length, 1);
  assert.match(failures[0], /exactly one FROM/);
});

test("a FROM line in any accepted form yields exactly the pinned reference", () => {
  for (const line of [
    `FROM ${SEMGREP}`,
    `FROM ${SEMGREP} AS scan`,
    `FROM ${SEMGREP} as scan`,
    `FROM --platform=linux/amd64 ${SEMGREP}`,
    `FROM --platform=linux/amd64 ${SEMGREP} AS scan`,
    `FROM\t${SEMGREP}`,
    `from  ${SEMGREP}\t`,
    `  FROM ${SEMGREP}`,
  ]) {
    assert.equal(semgrepImageOf(`# comment\n${line}\n`), SEMGREP, line);
    assert.equal(semgrepImageOf(`# comment\r\n${line}\r\n`), SEMGREP, line);
    assert.equal(semgrepImageOf(line), SEMGREP, line);
  }
});

test("a Dockerfile the workflow cannot trust yields no image", () => {
  for (const source of [
    "",
    "# FROM only in a comment\n",
    "FROM\n",
    "FROM --platform=linux/amd64\n",
    `FROM ${SEMGREP}\nFROM ${SEMGREP}\n`,
    `FROM ${SEMGREP}\nFROM alpine:3\n`,
    "FROM semgrep/semgrep:1.179.0\n",
    `FROM semgrep/semgrep@${DIGEST}\n`,
    `FROM other/semgrep:1.179.0@${DIGEST}\n`,
    `FROM evil/semgrep/semgrep:1.179.0@${DIGEST}\n`,
    `FROM semgrep/semgrep-pro:1.179.0@${DIGEST}\n`,
    `FROM semgrep/semgrep:1.179.0@${DIGEST}extra\n`,
    `FROM ${SEMGREP}\\\n  AS scan\n`,
  ]) {
    assert.throws(() => semgrepImageOf(source), Error, JSON.stringify(source));
  }
});

test("an image from another repository is refused even with a digest", () => {
  const failures = semgrepFailures([`alpine:3@${DIGEST}`]);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /not a semgrep\/semgrep image/);
});
