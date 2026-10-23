import {
  actionInputJsonSchema,
  type ActionContext,
  type ActionDefinition,
} from "@openbrf/plugin-sdk";
import { describe, expect, it, vi } from "vite-plus/test";

import type { CoreActionRegistrar } from "../actions/action-registrar";
import { IssueActionsRegistrar } from "./issue-actions.registrar";
import type { IssueTypeService, IssueTypeView } from "./issue-type.service";
import {
  issueQueueCursor,
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
  status: "NEW",
  typeId: "type-water",
  typeName: "Vatten",
  audience: "MEMBER",
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
  createdAt: "2027-01-20T09:00:00.000Z",
  updatedAt: "2027-01-20T09:00:00.000Z",
  closedAt: null,
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
    audience: "MEMBER",
    active: true,
    sortOrder: 0,
    reportCount: 4,
  },
  {
    id: "type-old-lock",
    name: "Lås (gammal)",
    audience: "BOARD",
    active: false,
    sortOrder: 1,
    reportCount: 1,
  },
];

function build(issues: QueuedIssueView[] = [QUEUED, EXTERNAL]) {
  const listAll = vi.fn(async () => TYPES);
  const pageOfQueue = vi.fn(async (_filter: unknown, _which: string) => ({
    issues,
    nextCursor: null,
  }));
  const queuedIssue = vi.fn(
    async (_id: string, _which: string) => issues[0] as QueuedIssueView,
  );
  const registered: ActionDefinition[] = [];
  const registrar = {
    register: (_module: string, definitions: readonly ActionDefinition[]) => {
      registered.push(...definitions);
    },
  } as unknown as CoreActionRegistrar;

  new IssueActionsRegistrar(
    { pageOfQueue, queuedIssue } as unknown as IssueService,
    { listAll } as unknown as IssueTypeService,
    registrar,
  ).onModuleInit();

  const held = (name: string): ActionDefinition => {
    const action = registered.find((entry) => entry.name === name);
    if (action === undefined) {
      throw new Error(`${name} was not registered`);
    }
    return action;
  };

  return { pageOfQueue, queuedIssue, listAll, registered, held };
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
      status: "NEW",
      audience: "BOARD",
      typeId: "type-water",
    });

    expect(pageOfQueue).toHaveBeenCalledWith(
      {
        status: "NEW",
        typeId: "type-water",
        audience: "BOARD",
        limit: 10,
        after: null,
      },
      "omit",
    );
  });

  it("hands the cursor back to the service as the place it names", async () => {
    const { held, pageOfQueue } = build();
    const after = {
      status: "IN_PROGRESS" as const,
      createdAt: new Date("2027-01-20T09:00:00.000Z"),
      id: "issue-9",
    };

    await call(held("issue_list"), {
      after: issueQueueCursor(after),
      limit: 5,
    });

    expect(pageOfQueue).toHaveBeenCalledWith(
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
      (await parse(held("issue_list"), { after: "NEW|yesterday|issue-1" })).ok,
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

    // Everything the service hands out matches it, in every status.
    for (const status of ["NEW", "IN_PROGRESS", "DONE"] as const) {
      expect(
        issueQueueCursor({
          status,
          createdAt: new Date("2027-01-20T09:00:00.000Z"),
          id: "cm1abcdefghijklmnop",
        }),
      ).toMatch(published);
    }
    // And the shapes that never name a page do not.
    for (const value of [
      "page-2",
      "",
      "OPEN|2027-01-20T09:00:00.000Z|issue-1",
      "NEW|2027-01-20|issue-1",
      "NEW|2027-01-20T09:00:00.000Z|",
      "NEW|2027-01-20T09:00:00.000Z|issue-1|more",
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

    expect(queuedIssue).toHaveBeenCalledWith("issue-1", "omit");
    expect(issue).toEqual({
      id: "issue-1",
      status: "NEW",
      type: { id: "type-water", name: "Vatten", audience: "MEMBER" },
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
  it("gives every type, active or not, and declares the free text of the names", async () => {
    const { held, listAll } = build();

    const answer = await call(held("issue_type_list"), {});

    expect(listAll).toHaveBeenCalledOnce();
    expect(answer).toEqual({
      types: [
        {
          id: "type-water",
          title: "Vatten",
          audience: "MEMBER",
          active: true,
        },
        {
          id: "type-old-lock",
          title: "Lås (gammal)",
          audience: "BOARD",
          active: false,
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
