import { ACTION_CHANNELS, type ActionContext } from "@openbrf/plugin-sdk";
import { describe, expect, it } from "vitest";

import { AuditChannel } from "../generated/prisma/enums";
import { actorOf } from "./actor-of";

/**
 * The conversion between the two channel vocabularies.
 *
 * Totality is the case that matters. A channel added to the SDK and not to the
 * map would reach a write service as undefined and be stored in a column that
 * cannot be corrected afterwards, so the assertion is made in both directions:
 * every channel the SDK declares maps, and what the five produce is exactly the
 * enum the log has - not a subset of it.
 */

function context(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    principal: { personId: "person-1", capabilities: ["site:manage"] },
    channel: "web",
    requestId: "req-1",
    now: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("who a dispatched action is acting as", () => {
  it("maps every channel the SDK declares to one the log can store", () => {
    const stored = ACTION_CHANNELS.map(
      (channel) => actorOf(context({ channel })).channel,
    );

    expect(stored).toEqual(
      ACTION_CHANNELS.map((channel) => channel.toUpperCase()),
    );
    expect(new Set(stored)).toEqual(new Set(Object.values(AuditChannel)));
  });

  it("carries the person and the request, and nothing else about them", () => {
    expect(actorOf(context())).toEqual({
      personId: "person-1",
      channel: "WEB",
      requestId: "req-1",
    });
  });

  it("carries the connected app that acted, when one did", () => {
    const actor = actorOf(
      context({
        channel: "mcp",
        client: { clientId: "app-1", clientHost: "https://app.example.se" },
      }),
    );

    expect(actor).toEqual({
      personId: "person-1",
      channel: "MCP",
      clientId: "app-1",
      clientHost: "https://app.example.se",
      requestId: "req-1",
    });
  });

  it("leaves the app out rather than nulling it when there was none", () => {
    expect(Object.keys(actorOf(context()))).not.toContain("clientId");
  });
});
