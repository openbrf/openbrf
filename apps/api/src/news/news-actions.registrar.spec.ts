import type { ActionContext, ActionDefinition } from "@openbrf/plugin-sdk";
import { describe, expect, it, vi } from "vitest";

import type { CoreActionRegistrar } from "../actions/action-registrar";
import { NewsActionsRegistrar } from "./news-actions.registrar";
import type { NewsWriteService } from "./news-write.service";

/**
 * The precondition on news_update.
 *
 * A save carries the whole body, so a caller that is a model has to say which
 * copy it read. The published document requires the number, and the handler
 * hands it to the service, which refuses a save built on a copy somebody else
 * has saved over.
 */

function build() {
  const update = vi.fn(async () => ({}));
  const registered: ActionDefinition[] = [];
  const registrar = {
    register: (_module: string, definitions: readonly ActionDefinition[]) => {
      registered.push(...definitions);
    },
  } as unknown as CoreActionRegistrar;

  new NewsActionsRegistrar(
    { update } as unknown as NewsWriteService,
    registrar,
  ).onModuleInit();

  const action = registered.find((entry) => entry.name === "news_update");
  if (action === undefined) {
    throw new Error("news_update was not registered");
  }
  return { update, action };
}

const BOARD_MEMBER = {
  principal: { personId: "person-board", capabilities: ["site:manage"] },
  channel: "mcp",
  client: { clientId: "client-1", clientHost: "app.example" },
  requestId: "request-1",
  now: new Date("2026-09-18T08:00:00.000Z"),
} as unknown as ActionContext;

const EDIT = {
  id: "news-1",
  slug: "tvattstugan",
  title: "Tvättstugan",
  blocks: [{ type: "paragraph", runs: [{ text: "Nya tider." }] }],
};

describe("news_update", () => {
  it("accepts an input that does not say which copy it was built on", async () => {
    const { action, update } = build();

    const parsed = await action.input["~standard"].validate(EDIT);
    if (parsed.issues !== undefined) {
      throw new Error("The input was expected to be accepted.");
    }
    await action.handler(parsed.value, BOARD_MEMBER);

    expect(update).toHaveBeenCalledWith(
      "news-1",
      expect.objectContaining({ expectedRevision: undefined }),
      expect.anything(),
    );
  });

  it("hands the revision the caller read to the service", async () => {
    const { action, update } = build();

    const parsed = await action.input["~standard"].validate({
      ...EDIT,
      expectedRevision: 4,
    });
    if (parsed.issues !== undefined) {
      throw new Error("The input was expected to be accepted.");
    }
    await action.handler(parsed.value, BOARD_MEMBER);

    expect(update).toHaveBeenCalledWith(
      "news-1",
      expect.objectContaining({ expectedRevision: 4 }),
      expect.anything(),
    );
  });
});
