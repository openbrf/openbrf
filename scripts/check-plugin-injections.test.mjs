/**
 * How the root-injector check reads a module: whether it is global, and what
 * it exports.
 *
 * Run with `node --test` from `pnpm lint:guards`. A name this reading misses
 * is a provider no list classifies and a plugin can ask for, so the cases are
 * the shapes an export can take that a reading of the first array up to its
 * first `]` would drop.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  exportedNames,
  isGlobal,
  withoutComments,
} from "./check-plugin-injections.mjs";

test("the identifiers of one exports array are read in order", () => {
  assert.deepEqual(
    exportedNames("@Module({ providers: [A], exports: [AuthService, ENV,] })"),
    { names: ["AuthService", "ENV"], unreadable: [] },
  );
});

test("every exports array is read, not only the first", () => {
  const source = `
    @Global()
    @Module({ providers: [A], exports: [A] })
    export class AuthModule {
      static forRoot() {
        return { module: AuthModule, providers: [B], exports: [B] };
      }
    }`;
  assert.deepEqual(exportedNames(source), {
    names: ["A", "B"],
    unreadable: [],
  });
});

test("an array nested in the exports does not end them", () => {
  assert.deepEqual(exportedNames("@Module({ exports: [A, ...[B], C] })"), {
    names: ["A", "C"],
    unreadable: ["...[B]"],
  });
});

test("a spread is unreadable rather than dropped", () => {
  assert.deepEqual(exportedNames("@Module({ exports: [...AUTH_PROVIDERS] })"), {
    names: [],
    unreadable: ["...AUTH_PROVIDERS"],
  });
});

test("a provider object is one unreadable entry, commas and all", () => {
  assert.deepEqual(
    exportedNames(
      "@Module({ exports: [{ provide: TOKEN, useFactory: () => [1, 2] }, D] })",
    ),
    {
      names: ["D"],
      unreadable: ["{ provide: TOKEN, useFactory: () => [1, 2] }"],
    },
  );
});

test("exports that are not an array literal are unreadable", () => {
  assert.deepEqual(exportedNames("@Module({ exports: AUTH_EXPORTS })"), {
    names: [],
    unreadable: ["exports: AUTH_EXPORTS"],
  });
});

test("an exports array in a comment is not read", () => {
  assert.deepEqual(
    exportedNames(
      withoutComments(
        "// exports: [Hidden]\n/* exports: [Gone] */\n@Module({ exports: [Seen] })",
      ),
    ),
    { names: ["Seen"], unreadable: [] },
  );
});

test("a module decorated @Global() is global", () => {
  assert.equal(isGlobal("@Global()\n@Module({ exports: [A] })"), true);
});

test("a dynamic module returned with global: true is global", () => {
  assert.equal(
    isGlobal(
      "static forRoot() { return { module: M, global: true, exports: [A] }; }",
    ),
    true,
  );
});

test("a module that is neither is not global", () => {
  assert.equal(
    isGlobal(
      "static forRoot() { return { module: M, global: false, exports: [A] }; }",
    ),
    false,
  );
});
