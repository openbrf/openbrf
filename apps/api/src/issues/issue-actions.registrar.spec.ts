import {
  actionInputJsonSchema,
  type ActionContext,
  type ActionDefinition,
} from "@openbrf/plugin-sdk";
import { ISSUE_STATUS_LIMITS, ISSUE_STATUS_MEANINGS } from "@openbrf/shared";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  ActionCallerFactory,
  type RequestWithToken,
} from "../actions/action-caller";
import { ActionInputNames } from "../actions/action-input-names";
import { ActionRegistryService } from "../actions/action-registry.service";
import { CoreActionRegistrar } from "../actions/action-registrar";
import { markAuthenticated } from "../actions/authenticated-request";
import type { CoreActionDefinition } from "../actions/core-action";
import { LiveResponse } from "../actions/testing/live-response";
import type { Principal } from "../authorization/capabilities";
import type { PrincipalService } from "../authorization/principal.service";
import type { Env } from "../config/env";
import type { I18nService } from "../i18n/i18n.service";
import { IssueActionsRegistrar } from "./issue-actions.registrar";
import { IssueError } from "./issue.error";
import type { IssueTypeView } from "./issue-type.service";
import {
  issueQueueCursor,
  parseIssueQueueCursor,
  type IssueService,
  type QueuedIssueView,
} from "./issue.service";

/**
 * The issue queue for a caller outside the instance (ADR 0040, ADR 0056).
 *
 * What only this spec shows is the narrowing between the service's view and
 * the published document: the email address and the photographs the screen
 * has are not in what a caller is handed, a write answers with what it changed
 * and nothing else, and every action asks the service to leave a protected
 * reporter's issue and a ring-fenced one out. That the service then does is
 * shown against a real database in `issue-actions.int-spec.ts` and
 * `ring-fence.int-spec.ts`.
 *
 * And why the MCP Connector was offered none of these that carry personal
 * data: a plugin is offered only the actions whose personal data its manifest
 * declares, action by action, asked of a real registry at the end of this
 * file.
 */

const QUEUED: QueuedIssueView = {
  id: "issue-1",
  number: 7,
  meaning: "NEW",
  status: { id: "status-water-new", label: "Ny" },
  waitingReason: null,
  outcome: null,
  typeId: "type-water",
  typeName: "Vatten",
  typeReporters: ["PUBLIC", "RESIDENTS"],
  location: "Badrummet",
  place: null,
  description: "Det droppar från taket.",
  apartment: { id: "apartment-1", number: "1001", address: "Storgatan 12" },
  aboutApartment: true,
  entry: null,
  photos: [
    {
      id: "photo-1",
      url: "/api/media/file-1",
      fileName: "tak.jpg",
      width: 800,
      height: 600,
    },
  ],
  reporter: { kind: "resident", personId: "person-rut", name: "Rut Ek" },
  enteredByHandler: false,
  descriptionRedactedAt: null,
  locationRedactedAt: null,
  freeTextRemovedAt: null,
  createdAt: "2027-01-20T09:00:00.000Z",
  updatedAt: "2027-01-20T09:00:00.000Z",
  closedAt: null,
  typeHandledBy: "EVERY_HANDLER",
  typeRingFenced: false,
  priority: "NORMAL",
  targetDate: null,
  overdue: false,
  assignee: null,
  enteredBy: null,
  knownFault: null,
  boardOnly: false,
  finding: null,
  legalHoldAt: null,
  damageCase: null,
  costResponsibility: null,
};

const EXTERNAL: QueuedIssueView = {
  ...QUEUED,
  id: "issue-2",
  apartment: null,
  aboutApartment: false,
  photos: [],
  reporter: {
    kind: "external",
    name: "Gunnar Förbipasserande",
    email: "gunnar@exempel.se",
    link: "live",
  },
};

const TYPES: IssueTypeView[] = [
  {
    id: "type-water",
    name: "Vatten",
    reporters: ["PUBLIC", "RESIDENTS"],
    handledBy: "EVERY_HANDLER",
    defaultPriority: "URGENT",
    ringFenced: false,
    active: true,
    sortOrder: 0,
    reportCount: 4,
    statuses: [
      {
        id: "status-water-new",
        meaning: "NEW",
        label: "Ny",
        isDefault: true,
        active: true,
        sortOrder: 0,
        issueCount: 4,
      },
      {
        id: "status-water-parts",
        meaning: "WAITING",
        label: "Väntar på reservdelar",
        isDefault: false,
        active: false,
        sortOrder: 1,
        issueCount: 0,
      },
    ],
  },
  {
    id: "type-old-lock",
    name: "Lås (gammal)",
    reporters: ["HANDLERS"],
    active: false,
    sortOrder: 1,
    reportCount: 1,
    handledBy: "EVERY_HANDLER",
    defaultPriority: "NORMAL",
    ringFenced: false,
    statuses: [],
  },
];

