import type { ActionDefinition } from "@openbrf/plugin-sdk";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  ActionCallerFactory,
  type RequestWithToken,
} from "../actions/action-caller";
import { CoreActionRegistrar } from "../actions/action-registrar";
import { ActionRegistryService } from "../actions/action-registry.service";
import { markAuthenticated } from "../actions/authenticated-request";
import { LiveResponse } from "../actions/testing/live-response";
import type { Principal } from "../authorization/capabilities";
import type { PrincipalService } from "../authorization/principal.service";
import type { Env } from "../config/env";
import type { I18nService } from "../i18n/i18n.service";
import { MeetingActionsRegistrar } from "./meeting-actions.registrar";
import type { MeetingService } from "./meeting.service";

/**
 * The general meeting as reads for a connected app and the AI package, and the
 * agenda write the AI package proposes (ADR 0041).
 *
 * Two things are asserted per action. Who may call it: the board's
 * `meetings:manage`, through `mcp`, and nobody through the board's own screen,
 * which reads the meeting through its controller. And what it may carry: the
 * agenda, the decisions as totals and the notice's terms, and never a person -
 * not who attended, not whose proxy authorisation was registered, not how
 * anybody voted and not whom the notice failed to reach.
 */

const NAMES = ["meeting_list", "meeting_get"] as const;

const SUMMARY = {
  id: "meeting-1",
  kind: "ORDINARY" as const,
  heldOn: "2027-05-20",
  concludedAt: null,
  summoned: true,
  agendaItemCount: 1,
};

const OUTLINE = {
  ...SUMMARY,
  agenda: [
    {
      id: "item-1",
      position: 1,
      title: "Laddstolpar i garaget",
      decision: {
        outcome: "CARRIED" as const,
        votesFor: 31,
        votesAgainst: 4,
        votesAbstaining: 2,
        closedBallot: false,
        recordedAt: "2027-05-20T19:40:00.000Z",
      },
    },
  ],
  notice: {
    startsAt: "2027-05-20T16:00:00.000Z",
    place: "Föreningslokalen",
    digitalParticipation: null,
    issuedAt: "2027-04-22T08:00:00.000Z",
  },
};

/**
 * What the board's own read of the same meeting holds beyond the outline.
 *
 * Handed to the handler as though the service had widened, so the narrowing in
 * the registrar is what is under test rather than the service's own type.
 */
const PEOPLE = {
  attendances: [
    {
      id: "attendance-1",
      personId: "person-protected",
      capacity: "MEMBER",
      mode: "IN_PERSON",
      onBehalfOfPersonId: null,
      withdrawnAt: null,
    },
  ],
  proxyAuthorisations: [
    {
      id: "proxy-1",
      memberPersonId: "person-protected",
      proxyHolderPersonId: "person-holder",
      ground: "MEMBER",
      authorisedOn: "2027-05-01",
      withdrawnAt: null,
      recordedByPersonId: "person-board",
    },
  ],
  votingRegister: { lines: [{ personId: "person-protected", votes: 1 }] },
};

const AGENDA = [
  {
    id: "item-new-1",
    position: 1,
    title: "Stämmans öppnande",
    decision: null,
  },
];

function registered() {
  const list = vi.fn(async (_filter?: { year?: number; take?: number }) => [
    SUMMARY,
  ]);
  const outline = vi.fn(async (_id: string) => OUTLINE);
  const setAgenda = vi.fn(
    async (_id: string, _input: unknown, _actor: unknown) => AGENDA,
  );
  const definitions: ActionDefinition[] = [];
  const registrar = {
    register: (_module: string, held: readonly ActionDefinition[]) => {
      definitions.push(...held);
    },
  } as unknown as CoreActionRegistrar;

  new MeetingActionsRegistrar(
    { list, outline, setAgenda } as unknown as MeetingService,
    registrar,
  ).onModuleInit();

  const held = (name: string): ActionDefinition => {
    const action = definitions.find((entry) => entry.name === name);
    if (action === undefined) {
      throw new Error(`${name} was not registered`);
    }
    return action;
  };
  return { definitions, held, list, outline, setAgenda };
}

const CONTEXT = {
  principal: { personId: "person-board", capabilities: ["meetings:manage"] },
  channel: "mcp" as const,
  requestId: "req-1",
  now: new Date("2027-05-21T08:00:00Z"),
};

