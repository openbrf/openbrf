import type { ActionContext, ActionDefinition } from "@openbrf/plugin-sdk";
import { describe, expect, it, vi } from "vitest";

import type { CoreActionRegistrar } from "../actions/action-registrar";
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
  const registered: ActionDefinition[] = [];
  const registrar = {
    register: (_module: string, definitions: readonly ActionDefinition[]) => {
      registered.push(...definitions);
    },
  } as unknown as CoreActionRegistrar;

  new SiteActionsRegistrar(
    { listSummaries } as unknown as PagesWriteService,
    {} as unknown as MenuWriteService,
    registrar,
  ).onModuleInit();

  const pageList = registered.find((entry) => entry.name === "page_list");
  if (pageList === undefined) {
    throw new Error("page_list was not registered");
  }
  return { listSummaries, pageList };
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