const HANDLERS = [
  { kind: "person", personId: "person-board", name: "Bea Styrelse" },
  { kind: "protected", personId: "person-hidden" },
] as const;

function build(issues: QueuedIssueView[] = [QUEUED, EXTERNAL]) {
  const handledTypes = vi.fn(async (_reader: string, _which: string) => TYPES);
  const pageOfQueue = vi.fn(
    async (_reader: string, _filter: unknown, _which: string) => ({
      issues,
      nextCursor: null,
    }),
  );
  const queuedIssue = vi.fn(
    async (_reader: string, _id: string, _which: string) =>
      issues[0] as QueuedIssueView,
  );
  const handlers = vi.fn(
    async (_reader: string, _id: string, _which: string) => [...HANDLERS],
  );
  // Each write answers with the row the service read back, which carries
  // everything the queue's row does.
  const written = (changes: Partial<QueuedIssueView>) =>
    ({ ...(issues[0] as QueuedIssueView), ...changes }) as QueuedIssueView;
  const assign = vi.fn(
    async (_id: string, assigneePersonId: string | null, ..._rest: unknown[]) =>
      written({
        assignee:
          assigneePersonId === null
            ? null
            : { kind: "protected", personId: assigneePersonId },
      }),
  );
  const setPriority = vi.fn(
    async (
      _id: string,
      priority: QueuedIssueView["priority"],
      ..._rest: unknown[]
    ) => written({ priority }),
  );
  const setTargetDate = vi.fn(
    async (_id: string, targetDate: string | null, ..._rest: unknown[]) =>
      written({ targetDate, overdue: true }),
  );
  const setStatus = vi.fn(
    async (_id: string, _move: unknown, ..._rest: unknown[]) =>
      written({
        meaning: "DONE",
        status: { id: "status-water-done", label: "Klar" },
        outcome: "FIXED",
        closedAt: "2027-02-01T08:00:00.000Z",
      }),
  );
  const statusOfType = vi.fn(async (typeId: string, statusId: string) => {
    const status = TYPES.find((type) => type.id === typeId)?.statuses.find(
      (entry) => entry.id === statusId,
    );
    return status === undefined
      ? null
      : { label: status.label, meaning: status.meaning, active: status.active };
  });
  const service = {
    pageOfQueue,
    queuedIssue,
    handledTypes,
    handlers,
    assign,
    setPriority,
    setTargetDate,
    setStatus,
    statusOfType,
  };

  const registered: CoreActionDefinition[] = [];
  const registrar = {
    register: (
      _module: string,
      definitions: readonly CoreActionDefinition[],
    ) => {
      registered.push(...definitions);
    },
  } as unknown as CoreActionRegistrar;
  const inputNames = new ActionInputNames();

  new IssueActionsRegistrar(
    service as unknown as IssueService,
    registrar,
    inputNames,
  ).onModuleInit();

  const held = (name: string): CoreActionDefinition => {
    const action = registered.find((entry) => entry.name === name);
    if (action === undefined) {
      throw new Error(`${name} was not registered`);
    }
    return action;
  };

  return { ...service, registered, held, inputNames };
}

const HANDLER = {
  principal: { personId: "person-manager", capabilities: ["issues:handle"] },
  channel: "mcp",
  client: { clientId: "client-1", clientHost: "app.example" },
  requestId: "request-1",
  now: new Date("2027-02-01T08:00:00.000Z"),
} as unknown as ActionContext;

async function parse(
  action: ActionDefinition,
  input: unknown,
): Promise<{ ok: boolean; value: unknown }> {
  const result = await action.input["~standard"].validate(input);
  return result.issues === undefined
    ? { ok: true, value: result.value }
    : { ok: false, value: undefined };
}

/** What the handler answers, checked against the action's own output schema. */
async function call(action: ActionDefinition, input: unknown) {
  const parsed = await parse(action, input);
  expect(parsed.ok).toBe(true);
  const output = await action.handler(parsed.value, HANDLER);
  const validated = await action.output["~standard"].validate(output);
  expect(validated.issues).toBeUndefined();
  return output as Record<string, unknown>;
}

const READS = [
  "issue_get",
  "issue_handler_list",
  "issue_list",
  "issue_type_list",
];
const WRITES = [
  "issue_assign",
  "issue_set_priority",
  "issue_set_status",
  "issue_set_target_date",
];