describe("what the meeting reads declare", () => {
  const { definitions } = registered();

  it("registers the two reads and the agenda write, and nothing else that writes", () => {
    expect(definitions.map((action) => action.name)).toEqual([
      ...NAMES,
      "meeting_set_agenda",
    ]);
    for (const name of NAMES) {
      expect(
        definitions.find((action) => action.name === name)?.effect,
        name,
      ).toBe("read");
    }
  });

  it.each([...NAMES])(
    "%s needs what the board's meetings screen needs",
    (name) => {
      const action = definitions.find((entry) => entry.name === name);
      expect(action?.capability).toBe("meetings:manage");
    },
  );

  it.each([...NAMES])("%s is offered on mcp and ai and not on ui", (name) => {
    const action = definitions.find((entry) => entry.name === name);
    expect([...(action?.surfaces ?? [])].sort()).toEqual(["ai", "mcp"]);
  });

  it.each([...NAMES])("%s declares no person and nothing protected", (name) => {
    const action = definitions.find((entry) => entry.name === name);
    expect(action?.personalData).not.toContain("name");
    expect(action?.personalData).not.toContain("protected");
  });
});

describe("meeting_list", () => {
  it("asks for one more than the limit and says whether there were more", async () => {
    const { held, list } = registered();
    list.mockResolvedValueOnce([
      SUMMARY,
      { ...SUMMARY, id: "meeting-0", heldOn: "2026-05-21" },
    ]);

    const answer = (await held("meeting_list").handler(
      { year: 2027, limit: 1 },
      CONTEXT,
    )) as { meetings: { id: string }[]; more: boolean };

    expect(list).toHaveBeenCalledWith({ year: 2027, take: 2 });
    expect(answer.meetings.map((meeting) => meeting.id)).toEqual(["meeting-1"]);
    expect(answer.more).toBe(true);
  });

  it("bounds a call at fifty meetings", async () => {
    const { held } = registered();
    const parsed = await held("meeting_list").input["~standard"].validate({
      limit: 51,
    });
    expect(parsed.issues).toBeDefined();
  });
});

