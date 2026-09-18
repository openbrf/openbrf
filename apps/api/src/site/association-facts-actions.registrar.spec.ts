import type { ActionContext, ActionDefinition } from "@openbrf/plugin-sdk";
import { describe, expect, it, vi } from "vitest";

import type { CoreActionRegistrar } from "../actions/action-registrar";
import type { AssociationFactsService } from "./association-facts.service";
import { AssociationFactsActionsRegistrar } from "./association-facts-actions.registrar";

/**
 * The two actions over the association's own facts, against a stubbed service.
 *
 * What is asserted here is the binding rather than the behaviour: that each
 * handler calls the method the catalogue says it calls, that the update carries
 * only the fields the caller named, and that the actor reaching the service is
 * the one the registry resolved rather than anything a caller stated about
 * itself. The service's own rules - the trim, the cleared field, the identity
 * number scan - are asserted where they live.
 */

const UNRECORDED = {
  propertyDesignation: null,
  buildYear: null,
  siteLeasehold: null,
  siteLeaseholdNote: null,
  feePolicy: null,
  feeIncludes: null,
  transferFeePolicy: null,
  pledgeFeePolicy: null,
  legalPersonOwners: null,
  legalPersonOwnersNote: null,
  parking: null,
  storage: null,
  renovations: null,
  updatedAt: null,
};

function build() {
  const read = vi.fn(async () => UNRECORDED);
  const save = vi.fn(
    async (_input: Record<string, unknown>, _actor: unknown) => UNRECORDED,
  );
  const registered: ActionDefinition[] = [];
  const registrar = {
    register: (_module: string, definitions: readonly ActionDefinition[]) => {
      registered.push(...definitions);
    },
  } as unknown as CoreActionRegistrar;

  new AssociationFactsActionsRegistrar(
    { read, save } as unknown as AssociationFactsService,
    registrar,
  ).onModuleInit();

  const held = (name: string): ActionDefinition => {
    const action = registered.find((entry) => entry.name === name);
    if (action === undefined) {
      throw new Error(`${name} was not registered`);
    }
    return action;
  };

  return { read, save, registered, held };
}

/** A caller as the registry resolved them, arriving through a connected app. */
const CONNECTED_APP = {
  principal: { personId: "person-board", capabilities: ["site:manage"] },
  channel: "mcp",
  client: { clientId: "client-1", clientHost: "app.example" },
  requestId: "request-1",
  now: new Date("2026-09-18T08:00:00.000Z"),
} as unknown as ActionContext;

describe("what the facts group registers", () => {
  it("is the read and the write, and nothing else", () => {
    const { registered } = build();

    expect(registered.map((action) => action.name).sort()).toEqual([
      "association_facts_get",
      "association_facts_update",
    ]);
  });

  it("declares no personal data at all", () => {
    // The control case for the registry's new refusal. Thirteen fields about a
    // building, the fee and the land, and not one of them names a person - so
    // the honest declaration is the empty one, and it has to register.
    const { registered } = build();

    for (const action of registered) {
      expect(action.personalData, action.name).toEqual([]);
      expect(action.surfaces, action.name).toEqual(["ui", "mcp"]);
    }
  });
});

describe("reading the facts", () => {
  it("answers with what the service holds", async () => {
    const { read, held } = build();

    const answer = await held("association_facts_get").handler(
      {},
      CONNECTED_APP,
    );

    expect(read).toHaveBeenCalledTimes(1);
    expect(answer).toEqual(UNRECORDED);
  });
});

describe("recording the facts", () => {
  it("passes only the fields the caller named", async () => {
    // A field the call does not mention is untouched, which is what the service
    // means by absent. Sending every field as null instead would clear the page.
    const { save, held } = build();

    await held("association_facts_update").handler(
      { parking: "Tolv platser.", feePolicy: null },
      CONNECTED_APP,
    );

    expect(Object.keys(save.mock.calls[0]?.[0] ?? {}).sort()).toEqual([
      "feePolicy",
      "parking",
    ]);
  });

  it("hands the service the caller the registry resolved", async () => {
    /*
     * Never anything the caller said about itself. The channel is what makes
     * the audit entry evidence rather than a claim, and the connected app is
     * named on it because an entry recording that an app changed what the
     * association tells a buyer, without recording which app, answers half the
     * question.
     */
    const { save, held } = build();

    await held("association_facts_update").handler(
      { storage: "Källarförråd." },
      CONNECTED_APP,
    );

    expect(save.mock.calls[0]?.[1]).toEqual({
      personId: "person-board",
      channel: "MCP",
      clientId: "client-1",
      clientHost: "app.example",
      requestId: "request-1",
    });
  });
});