describe("what the issues group registers", () => {
  it("is four reads and the four writes ADR 0056 decided, and nothing else", () => {
    const { registered } = build();

    expect(registered.map((action) => action.name).sort()).toEqual(
      [...READS, ...WRITES].sort(),
    );
    for (const action of registered) {
      expect(action.effect, action.name).toBe(
        READS.includes(action.name) ? "read" : "write",
      );
    }
  });

  it("needs what the queue's own controller needs, and offers the reads beyond the instance only", () => {
    const { registered } = build();

    for (const action of registered) {
      expect(action.capability, action.name).toBe("issues:handle");
      // A write is offered on `ui` too, where a pending change is confirmed.
      expect(action.surfaces, action.name).toEqual(
        READS.includes(action.name) ? ["mcp", "ai"] : ["mcp", "ai", "ui"],
      );
    }
  });

  it("declares what each answer can carry, and never protected data", () => {
    const { registered } = build();
    const declared = Object.fromEntries(
      registered.map((action) => [
        action.name,
        [...action.personalData].sort(),
      ]),
    );

    expect(declared).toEqual({
      issue_list: ["apartment", "freeText", "health", "name"],
      issue_get: ["apartment", "freeText", "health", "name"],
      issue_type_list: ["freeText"],
      issue_handler_list: ["name"],
      issue_assign: ["name"],
      issue_set_priority: [],
      issue_set_target_date: [],
      issue_set_status: ["freeText"],
    });
  });

  it("holds a write for a person to confirm with the issue it names", () => {
    const { registered } = build();

    for (const action of registered.filter((held) =>
      WRITES.includes(held.name),
    )) {
      expect(action.target?.kind, action.name).toBe("issue");
      expect(action.needsConfirmation, action.name).toBe(false);
      expect(action.additive, action.name).toBe(false);
    }
  });
});

describe("issue_list", () => {
  it("asks the service to leave a protected reporter's issues out", async () => {
    const { held, pageOfQueue } = build();

    await call(held("issue_list"), {
      meaning: "WAITING",
      reporter: "HANDLERS",
      typeId: "type-water",
    });

    expect(pageOfQueue).toHaveBeenCalledWith(
      "person-manager",
      {
        meaning: "WAITING",
        typeId: "type-water",
        reporter: "HANDLERS",
        limit: 10,
        after: null,
      },
      "omit",
    );
  });

  it("hands the cursor back to the service as the place it names", async () => {
    const { held, pageOfQueue } = build();
    const after = {
      meaning: "IN_PROGRESS" as const,
      position: 2,
      createdAt: new Date("2027-01-20T09:00:00.000Z"),
      id: "issue-9",
    };

    await call(held("issue_list"), {
      after: issueQueueCursor(after),
      limit: 5,
    });

    expect(pageOfQueue).toHaveBeenCalledWith(
      "person-manager",
      expect.objectContaining({ after, limit: 5 }),
      "omit",
    );
  });

  it("refuses a cursor the platform did not hand out", async () => {
    const { held } = build();

    expect((await parse(held("issue_list"), { after: "page-2" })).ok).toBe(
      false,
    );
    expect(
      (await parse(held("issue_list"), { after: "NEW.0|yesterday|issue-1" }))
        .ok,
    ).toBe(false);
    // The shape this service wrote before statuses became the board's: the
    // pattern refuses it rather than reading it as a page.
    expect(
      (
        await parse(held("issue_list"), {
          after: "NEW|2027-01-20T09:00:00.000Z|issue-1",
        })
      ).ok,
    ).toBe(false);
  });

  it("publishes the cursor's shape, which the refine is lost from", () => {
    const { held } = build();
    const document = actionInputJsonSchema(
      held("issue_list").input,
      "issue_list",
    ) as {
      properties: { after: { type: string; pattern?: string } };
    };
    const after = document.properties.after;

    expect(after.type).toBe("string");
    expect(after.pattern).toBeTypeOf("string");
    const published = new RegExp(after.pattern ?? "");

    // Everything the service hands out matches it and reads back, in every
    // meaning and at every position a status can hold.
    for (const meaning of ISSUE_STATUS_MEANINGS) {
      for (const position of [0, 7, ISSUE_STATUS_LIMITS.sortOrder]) {
        const cursor = issueQueueCursor({
          meaning,
          position,
          createdAt: new Date("2027-01-20T09:00:00.000Z"),
          id: "cm1abcdefghijklmnop",
        });
        expect(cursor).toMatch(published);
        expect(parseIssueQueueCursor(cursor)).toMatchObject({
          meaning,
          position,
        });
      }
    }
    // And the shapes that never name a page do not.
    for (const value of [
      "page-2",
      "",
      "OPEN.0|2027-01-20T09:00:00.000Z|issue-1",
      "NEW|2027-01-20T09:00:00.000Z|issue-1",
      "NEW.|2027-01-20T09:00:00.000Z|issue-1",
      "NEW.1000|2027-01-20T09:00:00.000Z|issue-1",
      "NEW.0|2027-01-20|issue-1",
      "NEW.0|2027-01-20T09:00:00.000Z|",
      "NEW.0|2027-01-20T09:00:00.000Z|issue-1|more",
    ]) {
      expect(value).not.toMatch(published);
    }
  });

  it("reads at most twenty at a time", async () => {
    const { held } = build();

    expect((await parse(held("issue_list"), { limit: 20 })).ok).toBe(true);
    expect((await parse(held("issue_list"), { limit: 21 })).ok).toBe(false);
  });

  it("gives an external reporter's name and never their address", async () => {
    const { held } = build();

    const page = await call(held("issue_list"), {});
    const issues = page.issues as Record<string, unknown>[];

    expect(issues[1]?.reporter).toEqual({
      kind: "external",
      name: "Gunnar Förbipasserande",
    });
    expect(JSON.stringify(page)).not.toContain("gunnar@exempel.se");
  });

  it("counts the photographs and hands over none of them", async () => {
    const { held } = build();

    const page = await call(held("issue_list"), {});
    const issues = page.issues as Record<string, unknown>[];

    expect(issues[0]?.photoCount).toBe(1);
    expect(JSON.stringify(page)).not.toContain("/api/media/");
    expect(JSON.stringify(page)).not.toContain("tak.jpg");
  });
});

