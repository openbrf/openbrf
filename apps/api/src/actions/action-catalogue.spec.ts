import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ActionDefinition } from "@openbrf/plugin-sdk";
import { ACTION_NAME_PATTERN } from "@openbrf/plugin-sdk";
import { describe, expect, it, vi } from "vitest";

import { CAPABILITIES } from "../authorization/capabilities";
import { REQUIRED_CAPABILITIES } from "../authorization/require-capability.decorator";
import { MenuAdminController } from "../site/menu-admin.controller";
import { NewsAdminController } from "../news/news-admin.controller";
import { PagesAdminController } from "../site/pages-admin.controller";
import type { PrincipalService } from "../authorization/principal.service";
import type { Env } from "../config/env";
import type { I18nService } from "../i18n/i18n.service";
import { NewsActionsRegistrar } from "../news/news-actions.registrar";
import { SiteActionsRegistrar } from "../site/site-actions.registrar";
import { ActionCallerFactory } from "./action-caller";
import { ActionRegistryService } from "./action-registry.service";
import { CoreActionRegistrar } from "./action-registrar";
import {
  DENIED_ACTION_CAPABILITIES,
  DENIED_ACTION_SERVICES,
  DENIED_NAME_PATTERNS,
} from "./action-denylist";

/**
 * Every rule the first slice must obey, asserted over the catalogue itself
 * rather than over each definition as it is written.
 *
 * The difference matters. A rule checked where an action is declared is a rule
 * the twenty-fifth action can be written without; a rule checked over the
 * registered set is one a new action cannot be added past. Several of these are
 * Beslutslogg decisions in code, and the whole point is that they hold for
 * whatever the catalogue grows into.
 */

const LOCALES = ["sv", "en"] as const;

function locale(name: (typeof LOCALES)[number]): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      join(
        process.cwd(),
        "..",
        "..",
        "packages/i18n/src/locales",
        `${name}.json`,
      ),
      "utf8",
    ),
  ) as Record<string, unknown>;
}

function lookUp(root: unknown, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (held, part) =>
        typeof held === "object" && held !== null
          ? (held as Record<string, unknown>)[part]
          : undefined,
      root,
    );
}

/**
 * Every action the two core registrars put into a real registry, and the
 * registry itself.
 *
 * The registry comes back because some rules are about the PUBLISHED document
 * rather than about the definition: only `inputJsonSchema` can answer what a
 * caller actually reads, and a schema object is not it.
 */
function catalogueWithRegistry(): {
  registry: ActionRegistryService;
  actions: ActionDefinition[];
} {
  const registry = new ActionRegistryService(
    new ActionCallerFactory(),
    { forPerson: vi.fn(async () => null) } as unknown as PrincipalService,
    { translatorFor: () => (key: string) => key } as unknown as I18nService,
    { OPENBRF_ACTIONS_READ_ONLY: false } as unknown as Env,
  );
  const registrar = new CoreActionRegistrar(registry);

  const service = (): never => {
    throw new Error("A contract test never calls a service.");
  };
  new SiteActionsRegistrar(
    service as never,
    service as never,
    registrar,
  ).onModuleInit();
  new NewsActionsRegistrar(service as never, registrar).onModuleInit();

  const held: ActionDefinition[] = [];
  for (const name of NAMES) {
    const action = registry.get(name);
    expect(action, `${name} was not registered`).not.toBeNull();
    if (action !== null) {
      held.push(action.definition);
    }
  }
  return { registry, actions: held };
}

function catalogue(): ActionDefinition[] {
  return catalogueWithRegistry().actions;
}

/**
 * The twenty-four, written out.
 *
 * Exposure is opt-in, so the set is pinned rather than read back from the
 * registry: a test that asked the registry what it holds would pass for
 * whatever the registry held, and what needs asserting is that this list and
 * that one are the same.
 */
const NAMES = [
  "news_list",
  "news_get",
  "news_create",
  "news_update",
  "news_publish",
  "news_unpublish",
  "news_set_visibility",
  "news_delete",
  "news_request_mailing",
  "page_list",
  "page_get",
  "page_create",
  "page_update",
  "page_publish",
  "page_unpublish",
  "page_set_visibility",
  "page_reorder",
  "page_delete",
  "menu_list",
  "menu_generated_keys",
  "menu_create",
  "menu_update",
  "menu_reorder",
  "menu_remove",
] as const;

describe("what the first slice offers", () => {
  it("is exactly these twenty-four actions", () => {
    expect(
      catalogue()
        .map((action) => action.name)
        .sort(),
    ).toEqual([...NAMES].sort());
  });
});

