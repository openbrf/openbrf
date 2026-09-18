import type { ActionContext, ActionDefinition } from "@openbrf/plugin-sdk";
import { describe, expect, it, vi } from "vitest";

import type { CoreActionRegistrar } from "../actions/action-registrar";
import { MotionActionsRegistrar } from "./motion-actions.registrar";
import { motionQueueCursor, type MotionService } from "./motion.service";

/**
 * The board's side of the motions module, as actions.
 *
 * The member's side is deliberately absent and that is asserted here: putting
 * an item to the general meeting is a right the statute gives a member, and
 * whether a program may exercise somebody's statutory right on their behalf is
 * a question this slice does not answer.
 */

const QUEUED = {
  id: "motion-1",
  title: "Laddstolpar i garaget",
  body: "Föreningen bör utreda vad laddstolpar skulle kosta.",
  status: "SUBMITTED" as const,
  submittedAt: "2027-01-20T09:00:00.000Z",
  closedAt: null,
  meeting: null,
  submitter: { kind: "protected" as const, personId: "person-maja" },
  closedByPersonId: null,
};

function build() {
  const queue = vi.fn(async (_filter?: unknown, _now?: Date) => ({
    deadline: { month: 1, day: 31, nextOn: "2027-01-31" },
    motions: [QUEUED],
    nextCursor: null,
  }));
  const acknowledge = vi.fn(async (_id: string, _actor: unknown) => ({
    ...QUEUED,
    status: "ACKNOWLEDGED" as const,
  }));
  const setMeeting = vi.fn(
    async (_id: string, _meetingId: string | null, _actor: unknown) => QUEUED,
  );
  const registered: ActionDefinition[] = [];
  const registrar = {
    register: (_module: string, definitions: readonly ActionDefinition[]) => {
      registered.push(...definitions);
    },
  } as unknown as CoreActionRegistrar;

  new MotionActionsRegistrar(
    { queue, acknowledge, setMeeting } as unknown as MotionService,
    registrar,
  ).onModuleInit();

  const held = (name: string): ActionDefinition => {
    const action = registered.find((entry) => entry.name === name);
    if (action === undefined) {
      throw new Error(`${name} was not registered`);
    }
    return action;
  };

  return { queue, acknowledge, setMeeting, registered, held };
}

const BOARD_MEMBER = {
  principal: { personId: "person-board", capabilities: ["motions:handle"] },
  channel: "mcp",
  client: { clientId: "client-1", clientHost: "app.example" },
  requestId: "request-1",
  now: new Date("2027-02-01T08:00:00.000Z"),
} as unknown as ActionContext;

const CURSOR = motionQueueCursor({
  status: "SUBMITTED",
  submittedAt: new Date("2027-01-20T09:00:00.000Z"),
  id: "motion-1",
});

async function parse(
  action: ActionDefinition,
  input: unknown,
): Promise<{ ok: boolean }> {
  const result = await action.input["~standard"].validate(input);
  return { ok: result.issues === undefined };
}

describe("what the motions group registers", () => {
  it("is the board's three acts and none of the member's", () => {
    const { registered } = build();

    expect(registered.map((action) => action.name).sort()).toEqual([
      "motion_acknowledge",
      "motion_queue_list",
      "motion_set_meeting",
    ]);
  });

  it("needs the capability the board's own queue needs", () => {
    const { registered } = build();

    for (const action of registered) {
      expect(action.capability, action.name).toBe("motions:handle");
      expect([...action.personalData].sort(), action.name).toEqual([
        "freeText",
        "name",
      ]);
      expect(action.surfaces, action.name).toEqual(["ui", "mcp"]);
    }
  });

  it("deletes nothing", () => {
    // Acknowledging closes an item and a meeting link can be taken back with
    // null, so both are writes. The one act that ends an item is the member's
    // own withdrawal, which is not here.
    const { registered } = build();

    for (const action of registered) {
      expect(action.effect, action.name).not.toBe("delete");
    }
  });
});

describe("reading the queue through an action", () => {
  it("bounds one call below the page the service will answer with", async () => {
    // A motion's body runs to eight thousand characters, so a full page of them
    // is several times a thread of comments. The cursor is how the rest is read.
    const { held } = build();
    const action = held("motion_queue_list");

    expect(await parse(action, { limit: 20 })).toEqual({ ok: true });
    expect(await parse(action, { limit: 21 })).toEqual({ ok: false });
  });

  it("refuses a cursor this platform did not hand out", async () => {
    const { held } = build();
    const action = held("motion_queue_list");

    expect(await parse(action, { after: CURSOR })).toEqual({ ok: true });
    expect(await parse(action, { after: "page 2" })).toEqual({ ok: false });
  });

  it("passes the parsed cursor and the limit on to the service", async () => {
    const { queue, held } = build();

    await held("motion_queue_list").handler(
      { limit: 5, after: CURSOR, status: "SUBMITTED" },
      BOARD_MEMBER,
    );

    expect(queue.mock.calls[0]?.[0]).toEqual({
      status: "SUBMITTED",
      limit: 5,
      after: {
        status: "SUBMITTED",
        submittedAt: new Date("2027-01-20T09:00:00.000Z"),
        id: "motion-1",
      },
    });
  });

  it("publishes a protected submitter as a branch rather than as an empty name", async () => {
    const { held } = build();

    const answer = (await held("motion_queue_list").handler(
      { limit: 10 },
      BOARD_MEMBER,
    )) as { motions: { submitter: Record<string, unknown> }[] };

    expect(answer.motions[0]?.submitter).toEqual({
      kind: "protected",
      personId: "person-maja",
    });
  });
});

describe("the board's two writes through an action", () => {
  it("hands the service the caller the registry resolved", async () => {
    const { acknowledge, setMeeting, held } = build();
    const actor = {
      personId: "person-board",
      channel: "MCP",
      clientId: "client-1",
      clientHost: "app.example",
      requestId: "request-1",
    };

    await held("motion_acknowledge").handler({ id: "motion-1" }, BOARD_MEMBER);
    await held("motion_set_meeting").handler(
      { id: "motion-1", meetingId: null },
      BOARD_MEMBER,
    );

    expect(acknowledge.mock.calls[0]).toEqual(["motion-1", actor]);
    expect(setMeeting.mock.calls[0]).toEqual(["motion-1", null, actor]);
  });

  it("takes a meeting back with null rather than with a second action", async () => {
    // One answer the board gives and can take back, not an event that happened.
    const { held } = build();
    const action = held("motion_set_meeting");

    expect(await parse(action, { id: "motion-1", meetingId: null })).toEqual({
      ok: true,
    });
    expect(
      await parse(action, { id: "motion-1", meetingId: "meeting-1" }),
    ).toEqual({ ok: true });
    expect(await parse(action, { id: "motion-1" })).toEqual({ ok: false });
  });
});