describe("issue_get", () => {
  it("asks the service for the issue, leaving a protected reporter's out", async () => {
    const { held, queuedIssue } = build();

    const issue = await call(held("issue_get"), { id: "issue-1" });

    expect(queuedIssue).toHaveBeenCalledWith(
      "person-manager",
      "issue-1",
      "omit",
    );
    expect(issue).toEqual({
      id: "issue-1",
      number: 7,
      status: { id: "status-water-new", meaning: "NEW", label: "Ny" },
      waitingReason: null,
      outcome: null,
      type: {
        id: "type-water",
        name: "Vatten",
        reporters: ["PUBLIC", "RESIDENTS"],
      },
      location: "Badrummet",
      description: "Det droppar från taket.",
      apartment: {
        id: "apartment-1",
        number: "1001",
        address: "Storgatan 12",
      },
      reporter: { kind: "resident", personId: "person-rut", name: "Rut Ek" },
      enteredByHandler: false,
      priority: "NORMAL",
      targetDate: null,
      overdue: false,
      assignee: null,
      boardOnly: false,
      photoCount: 1,
      createdAt: "2027-01-20T09:00:00.000Z",
      updatedAt: "2027-01-20T09:00:00.000Z",
      closedAt: null,
    });
  });

  it("publishes no protected branch, even if the service handed one over", async () => {
    /*
     * The service never does: it leaves such an issue out. This is the second
     * line, so that a later change to the service turns into an unnamed
     * reporter rather than a branch the published document does not declare.
     */
    const { held } = build([
      {
        ...QUEUED,
        apartment: null,
        reporter: { kind: "protected" },
      },
    ]);

    const issue = await call(held("issue_get"), { id: "issue-1" });

    expect(issue.reporter).toEqual({ kind: "unknown" });
    expect(JSON.stringify(issue)).not.toContain("protected");
  });

  it("gives an assignee whose name is withheld by their identifier alone", async () => {
    const { held } = build([
      {
        ...QUEUED,
        assignee: { kind: "protected", personId: "person-hidden" },
        targetDate: "2027-01-31",
        overdue: true,
        priority: "URGENT",
      },
    ]);

    const issue = await call(held("issue_get"), { id: "issue-1" });

    expect(issue).toMatchObject({
      assignee: { kind: "protected", personId: "person-hidden" },
      targetDate: "2027-01-31",
      overdue: true,
      priority: "URGENT",
    });
  });
});