describe("meeting_get", () => {
  it("answers with the agenda, the totals and the notice's terms", async () => {
    const { held, outline } = registered();

    const answer = await held("meeting_get").handler(
      { id: "meeting-1" },
      CONTEXT,
    );

    expect(outline).toHaveBeenCalledWith("meeting-1");
    expect(answer).toEqual(OUTLINE);
  });

  it("carries no person, though the service hands it some", async () => {
    /*
     * The protected-data case. A member with protected personal data who came
     * to the meeting is on the list of those present and in the voting
     * register, and a member who gave a proxy authorisation is on it with the
     * holder. None of it may reach a connected app or the AI package, so the
     * registrar copies field by field rather than spreading what it is given.
     */
    const { held, outline } = registered();
    outline.mockResolvedValueOnce({
      ...OUTLINE,
      ...PEOPLE,
      agenda: [
        {
          ...OUTLINE.agenda[0]!,
          decision: {
            ...OUTLINE.agenda[0]!.decision,
            recordedByPersonId: "person-board",
          },
        },
      ],
      notice: {
        ...OUTLINE.notice,
        issuedByPersonId: "person-board",
        deliveries: { unreachedPersonIds: ["person-protected"] },
      },
    } as never);

    const action = held("meeting_get");
    const answer = await action.handler({ id: "meeting-1" }, CONTEXT);

    expect(answer).toEqual(OUTLINE);
    expect(JSON.stringify(answer)).not.toMatch(/person-/u);
    // And what the handler returns is what the published schema accepts, so
    // the registry does not refuse it on the way out either.
    const validated = await action.output["~standard"].validate(answer);
    expect(validated.issues).toBeUndefined();
  });

  it("publishes no property that holds a person", () => {
    /*
     * Over the document a caller reads, at every depth. The catalogue's own
     * test checks a declaration against the properties it implies; this one is
     * stricter for these two, because the answer to "may a person be in it" is
     * no rather than "only if declared".
     */
    const registry = registryWith([]).registry;
    const forbidden =
      /(^|")(personId|[a-zA-Z]+PersonId|name|attendances|proxyAuthorisations|votingRegister|votes|deliveries|unreachedPersonIds)"/u;
    for (const name of NAMES) {
      expect(JSON.stringify(registry.outputJsonSchema(name)), name).not.toMatch(
        forbidden,
      );
    }
  });
});

/**
 * The two actions in a real registry, against a person holding the given
 * capabilities.
 */
function registryWith(capabilities: string[]) {
  const callers = new ActionCallerFactory();
  const principal = {
    personId: "person-board",
    capabilities: new Set(capabilities),
  } as unknown as Principal;
  const registry = new ActionRegistryService(
    callers,
    { forPerson: vi.fn(async () => principal) } as unknown as PrincipalService,
    { translatorFor: () => (key: string) => key } as unknown as I18nService,
    {
      OPENBRF_ACTIONS_READ_ONLY: false,
      APP_URL: "https://brf.example",
    } as unknown as Env,
    {
      declared: true,
      path: "/api/plugin/connector/mcp",
      url: "https://brf.example/api/plugin/connector/mcp",
    },
  );
  const list = vi.fn(async () => [SUMMARY]);
  const outline = vi.fn(async () => OUTLINE);
  const setAgenda = vi.fn(async () => AGENDA);
  new MeetingActionsRegistrar(
    { list, outline, setAgenda } as unknown as MeetingService,
    new CoreActionRegistrar(registry),
  ).onModuleInit();
  return { registry, callers, list, outline, setAgenda };
}

function request(token?: RequestWithToken["token"]): RequestWithToken {
  const held = {
    id: "req-1",
    principal: { personId: "person-board" },
    ...(token === undefined ? {} : { token }),
  } as unknown as RequestWithToken;
  markAuthenticated(held, new LiveResponse(), {
    personId: "person-board",
    token: token ?? null,
    requestId: "req-1",
  });
  return held;
}

const APP = {
  tokenRowId: "token-1",
  clientId: "client-1",
  clientHost: "app.example",
  scopes: ["mcp:read"],
};

const INPUT: Record<(typeof NAMES)[number], unknown> = {
  meeting_list: {},
  meeting_get: { id: "meeting-1" },
};

describe.each([...NAMES])("who may call %s", (name) => {
  it("answers the board through a connected app", async () => {
    const { registry, callers, list, outline } = registryWith([
      "meetings:manage",
    ]);

    await expect(
      registry.invoke(callers.forRequest(request(APP)), name, INPUT[name]),
    ).resolves.toBeDefined();
    expect(list.mock.calls.length + outline.mock.calls.length).toBe(1);
  });

  it("refuses a person without meetings:manage, before the service", async () => {
    // The property manager, who holds the issue queue and none of the
    // members' meeting.
    const { registry, callers, list, outline } = registryWith([
      "issues:handle",
      "site:manage",
    ]);

    await expect(
      registry.invoke(callers.forRequest(request(APP)), name, INPUT[name]),
    ).rejects.toMatchObject({ reason: "forbidden-capability" });
    expect(list).not.toHaveBeenCalled();
    expect(outline).not.toHaveBeenCalled();
  });

  it("refuses the board's own screen, which reads through its controller", async () => {
    const { registry, callers, list, outline } = registryWith([
      "meetings:manage",
    ]);

    await expect(
      registry.invoke(callers.forRequest(request()), name, INPUT[name]),
    ).rejects.toMatchObject({ reason: "forbidden-surface" });
    expect(list).not.toHaveBeenCalled();
    expect(outline).not.toHaveBeenCalled();
  });

  it("refuses a connection that may not read", async () => {
    const { registry, callers, list, outline } = registryWith([
      "meetings:manage",
    ]);

    await expect(
      registry.invoke(
        callers.forRequest(request({ ...APP, scopes: ["mcp:write"] })),
        name,
        INPUT[name],
      ),
    ).rejects.toMatchObject({ reason: "insufficient-scope" });
    expect(list).not.toHaveBeenCalled();
    expect(outline).not.toHaveBeenCalled();
  });

  it("is listed to the board on mcp and to nobody else", async () => {
    const board = registryWith(["meetings:manage"]);
    const other = registryWith(["site:manage"]);
    const app = (built: ReturnType<typeof registryWith>) =>
      built.callers.forRequest(request(APP));

    expect(
      (await board.registry.list(app(board))).map((action) => action.name),
    ).toContain(name);
    expect(
      (await other.registry.list(app(other))).map((action) => action.name),
    ).not.toContain(name);
  });
});

describe("meeting_set_agenda", () => {
  const AGENDA_INPUT = {
    meetingId: "meeting-1",
    expectedItemIds: ["item-1"],
    items: [{ title: "Stämmans öppnande" }],
  };

  it("is a write the board's capability covers, offered on ui and ai and not on mcp", () => {
    /*
     * `ai` so that the AI package can propose it, and `ui` because a pending
     * change is confirmed on the platform's own screen, which ADR 0039 refuses
     * for an action it is not offered. Not `mcp`: a connected app's write would
     * land directly.
     */
    const action = registered().held("meeting_set_agenda");
    expect(action.effect).toBe("write");
    expect(action.capability).toBe("meetings:manage");
    expect([...action.surfaces].sort()).toEqual(["ai", "ui"]);
    expect(action.personalData).toEqual(["freeText"]);
    expect(action.errors.map((spec) => [spec.reason, spec.retry])).toEqual([
      ["meeting-not-found", "after-edit"],
      ["agenda-changed", "after-edit"],
      ["notice-already-issued", "never"],
      ["meeting-already-held", "never"],
    ]);
  });

  it("writes as the caller, against the agenda it read, and answers with the items alone", async () => {
    const { held, setAgenda } = registered();
    setAgenda.mockResolvedValueOnce([
      {
        ...AGENDA[0]!,
        decision: { recordedByPersonId: "person-board" },
      },
    ] as never);
    const action = held("meeting_set_agenda");

    const answer = await action.handler(AGENDA_INPUT, {
      ...CONTEXT,
      channel: "web",
      pendingChangeId: "pending-1",
    });

    expect(setAgenda).toHaveBeenCalledWith(
      "meeting-1",
      {
        items: [{ title: "Stämmans öppnande" }],
        expectedItemIds: ["item-1"],
      },
      expect.objectContaining({
        personId: "person-board",
        channel: "WEB",
        pendingChangeId: "pending-1",
      }),
    );
    expect(answer).toEqual({
      agenda: [{ id: "item-new-1", position: 1, title: "Stämmans öppnande" }],
    });
    const validated = await action.output["~standard"].validate(answer);
    expect(validated.issues).toBeUndefined();
  });

  it.each([
    ["no items", { ...AGENDA_INPUT, items: [] }],
    ["a blank title", { ...AGENDA_INPUT, items: [{ title: "   " }] }],
    [
      "a title past 300 characters",
      { ...AGENDA_INPUT, items: [{ title: "x".repeat(301) }] },
    ],
    [
      "more than a hundred items",
      {
        ...AGENDA_INPUT,
        items: Array.from({ length: 101 }, (_, index) => ({
          title: `Punkt ${String(index)}`,
        })),
      },
    ],
    ["no expected agenda", { meetingId: "meeting-1", items: [{ title: "A" }] }],
    ["a field it does not know", { ...AGENDA_INPUT, position: 3 }],
  ])("refuses %s", async (_case, input) => {
    const parsed = await registered()
      .held("meeting_set_agenda")
      .input["~standard"].validate(input);
    expect(parsed.issues).toBeDefined();
  });
});

describe("who may write a meeting's agenda", () => {
  const INPUT_AGENDA = {
    meetingId: "meeting-1",
    expectedItemIds: [],
    items: [{ title: "Stämmans öppnande" }],
  };

  /** The AI package's own route, serving the board member's session. */
  function aiPackage(built: ReturnType<typeof registryWith>) {
    return built.callers.forPlugin(request(), { id: "ai-package", ai: true });
  }

  it("holds the AI package's call as a proposal, and never runs it directly", async () => {
    const built = registryWith(["meetings:manage"]);

    await expect(
      built.registry.invoke(
        aiPackage(built),
        "meeting_set_agenda",
        INPUT_AGENDA,
      ),
    ).rejects.toMatchObject({ reason: "confirmation-required" });
    await expect(
      built.registry.check(
        aiPackage(built),
        "meeting_set_agenda",
        INPUT_AGENDA,
      ),
    ).resolves.toBeDefined();
    expect(built.setAgenda).not.toHaveBeenCalled();
  });

  it("refuses the AI package a proposal for somebody without meetings:manage", async () => {
    const built = registryWith(["site:manage"]);

    await expect(
      built.registry.check(
        aiPackage(built),
        "meeting_set_agenda",
        INPUT_AGENDA,
      ),
    ).rejects.toMatchObject({ reason: "forbidden-capability" });
  });

  it("is not offered to a connected app", async () => {
    const built = registryWith(["meetings:manage"]);
    const app = built.callers.forRequest(
      request({ ...APP, scopes: ["mcp:read", "mcp:write"] }),
    );

    await expect(
      built.registry.invoke(app, "meeting_set_agenda", INPUT_AGENDA),
    ).rejects.toMatchObject({ reason: "forbidden-surface" });
    expect(built.setAgenda).not.toHaveBeenCalled();
    expect(
      (await built.registry.list(app)).map((action) => action.name),
    ).not.toContain("meeting_set_agenda");
  });
});
