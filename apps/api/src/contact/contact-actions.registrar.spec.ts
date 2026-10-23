import {
  actionInputJsonSchema,
  type ActionContext,
  type ActionDefinition,
} from "@openbrf/plugin-sdk";
import { describe, expect, it, vi } from "vite-plus/test";

import type { CoreActionRegistrar } from "../actions/action-registrar";
import { ContactActionsRegistrar } from "./contact-actions.registrar";
import type { ContactInboxPage, ContactService } from "./contact.service";

/**
 * The contact form inbox as a read for a caller outside the instance
 * (ADR 0040): the sender's name and words, and never the address the board
 * answers them at.
 */

const PAGE: ContactInboxPage = {
  submissions: [
    {
      id: "message-1",
      name: "Gunnar",
      email: "gunnar@exempel.se",
      message: "Hur gör jag för att ställa mig i kön?",
      handled: false,
      handledAt: null,
      createdAt: "2027-01-20T09:00:00.000Z",
    },
  ],
  unhandled: 1,
  total: 3,
  nextCursor: "open|2027-01-20T09:00:00.000Z|message-1",
};

function build() {
  const list = vi.fn(async (_cursor?: string, _limit?: number) => PAGE);
  const registered: ActionDefinition[] = [];
  const registrar = {
    register: (_module: string, definitions: readonly ActionDefinition[]) => {
      registered.push(...definitions);
    },
  } as unknown as CoreActionRegistrar;

  new ContactActionsRegistrar(
    { list } as unknown as ContactService,
    registrar,
  ).onModuleInit();

  return { list, registered };
}

const BOARD_MEMBER = {
  principal: {
    personId: "person-board",
    capabilities: ["signupRequest:decide"],
  },
  channel: "mcp",
  client: { clientId: "client-1", clientHost: "app.example" },
  requestId: "request-1",
  now: new Date("2027-02-01T08:00:00.000Z"),
} as unknown as ActionContext;

describe("contact_message_list", () => {
  it("is the one read, under what the inbox's controller needs", () => {
    const { registered } = build();

    expect(registered.map((action) => action.name)).toEqual([
      "contact_message_list",
    ]);
    const [action] = registered;
    expect(action?.effect).toBe("read");
    expect(action?.capability).toBe("signupRequest:decide");
    expect(action?.surfaces).toEqual(["mcp", "ai"]);
    expect([...(action?.personalData ?? [])].sort()).toEqual([
      "freeText",
      "name",
    ]);
  });

  it("gives the sender's name and words and never their address", async () => {
    const { registered, list } = build();
    const [action] = registered as [ActionDefinition];

    const parsed = await action.input["~standard"].validate({
      after: "open|2027-01-19T09:00:00.000Z|message-0",
      limit: 5,
    });
    expect(parsed.issues).toBeUndefined();
    const output = await action.handler(
      (parsed as { value: unknown }).value,
      BOARD_MEMBER,
    );

    expect(list).toHaveBeenCalledWith(
      "open|2027-01-19T09:00:00.000Z|message-0",
      5,
    );
    expect(
      (await action.output["~standard"].validate(output)).issues,
    ).toBeUndefined();
    expect(output).toEqual({
      messages: [
        {
          id: "message-1",
          name: "Gunnar",
          message: "Hur gör jag för att ställa mig i kön?",
          handled: false,
          handledAt: null,
          receivedAt: "2027-01-20T09:00:00.000Z",
        },
      ],
      unhandled: 1,
      total: 3,
      nextCursor: "open|2027-01-20T09:00:00.000Z|message-1",
    });
    expect(JSON.stringify(output)).not.toContain("gunnar@exempel.se");
  });

  it("reads at most twenty at a time", async () => {
    const { registered } = build();
    const [action] = registered as [ActionDefinition];

    expect(
      (await action.input["~standard"].validate({ limit: 21 })).issues,
    ).toBeDefined();
  });

  it("publishes the shape of the cursor it hands out", async () => {
    const { registered } = build();
    const [action] = registered as [ActionDefinition];
    const document = actionInputJsonSchema(action.input, action.name) as {
      properties: { after: { pattern?: string } };
    };
    const published = new RegExp(document.properties.after.pattern ?? "");

    expect(PAGE.nextCursor).toMatch(published);
    expect("handled|2027-01-20T09:00:00.000Z|message-1").toMatch(published);
    for (const value of ["page-2", "open|yesterday|message-1"]) {
      expect(value).not.toMatch(published);
      expect(
        (await action.input["~standard"].validate({ after: value })).issues,
      ).toBeDefined();
    }
  });
});