describe("issue_type_list", () => {
  it("gives every type the caller handles, active or not, and declares the free text of the names", async () => {
    const { held, handledTypes } = build();

    const answer = await call(held("issue_type_list"), {});

    // As a read leaving the instance: a ring-fenced type is left out inside
    // the service (ADR 0056).
    expect(handledTypes).toHaveBeenCalledWith("person-manager", "omit");
    expect(answer).toEqual({
      types: [
        {
          id: "type-water",
          title: "Vatten",
          reporters: ["PUBLIC", "RESIDENTS"],
          active: true,
          handledBy: "EVERY_HANDLER",
          defaultPriority: "URGENT",
          // The meanings and the board's labels; not the counts, which are
          // the board's screen's.
          statuses: [
            {
              id: "status-water-new",
              meaning: "NEW",
              label: "Ny",
              isDefault: true,
              active: true,
            },
            {
              id: "status-water-parts",
              meaning: "WAITING",
              label: "Väntar på reservdelar",
              isDefault: false,
              active: false,
            },
          ],
        },
        {
          id: "type-old-lock",
          title: "Lås (gammal)",
          reporters: ["HANDLERS"],
          active: false,
          handledBy: "EVERY_HANDLER",
          defaultPriority: "NORMAL",
          statuses: [],
        },
      ],
    });
    expect(held("issue_type_list").personalData).toEqual(["freeText"]);
  });

  it("takes nothing", async () => {
    const { held } = build();

    expect((await parse(held("issue_type_list"), { all: true })).ok).toBe(
      false,
    );
  });
});

describe("issue_handler_list", () => {
  it("names who the issue may be given to, withholding a protected name", async () => {
    const { held, handlers } = build();

    const answer = await call(held("issue_handler_list"), { id: "issue-1" });

    expect(handlers).toHaveBeenCalledWith("person-manager", "issue-1", "omit");
    expect(answer).toEqual({
      handlers: [
        { kind: "person", personId: "person-board", name: "Bea Styrelse" },
        { kind: "protected", personId: "person-hidden" },
      ],
    });
  });
});

describe("the writes", () => {
  it("assign as the caller, on the channel they came by, and answer with the assignee alone", async () => {
    const { held, assign } = build();

    const answer = await call(held("issue_assign"), {
      id: "issue-1",
      assigneePersonId: "person-hidden",
    });

    expect(assign).toHaveBeenCalledWith(
      "issue-1",
      "person-hidden",
      {
        personId: "person-manager",
        channel: "MCP",
        clientId: "client-1",
        clientHost: "app.example",
        requestId: "request-1",
      },
      "omit",
    );
    expect(answer).toEqual({
      id: "issue-1",
      assignee: { kind: "protected", personId: "person-hidden" },
    });
  });

  it("leave an issue with nobody", async () => {
    const { held, assign } = build();

    const answer = await call(held("issue_assign"), {
      id: "issue-1",
      assigneePersonId: null,
    });

    expect(assign.mock.calls[0]?.[1]).toBeNull();
    expect(answer).toEqual({ id: "issue-1", assignee: null });
  });

  it("set the priority and the target date, answering with what they changed", async () => {
    const { held, setPriority, setTargetDate } = build();

    expect(
      await call(held("issue_set_priority"), {
        id: "issue-1",
        priority: "URGENT",
      }),
    ).toEqual({ id: "issue-1", priority: "URGENT" });
    expect(setPriority.mock.calls[0]?.[3]).toBe("omit");

    expect(
      await call(held("issue_set_target_date"), {
        id: "issue-1",
        targetDate: "2027-01-31",
      }),
    ).toEqual({ id: "issue-1", targetDate: "2027-01-31", overdue: true });
    expect(setTargetDate.mock.calls[0]?.[3]).toBe("omit");
    expect(
      (
        await parse(held("issue_set_target_date"), {
          id: "issue-1",
          targetDate: "31 januari",
        })
      ).ok,
    ).toBe(false);
  });

  it("move the status with what its meaning requires, and answer with the status alone", async () => {
    const { held, setStatus } = build();

    const answer = await call(held("issue_set_status"), {
      id: "issue-1",
      statusId: "status-water-done",
      outcome: "FIXED",
    });

    expect(setStatus).toHaveBeenCalledWith(
      "issue-1",
      { statusId: "status-water-done", outcome: "FIXED" },
      expect.objectContaining({ personId: "person-manager", channel: "MCP" }),
      "omit",
    );
    expect(answer).toEqual({
      id: "issue-1",
      status: { id: "status-water-done", meaning: "DONE", label: "Klar" },
      waitingReason: null,
      outcome: "FIXED",
      closedAt: "2027-02-01T08:00:00.000Z",
    });
    // A duplicate is merged on the board's own screen, never closed here.
    expect(
      (
        await parse(held("issue_set_status"), {
          id: "issue-1",
          statusId: "status-water-done",
          outcome: "DUPLICATE",
        })
      ).ok,
    ).toBe(false);
  });

  it("hand back nothing of the reporter, the description or the place", async () => {
    const { held } = build();

    for (const [name, input] of [
      ["issue_assign", { id: "issue-1", assigneePersonId: null }],
      ["issue_set_priority", { id: "issue-1", priority: "LOW" }],
      ["issue_set_target_date", { id: "issue-1", targetDate: null }],
      [
        "issue_set_status",
        { id: "issue-1", statusId: "status-water-done", outcome: "FIXED" },
      ],
    ] as const) {
      const text = JSON.stringify(await call(held(name), input));
      expect(text, name).not.toContain("Rut Ek");
      expect(text, name).not.toContain("Det droppar");
      expect(text, name).not.toContain("Badrummet");
      expect(text, name).not.toContain("1001");
    }
  });
});

