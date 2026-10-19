/**
 * How the code map reads a file: the names it exports, and what its
 * `@Module` declares.
 *
 * Run with `node --test` from `pnpm lint:guards`. A name the reading misses is
 * a definition the map says does not exist, which is the answer that gets a
 * helper written twice, so the cases are the shapes an export can take.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  declaredExports,
  isMappedSource,
  moduleEntryName,
  moduleOf,
  summaryAbove,
} from "./code-map.mjs";

test("each kind of declaration is read by its name, in order", () => {
  const source = [
    "export function plain() {}",
    "export async function waited() {}",
    "export function* generated() {}",
    "export class Service {}",
    "export abstract class Base {}",
    "export const LIMIT = 1;",
    "export let counter = 0;",
    "export type Row = { id: string };",
    "export interface View {}",
    "export enum Kind {}",
    "export const enum Flag {}",
    "export declare const DECLARED: string;",
  ].join("\n");
  assert.deepEqual(declaredExports(source), [
    "plain",
    "waited",
    "generated",
    "Service",
    "Base",
    "LIMIT",
    "counter",
    "Row",
    "View",
    "Kind",
    "Flag",
    "DECLARED",
  ]);
});

test("a name declared twice, as a schema and its type, is listed once", () => {
  assert.deepEqual(
    declaredExports(
      "export const Page = z.object({});\nexport type Page = z.infer<typeof Page>;",
    ),
    ["Page"],
  );
});

test("a re-export is listed where it is defined, not where it passes through", () => {
  const source = `
export {
  parsePersonalIdentityNumber,
  scanForPersonalIdentityNumbers,
} from "@openbrf/shared";
export type { PersonalIdentityNumberMatch } from "@openbrf/shared";
export * from "./browser.ts";
export const NORMALIZATION_VERSION = 2;`;
  assert.deepEqual(declaredExports(source), ["NORMALIZATION_VERSION"]);
});

test("a local export list is read by the names it exports", () => {
  const source = `
const zone = "Europe/Stockholm";
function inner() {}
export {
  // The one zone the client names.
  zone as ASSOCIATION_TIME_ZONE,
  type Row,
  inner,
};`;
  assert.deepEqual(declaredExports(source), [
    "ASSOCIATION_TIME_ZONE",
    "Row",
    "inner",
  ]);
});

test("a destructured declaration is read by the bindings it creates", () => {
  assert.deepEqual(
    declaredExports(
      "export const { signIn, signOut: leave, useSession = fallback } = client;",
    ),
    ["signIn", "leave", "useSession"],
  );
});

test("a default export is listed by its name, or as default without one", () => {
  assert.deepEqual(
    declaredExports("export default function SettingsRoute() {}"),
    ["SettingsRoute"],
  );
  assert.deepEqual(declaredExports("export default i18n;"), ["default"]);
});

test("a declaration whose name cannot be read fails rather than going missing", () => {
  assert.throws(
    () => declaredExports("export const [first, second] = pair;"),
    /cannot read the name this export declares: export const \[first/,
  );
});

test("a glob in a string does not hide the exports after it", () => {
  // A stripper that takes "/*" for the start of a block comment would remove
  // everything from the glob to the next "*/" it finds.
  const source = `
export const SOURCES = ["src/**/*.ts"];
export function after() {}
/** Documented. */
export const last = 1;`;
  assert.deepEqual(declaredExports(source), ["SOURCES", "after", "last"]);
});

test("an export that does not start a line is not a top-level export", () => {
  assert.deepEqual(
    declaredExports(
      "const template = `\n  export const generated = 1;\n`;\nexport const real = 1;",
    ),
    ["real"],
  );
});

test("suites and declaration files are left out of the map", () => {
  assert.equal(isMappedSource("feed.service.ts"), true);
  assert.equal(isMappedSource("Overview.tsx"), true);
  assert.equal(isMappedSource("feed.service.spec.ts"), false);
  assert.equal(isMappedSource("feed.int-spec.ts"), false);
  assert.equal(isMappedSource("Overview.test.tsx"), false);
  assert.equal(isMappedSource("i18next.d.ts"), false);
  assert.equal(isMappedSource("index.css"), false);
});

test("a module's entries read as the names they register", () => {
  assert.equal(moduleEntryName("FeedService"), "FeedService");
  assert.equal(moduleEntryName("forwardRef(() => AuthModule)"), "AuthModule");
  assert.equal(
    moduleEntryName("ConfigModule.forRoot({ isGlobal: true })"),
    "ConfigModule.forRoot()",
  );
  assert.equal(
    moduleEntryName("{ provide: APP_GUARD, useClass: PublicRateLimitGuard }"),
    "PublicRateLimitGuard as APP_GUARD",
  );
  assert.equal(
    moduleEntryName("{\n  provide: ENV,\n  useFactory: () => readEnv(),\n}"),
    "ENV",
  );
  assert.equal(moduleEntryName("...EXCEPTION_FILTERS"), "...EXCEPTION_FILTERS");
});

test("a summary is the first paragraph of the doc comment above", () => {
  const source = `import { Module } from "@nestjs/common";

/**
 * The feed: what is posted to the audiences somebody
 * is in (ADR 0026).
 *
 * It imports nothing.
 */
@Global()
@Module({})`;
  assert.equal(
    summaryAbove(source, source.indexOf("@Module(")),
    "The feed: what is posted to the audiences somebody is in (ADR 0026).",
  );
  assert.equal(summaryAbove('import x from "y";\n\n@Module({})', 19), null);
});

test("a module is read for its class, its arrays and whether it is global", () => {
  const source = `import { Module } from "@nestjs/common";

/** Charges to members. */
@Global()
@Module({
  imports: [AuditModule],
  controllers: [MemberChargesController],
  providers: [
    // Read by the purge as well.
    MemberChargeService,
    MemberChargePurgeService,
  ],
  exports: [MemberChargeService],
})
export class ChargesModule {}`;
  assert.deepEqual(moduleOf(source), {
    name: "ChargesModule",
    global: true,
    summary: "Charges to members.",
    imports: ["AuditModule"],
    controllers: ["MemberChargesController"],
    providers: ["MemberChargeService", "MemberChargePurgeService"],
    exports: ["MemberChargeService"],
  });
  assert.equal(moduleOf("export class Plain {}"), null);
});