describe("what every action must declare", () => {
  const actions = catalogue();

  it.each(actions.map((action) => [action.name, action] as const))(
    "%s is named, capable and described",
    (_name, action) => {
      expect(ACTION_NAME_PATTERN.test(action.name)).toBe(true);
      expect(CAPABILITIES as readonly string[]).toContain(action.capability);
      for (const key of [
        action.titleKey,
        action.descriptionKey,
        action.groupTitleKey,
      ]) {
        for (const name of LOCALES) {
          expect(lookUp(locale(name), key), `${key} in ${name}`).toBeTypeOf(
            "string",
          );
        }
      }
    },
  );

  it.each(actions.map((action) => [action.name, action] as const))(
    "%s says what it does not do, in both languages",
    (_name, action) => {
      // Three or four sentences: what it does, what it explicitly does not do,
      // its preconditions, and - where it returns stored text - that the text
      // is data rather than instructions.
      for (const name of LOCALES) {
        const description = lookUp(locale(name), action.descriptionKey);
        expect(typeof description).toBe("string");
        const sentences = String(description).split(". ").length;
        expect(sentences, `${action.name} in ${name}`).toBeGreaterThanOrEqual(
          3,
        );
        expect(sentences, `${action.name} in ${name}`).toBeLessThanOrEqual(4);
      }
    },
  );
});

describe("the denylist, which is Beslutslogg 64 in code", () => {
  const actions = catalogue();

  it("declares no capability by which authority moves", () => {
    for (const action of actions) {
      expect(
        DENIED_ACTION_CAPABILITIES as readonly string[],
        `${action.name} declares ${action.capability}`,
      ).not.toContain(action.capability);
    }
  });

  it("names no act that moves a residency, a role or a plugin", () => {
    for (const action of actions) {
      expect(
        DENIED_NAME_PATTERNS.test(action.name),
        `${action.name} names a forbidden act`,
      ).toBe(false);
    }
  });

  it("binds no handler to a service that writes a statutory register", () => {
    // The half a name pattern cannot do: an action called update_household
    // walks past any regex and into the member register.
    const source = [
      "src/site/site-actions.registrar.ts",
      "src/news/news-actions.registrar.ts",
    ].map((path) => readFileSync(join(process.cwd(), path), "utf8"));
    for (const denied of DENIED_ACTION_SERVICES) {
      for (const text of source) {
        expect(text, `a registrar reaches ${denied}`).not.toContain(denied);
      }
    }
  });
});

describe("what an input may never ask a caller to assert", () => {
  it("carries no consent attestation and no mailing flag", () => {
    /*
     * Two different refusals that look alike. photoConsentConfirmed is the
     * board declaring the publication consents exist for identifiable people
     * in a picture - an attestation a person makes, not a field a caller
     * fills - and sendEmail/sendSms reach the members in a way that cannot be
     * recalled. A strict input answers 400 to a caller that invents any of
     * them, which is exactly the point: the document never offered it.
     */
    /*
     * Read out of the registry rather than off the definition. `action.input`
     * is the zod object, and serialising one says nothing reliable about the
     * keys it declares - so a catalogue that did offer one of these three could
     * have passed. `inputJsonSchema` is the document a caller is actually
     * handed, which is where the promise has to hold.
     */
    const { registry, actions } = catalogueWithRegistry();
    for (const action of actions) {
      const document = JSON.stringify(registry.inputJsonSchema(action.name));
      for (const forbidden of [
        "photoConsentConfirmed",
        "sendEmail",
        "sendSms",
      ]) {
        expect(document, `${action.name} offers ${forbidden}`).not.toContain(
          forbidden,
        );
      }
    }
  });
});

describe("the annotations a client decides with", () => {
  const actions = catalogue();

  it("says a read changes nothing and can be repeated", () => {
    for (const action of actions.filter((held) => held.effect === "read")) {
      expect(action.idempotent, action.name).toBe(true);
      expect(action.needsConfirmation, action.name).toBe(false);
    }
  });

  it("says a delete needs answering for first", () => {
    // The one effect with no undo. A client uses this to decide whether to ask
    // the person before calling.
    for (const action of actions.filter((held) => held.effect === "delete")) {
      expect(action.needsConfirmation, action.name).toBe(true);
    }
  });

  it("marks as additive only what overwrites nothing a person wrote", () => {
    const additive = actions
      .filter((action) => action.additive)
      .map((action) => action.name)
      .sort();
    expect(additive).toEqual(["menu_create", "news_create", "page_create"]);
  });

  it("reaches no system outside this instance", () => {
    for (const action of actions) {
      expect(action.openWorld, action.name).toBe(false);
    }
  });

  it("offers nothing to the AI package, which does not exist yet", () => {
    for (const action of actions) {
      expect(action.surfaces, action.name).not.toContain("ai");
    }
  });
});