describe("a write held as a pending change", () => {
  it("shows the issue it names as the viewer reads it, and what confirming sets", async () => {
    const { held, queuedIssue } = build();
    const target = held("issue_set_priority").target;

    const facts = await target?.read(
      { id: "issue-1", priority: "URGENT" },
      "person-viewer",
    );

    // As the viewer, and as the write itself will read it.
    expect(queuedIssue).toHaveBeenCalledWith(
      "person-viewer",
      "issue-1",
      "omit",
    );
    expect(facts).toEqual([
      { fact: "number", now: "7" },
      { fact: "type", now: "Vatten" },
      { fact: "issueStatus", now: "Ny" },
      { fact: "priority", now: "NORMAL", after: "URGENT" },
      { fact: "targetDate", now: "" },
    ]);
  });

  it("names the status a move is to by the board's label, with what the move sets beside it", async () => {
    const { held, statusOfType } = build();
    statusOfType.mockResolvedValueOnce({
      label: "Väntar på reservdelar",
      meaning: "WAITING",
      active: true,
    });

    const facts = await held("issue_set_status").target?.read(
      { id: "issue-1", statusId: "status-water-parts", waitingReason: "PARTS" },
      "person-viewer",
    );

    // Looked up by the issue's own type, which the viewer has just read.
    expect(statusOfType).toHaveBeenCalledWith(
      "type-water",
      "status-water-parts",
    );
    expect(facts).toEqual([
      { fact: "number", now: "7" },
      { fact: "type", now: "Vatten" },
      { fact: "issueStatus", now: "Ny", after: "Väntar på reservdelar" },
      { fact: "waitingReason", now: "", after: "PARTS" },
      { fact: "outcome", now: "", after: "" },
      { fact: "priority", now: "NORMAL" },
      { fact: "targetDate", now: "" },
    ]);
  });

  it("shows the outcome a closing sets, and the one a move between two DONE statuses keeps", async () => {
    const { held, statusOfType, queuedIssue } = build();
    statusOfType.mockResolvedValue({
      label: "Klar",
      meaning: "DONE",
      active: true,
    });
    const target = held("issue_set_status").target;

    expect(
      await target?.read(
        { id: "issue-1", statusId: "status-water-done", outcome: "FIXED" },
        "person-viewer",
      ),
    ).toContainEqual({ fact: "outcome", now: "", after: "FIXED" });

    queuedIssue.mockResolvedValueOnce({
      ...QUEUED,
      meaning: "DONE",
      status: { id: "status-water-closed", label: "Stängd" },
      outcome: "NO_FAULT",
    });
    expect(
      await target?.read(
        { id: "issue-1", statusId: "status-water-done" },
        "person-viewer",
      ),
    ).toContainEqual({ fact: "outcome", now: "NO_FAULT", after: "NO_FAULT" });
  });

  it("names a status confirming would refuse by its id alone, and sets nothing beside it", async () => {
    const { held, statusOfType } = build();
    const target = held("issue_set_status").target;

    // Switched off, and not the status the issue stands in.
    const switchedOff = await target?.read(
      { id: "issue-1", statusId: "status-water-parts", waitingReason: "PARTS" },
      "person-viewer",
    );
    expect(switchedOff).toContainEqual({
      fact: "issueStatus",
      now: "Ny",
      after: "status-water-parts",
    });
    expect(switchedOff).toContainEqual({ fact: "waitingReason", now: "" });

    // Not one of the type's.
    statusOfType.mockResolvedValueOnce(null);
    expect(
      await target?.read(
        { id: "issue-1", statusId: "status-other-type" },
        "person-viewer",
      ),
    ).toContainEqual({
      fact: "issueStatus",
      now: "Ny",
      after: "status-other-type",
    });
  });

  it("shows who has an issue now and who confirming an assignment gives it to", async () => {
    const { held, queuedIssue } = build();
    const target = held("issue_assign").target;

    // Given from nobody.
    expect(
      await target?.read(
        { id: "issue-1", assigneePersonId: "person-board" },
        "person-viewer",
      ),
    ).toContainEqual({ fact: "assignee", now: "", after: "person-board" });

    // Taken from a handler whose name is withheld, by their id alone.
    queuedIssue.mockResolvedValueOnce({
      ...QUEUED,
      assignee: { kind: "protected", personId: "person-hidden" },
    });
    expect(
      await target?.read(
        { id: "issue-1", assigneePersonId: null },
        "person-viewer",
      ),
    ).toContainEqual({ fact: "assignee", now: "person-hidden", after: "" });

    // An assignee the register no longer holds has no id, and is not said to
    // be nobody: the fact is left out.
    queuedIssue.mockResolvedValueOnce({
      ...QUEUED,
      assignee: { kind: "unknown" },
    });
    const facts = await target?.read(
      { id: "issue-1", assigneePersonId: "person-board" },
      "person-viewer",
    );
    expect(facts?.map((fact) => fact.fact)).not.toContain("assignee");

    // Only an assignment shows it.
    expect(
      (
        await held("issue_set_priority").target?.read(
          { id: "issue-1", priority: "LOW" },
          "person-viewer",
        )
      )?.map((fact) => fact.fact),
    ).not.toContain("assignee");
  });

  it("says an issue the viewer may not open, or one left out, is gone", async () => {
    const { held, queuedIssue } = build();
    queuedIssue.mockRejectedValueOnce(
      new IssueError("No such issue.", "issue-not-found"),
    );

    expect(
      await held("issue_assign").target?.read(
        { id: "issue-1", assigneePersonId: null },
        "person-viewer",
      ),
    ).toBeNull();
  });

  it("names an assignee this issue's picker would name for the viewer, and nobody else", async () => {
    const { inputNames, handlers, queuedIssue } = build();
    const viewer = {
      personId: "person-viewer",
      capabilities: new Set(["issues:handle"]),
    } as never;

    expect(
      await inputNames.namesOf(
        "issue_assign",
        { id: "issue-1", assigneePersonId: "person-board" },
        viewer,
      ),
    ).toEqual({ "person-board": { text: "Bea Styrelse", kind: "text" } });
    // Read as the viewer, for this issue, as issue_handler_list reads it.
    expect(handlers).toHaveBeenCalledWith("person-viewer", "issue-1", "omit");
    // A handler whose name is withheld, and somebody who does not handle this
    // issue, are left as their identifier.
    for (const assigneePersonId of ["person-hidden", "person-elsewhere"]) {
      expect(
        await inputNames.namesOf(
          "issue_assign",
          { id: "issue-1", assigneePersonId },
          viewer,
        ),
      ).toEqual({});
    }
    // The assignee it replaces is named on the same terms, beside the one it
    // sets; one whose name is withheld is left as their identifier.
    queuedIssue.mockResolvedValueOnce({
      ...QUEUED,
      assignee: { kind: "person", personId: "person-board", name: "Bea" },
    });
    expect(
      await inputNames.namesOf(
        "issue_assign",
        { id: "issue-1", assigneePersonId: null },
        viewer,
      ),
    ).toEqual({ "person-board": { text: "Bea Styrelse", kind: "text" } });
    queuedIssue.mockResolvedValueOnce({
      ...QUEUED,
      assignee: { kind: "protected", personId: "person-hidden" },
    });
    expect(
      await inputNames.namesOf(
        "issue_assign",
        { id: "issue-1", assigneePersonId: null },
        viewer,
      ),
    ).toEqual({});
    // An issue the viewer may not open names nobody.
    queuedIssue.mockRejectedValueOnce(
      new IssueError("No such issue.", "issue-not-found"),
    );
    expect(
      await inputNames.namesOf(
        "issue_assign",
        { id: "issue-1", assigneePersonId: "person-board" },
        viewer,
      ),
    ).toEqual({});
    handlers.mockRejectedValueOnce(
      new IssueError("No such issue.", "issue-not-found"),
    );
    expect(
      await inputNames.namesOf(
        "issue_assign",
        { id: "issue-1", assigneePersonId: "person-board" },
        viewer,
      ),
    ).toEqual({});
    // Nobody is asked for a viewer who no longer handles issues.
    handlers.mockClear();
    expect(
      await inputNames.namesOf(
        "issue_assign",
        { id: "issue-1", assigneePersonId: "person-board" },
        { personId: "person-viewer", capabilities: new Set<string>() } as never,
      ),
    ).toEqual({});
    expect(handlers).not.toHaveBeenCalled();
  });
});

