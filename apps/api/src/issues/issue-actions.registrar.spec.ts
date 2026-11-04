import {
  actionInputJsonSchema,
  type ActionContext,
  type ActionDefinition,
} from "@openbrf/plugin-sdk";
import { ISSUE_STATUS_LIMITS, ISSUE_STATUS_MEANINGS } from "@openbrf/shared";
import { describe, expect, it, vi } from "vite-plus/test";

import type { CoreActionRegistrar } from "../actions/action-registrar";
import { IssueActionsRegistrar } from "./issue-actions.registrar";
import type { IssueTypeView } from "./issue-type.service";
import {
  issueQueueCursor,
  parseIssueQueueCursor,
  type IssueService,
  type QueuedIssueView,
} from "./issue.service";

/**
 * The issue queue as reads for a caller outside the instance (ADR 0040).
 *
 * What only this spec shows is the narrowing between the service's view and
 * the published document: the email address and the photographs the screen
 * has are not in what a caller is handed, and every read asks the service to
 * leave a protected reporter's issue out. That the service then does is shown
 * against a real database in `issue-actions.int-spec.ts`.
 */

const QUEUED: QueuedIssueView = {
  id: "issue-1",
  meaning: "NEW",
  status: { id: "status-water-new", label: "Ny" },
  waitingReason: null,
  outcome: null,
  typeId: "type-water",
  typeName: "Vatten",
  typeReporters: ["PUBLIC", "RESIDENTS"],
  location: "Badrummet",
  description: "Det droppar från taket.",
  apartment: { id: "apartment-1", number: "1001", address: "Storgatan 12" },
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
  priority: "NORMAL",
  targetDate: null,
  overdue: false,
  assignee: null,
  enteredBy: null,
  boardOnly: false,
  legalHoldAt: null,
  costResponsibility: null,
};

const EXTERNAL: QueuedIssueView = {
  ...QUEUED,
  id: "issue-2",
  apartment: null,
  photos: [],
  reporter: {
    kind: "external",
    name: "Gunnar Förbipasserande",
    email: "gunnar@exempel.se",
  },
};

const TYPES: IssueTypeView[] = [
  {
    id: "type-water",
    name: "Vatten",
    reporters: ["PUBLIC", "RESIDENTS"],
    handledBy: "EVERY_HANDLER",
    defaultPriority: "URGENT",
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
    statuses: [],
  },
];

function build(issues: QueuedIssueView[] = [QUEUED, EXTERNAL]) {
  const handledTypes = vi.fn(async (_reader: string) => TYPES);
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
  const registered: ActionDefinition[] = [];
  const registrar = {
    register: (_module: string, definitions: readonly ActionDefinition[]) => {
      registered.push(...definitions);
    },
  } as unknown as CoreActionRegistrar;

  new IssueActionsRegistrar(
    { pageOfQueue, queuedIssue, handledTypes } as unknown as IssueService,
    registrar,
  ).onModuleInit();

  const held = (name: string): ActionDefinition => {
    const action = registered.find((entry) => entry.name === name);
    if (action === undefined) {
      throw new Error(`${name} was not registered`);
    }
    return action;
  };

  return { pageOfQueue, queuedIssue, handledTypes, registered, held };
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

describe("what the issues group registers", () => {
  it("is three reads and nothing that changes an issue", () => {
    const { registered } = build();

    expect(registered.map((action) => action.name).sort()).toEqual([
      "issue_get",
      "issue_list",
      "issue_type_list",
    ]);
    for (const action of registered) {
      expect(action.effect, action.name).toBe("read");
    }
  });

  it("needs what the queue's own controller needs, beyond the instance only", () => {
    const { registered } = build();

    for (const action of registered) {
      expect(action.capability, action.name).toBe("issues:handle");
      expect(action.surfaces, action.name).toEqual(["mcp", "ai"]);
    }
  });

  it("declares what a report can carry, and never protected data", () => {
    const { registered } = build();

    for (const action of registered.filter(
      (held) => held.name !== "issue_type_list",
    )) {
      expect([...action.personalData].sort(), action.name).toEqual([
        "apartment",
        "freeText",
        "health",
        "name",
      ]);
      expect(action.personalData, action.name).not.toContain("protected");
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
});

describe("issue_type_list", () => {
  it("gives every type the caller handles, active or not, and declares the free text of the names", async () => {
    const { held, handledTypes } = build();

    const answer = await call(held("issue_type_list"), {});

    expect(handledTypes).toHaveBeenCalledWith("person-manager");
    expect(answer).toEqual({
      types: [
        {
          id: "type-water",
          title: "Vatten",
          reporters: ["PUBLIC", "RESIDENTS"],
          active: true,
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