describe("what a caller is told about a refusal", () => {
  it("publishes a verdict for every refusal the handler can raise", () => {
    for (const action of catalogue()) {
      expect(action.errors.length, action.name).toBeGreaterThan(0);
      for (const spec of action.errors) {
        expect(["never", "after-edit", "after-backoff"]).toContain(spec.retry);
      }
    }
  });
});

describe("the document a caller actually reads", () => {
  const registry = new ActionRegistryService(
    new ActionCallerFactory(),
    { forPerson: vi.fn(async () => null) } as unknown as PrincipalService,
    { translatorFor: () => (key: string) => key } as unknown as I18nService,
    { OPENBRF_ACTIONS_READ_ONLY: false } as unknown as Env,
  );
  const registrar = new CoreActionRegistrar(registry);
  const service = (): never => {
    throw new Error("A contract test never calls a service.");
  };
  new SiteActionsRegistrar(
    service as never,
    service as never,
    registrar,
  ).onModuleInit();
  new NewsActionsRegistrar(service as never, registrar).onModuleInit();

  it.each([...NAMES])("%s describes every field it asks for", (name) => {
    // An undescribed property is a guess for a caller that is a model, and a
    // guess on a write is a page rewritten from one.
    const described = (
      document: Record<string, unknown>,
      path: readonly string[] = [],
    ): void => {
      const properties = document.properties;
      if (typeof properties !== "object" || properties === null) {
        return;
      }
      for (const [key, value] of Object.entries(properties)) {
        const held = value as Record<string, unknown>;
        const where = [...path, key].join(".");
        // A branch of a union describes itself through its branches.
        const isUnion = Array.isArray(held.oneOf) || Array.isArray(held.anyOf);
        if (!isUnion) {
          expect(held.description, `${name}: ${where}`).toBeTypeOf("string");
        }
        described(held, [...path, key]);
        for (const branches of [held.oneOf, held.anyOf]) {
          if (Array.isArray(branches)) {
            for (const branch of branches) {
              described(branch as Record<string, unknown>, [...path, key]);
            }
          }
        }
        if (typeof held.items === "object" && held.items !== null) {
          described(held.items as Record<string, unknown>, [
            ...path,
            key,
            "items",
          ]);
        }
      }
    };

    described(registry.inputJsonSchema(name));
  });

  it.each(["news_list", "page_list"])(
    "%s bounds what it will return",
    (name) => {
      // Unbounded, one call could return the association's whole website into a
      // caller's context, and MCP has no tool-result pagination to fall back on.
      const document = registry.inputJsonSchema(name);
      const properties = document.properties as Record<
        string,
        Record<string, unknown> | undefined
      >;
      const limit = properties.limit;
      expect(limit, name).toBeDefined();
      expect(limit?.maximum, name).toBeLessThanOrEqual(50);
    },
  );

  it("refuses unknown keys at every depth, in every input", () => {
    for (const name of NAMES) {
      const document = registry.inputJsonSchema(name);
      expect(document.type, name).toBe("object");
      expect(document.additionalProperties, name).toBe(false);
    }
  });
});

describe("that dispatch and the routes decide the same thing", () => {
  /*
   * The claim the whole design rests on: after this change there are two places
   * a capability is checked - the global guard, from a route's declaration, and
   * the registry - and they have to be provably the same decision rather than
   * two opinions that happen to agree today.
   *
   * The same capability value is the half a test can assert directly. The same
   * resolver and the same predicate are properties of the code (both call
   * PrincipalService.forPerson, both ask a Set for membership) and the same
   * surface is what first-slice-callers pins.
   */
  it.each([
    ["news", NewsAdminController],
    ["pages", PagesAdminController],
    ["menu", MenuAdminController],
  ])("every %s action needs what the controller needs", (group, controller) => {
    const declared = Reflect.getMetadata(REQUIRED_CAPABILITIES, controller) as
      string[] | undefined;
    expect(declared, `${group} controller declares nothing`).toEqual([
      "site:manage",
    ]);

    for (const action of catalogue().filter((held) =>
      held.name.startsWith(group === "pages" ? "page_" : `${group}_`),
    )) {
      expect(action.capability, action.name).toBe("site:manage");
    }
  });
});