/**
 * Why the MCP Connector was offered no issue action (decision 34 of the issue
 * module's plan, ADR 0056).
 *
 * The connector is a plugin, and lists and calls actions through
 * `host.actions` on its own route, as the person on the other end of a
 * connected app's token. The registry offers a plugin only the actions whose
 * `personalData` its manifest declares, and refuses the others with
 * `forbidden-surface`. The connector's manifest declared none, so it was
 * offered no action that declares any: every issue read, `issue_assign` and
 * `issue_set_status`. Asked here of a real registry holding the real
 * definitions: the day the connector's manifest declares what an action
 * carries, it is offered that action.
 */
describe("what the MCP Connector is offered", () => {
  const CONNECTOR = { id: "mcp-connector", ai: false } as const;
  const EVERYTHING_THEY_CARRY = ["name", "apartment", "freeText", "health"];

  function registryWith(declared: readonly string[]) {
    const callers = new ActionCallerFactory();
    const principal = {
      personId: "person-manager",
      capabilities: new Set(["issues:handle"]),
    } as unknown as Principal;
    const registry = new ActionRegistryService(
      callers,
      {
        forPerson: vi.fn(async () => principal),
      } as unknown as PrincipalService,
      { translatorFor: () => (key: string) => key } as unknown as I18nService,
      {
        OPENBRF_ACTIONS_READ_ONLY: false,
        APP_URL: "https://brf.example",
      } as unknown as Env,
      {
        declared: true,
        path: "/api/plugin/mcp-connector/mcp",
        url: "https://brf.example/api/plugin/mcp-connector/mcp",
      },
    );
    const { queuedIssue } = build();
    new IssueActionsRegistrar(
      { queuedIssue } as unknown as IssueService,
      new CoreActionRegistrar(registry),
      new ActionInputNames(),
    ).onModuleInit();
    registry.bindLiveness({
      get: async (pluginId: string) =>
        pluginId === CONNECTOR.id
          ? {
              serving: true,
              armedActions: [],
              capabilityFloor: ["self:manage"],
              personalData: declared,
              manifestPersonalData: declared,
              websiteBlocks: false,
            }
          : null,
    });

    // A connected app's token on the connector's own route.
    const request = {
      id: "request-connector",
      principal: { personId: "person-manager" },
      token: {
        clientId: "client-1",
        clientHost: "app.example",
        scopes: ["mcp:read", "mcp:write"],
        tokenRowId: "token-1",
      },
    } as unknown as RequestWithToken;
    markAuthenticated(request, new LiveResponse(), {
      personId: "person-manager",
      token: request.token ?? null,
      requestId: request.id,
    });
    const caller = callers.forPlugin(request, CONNECTOR);
    return { registry, caller, queuedIssue };
  }

  it("was offered no issue action that carries personal data while its manifest declared none", async () => {
    const { registry, caller, queuedIssue } = registryWith([]);

    const offered = (await registry.list(caller)).map((action) => action.name);

    // Only the two writes whose answer carries no personal data are left.
    expect(offered).toEqual(["issue_set_priority", "issue_set_target_date"]);
    const refusal = await registry
      .invoke(caller, "issue_get", { id: "issue-1" })
      .catch((cause: unknown) => cause);
    expect(refusal).toMatchObject({ reason: "forbidden-surface" });
    expect((refusal as { details: () => unknown }).details()).toEqual({
      personalData: ["name", "apartment", "freeText", "health"],
    });
    expect(queuedIssue).not.toHaveBeenCalled();
  });

  it("is offered every issue action once its manifest declares what they carry", async () => {
    const { registry, caller, queuedIssue } = registryWith(
      EVERYTHING_THEY_CARRY,
    );

    expect(
      (await registry.list(caller)).map((action) => action.name).sort(),
    ).toEqual([...READS, ...WRITES].sort());
    await registry.invoke(caller, "issue_get", { id: "issue-1" });
    expect(queuedIssue).toHaveBeenCalledWith(
      "person-manager",
      "issue-1",
      "omit",
    );
  });

  it("is offered each issue action by the categories that action carries alone", async () => {
    const name = registryWith(["name"]);
    expect(
      (await name.registry.list(name.caller))
        .map((action) => action.name)
        .sort(),
    ).toEqual([
      "issue_assign",
      "issue_handler_list",
      "issue_set_priority",
      "issue_set_target_date",
    ]);
    const freeText = registryWith(["freeText"]);
    expect(
      (await freeText.registry.list(freeText.caller))
        .map((action) => action.name)
        .sort(),
    ).toEqual([
      "issue_set_priority",
      "issue_set_status",
      "issue_set_target_date",
      "issue_type_list",
    ]);
  });
});
