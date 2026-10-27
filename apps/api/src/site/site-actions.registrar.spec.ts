import type { ActionContext, ActionDefinition } from "@openbrf/plugin-sdk";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  ActionCallerFactory,
  type RequestWithToken,
} from "../actions/action-caller";
import { ActionRegistryService } from "../actions/action-registry.service";
import { CoreActionRegistrar } from "../actions/action-registrar";
import { markAuthenticated } from "../actions/authenticated-request";
import { LiveResponse } from "../actions/testing/live-response";
import type { PrincipalService } from "../authorization/principal.service";
import type { Env } from "../config/env";
import type { I18nService } from "../i18n/i18n.service";
import type { MenuWriteService } from "./menu-write.service";
import type { PagesWriteService } from "./pages-write.service";
import { SiteActionsRegistrar } from "./site-actions.registrar";

/**
 * The page actions' input, against a stubbed service.
 *
 * Only what the input schema lets through is asserted here: what the service
 * does with a cursor is asserted where it is written.
 */

function build() {
  const listSummaries = vi.fn(async (_options: Record<string, unknown>) => ({
    pages: [],
    nextCursor: null,
  }));
  const create = vi.fn(async (_input: Record<string, unknown>) => ({}));
  const registered: ActionDefinition[] = [];
  const registrar = {
    register: (_module: string, definitions: readonly ActionDefinition[]) => {
      registered.push(...definitions);
    },
  } as unknown as CoreActionRegistrar;

  new SiteActionsRegistrar(
    { listSummaries, create } as unknown as PagesWriteService,
    {} as unknown as MenuWriteService,
    registrar,
  ).onModuleInit();

  const named = (name: string): ActionDefinition => {
    const found = registered.find((entry) => entry.name === name);
    if (found === undefined) {
      throw new Error(`${name} was not registered`);
    }
    return found;
  };
  return {
    listSummaries,
    create,
    pageList: named("page_list"),
    pageCreate: named("page_create"),
  };
}

const CALLER = {
  principal: { personId: "person-board", capabilities: ["site:manage"] },
  channel: "mcp",
  client: { clientId: "client-1", clientHost: "app.example" },
  requestId: "request-1",
  now: new Date("2026-09-18T08:00:00.000Z"),
} as unknown as ActionContext;

async function parse(action: ActionDefinition, input: unknown) {
  const result = await action.input["~standard"].validate(input);
  return result.issues === undefined
    ? { ok: true as const, value: result.value }
    : { ok: false as const };
}

describe("reading the pages a few at a time", () => {
  it("accepts the cursor written for a page whose id is as long as an id may be", async () => {
    const { listSummaries, pageList } = build();
    // The cursor the service writes: a sort order, a colon and the id.
    const cursor = `-2147483648:${"p".repeat(64)}`;

    const parsed = await parse(pageList, { cursor });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      await pageList.handler(parsed.value, CALLER);
    }

    expect(listSummaries).toHaveBeenCalledWith(
      expect.objectContaining({ cursor }),
    );
  });

  it("still refuses a cursor that is a paragraph", async () => {
    const { pageList } = build();

    expect(await parse(pageList, { cursor: "x".repeat(200) })).toEqual({
      ok: false,
    });
  });
});

describe("creating a page from an older tool list", () => {
  it("takes the input page_create was published with, and still makes a draft", async () => {
    /*
     * An MCP client caches tools/list, so a caller can be holding the
     * document from before a page had a status, which asked for a visibility
     * and an address. A published name keeps its shape: the old input is
     * still accepted, and the audience it named is not taken as a decision to
     * publish to anybody.
     */
    const { create, pageCreate } = build();

    const parsed = await parse(pageCreate, {
      slug: "styrelsen",
      title: "Styrelsen",
      blocks: [],
      visibility: "MEMBER",
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      await pageCreate.handler(parsed.value, CALLER);
    }

    expect(create).toHaveBeenCalledWith(
      {
        slug: "styrelsen",
        title: "Styrelsen",
        content: expect.objectContaining({ blocks: [] }),
      },
      expect.anything(),
    );
  });

  it("still refuses a visibility the old document never offered", async () => {
    const { pageCreate } = build();

    expect(
      await parse(pageCreate, {
        title: "Styrelsen",
        blocks: [],
        visibility: "MEMBERS_ONLY",
      }),
    ).toEqual({ ok: false });
  });
});

describe("what a plugin that asks for site:blocks is offered", () => {
  const WEBSITE_PLUGIN = { id: "noticeboard", ai: false } as const;

  it("is none of the core's page actions, whatever it declares", async () => {
    const callers = new ActionCallerFactory();
    const principals = {
      forPerson: async () => ({
        personId: "person-board",
        capabilities: new Set(["site:manage"]),
      }),
    } as unknown as PrincipalService;
    const i18n = {
      translatorFor: () => (key: string) => key,
    } as unknown as I18nService;
    const registry = new ActionRegistryService(
      callers,
      principals,
      i18n,
      {
        OPENBRF_ACTIONS_READ_ONLY: false,
        APP_URL: "https://brf.example",
      } as Env,
      { declared: false, path: "", url: "" },
    );
    registry.bindLiveness({
      get: async () => ({
        serving: true,
        armedActions: [],
        capabilityFloor: ["self:manage"],
        personalData: ["freeText", "photograph"],
        manifestPersonalData: ["freeText", "photograph"],
        websiteBlocks: true,
      }),
    });
    new SiteActionsRegistrar(
      {} as unknown as PagesWriteService,
      {} as unknown as MenuWriteService,
      new CoreActionRegistrar(registry),
    ).onModuleInit();

    const request = { id: "req-1" } as unknown as RequestWithToken;
    markAuthenticated(request, new LiveResponse(), {
      personId: "person-board",
      token: null,
      requestId: "req-1",
    });
    const offered = (
      await registry.list(callers.forPlugin(request, WEBSITE_PLUGIN))
    ).map((one) => one.name);

    expect(offered.filter((name) => name.startsWith("page_"))).toEqual([]);
  });
});
