import type { ActionContext, ActionDefinition } from "@openbrf/plugin-sdk";
import { describe, expect, it, vi } from "vitest";

import type { CoreActionRegistrar } from "../actions/action-registrar";
import { NewsCommentActionsRegistrar } from "./news-comment-actions.registrar";
import { type NewsCommentService, threadCursor } from "./news-comment.service";

/**
 * The first two actions in the product that name a person.
 *
 * Three things are asserted here and nowhere else. That the reader the service
 * is asked about is the caller the registry resolved, because the thread's one
 * decision - whether a struck-through comment's text is withheld - is made from
 * it. That a cursor the platform did not hand out is refused by the published
 * document rather than read leniently. And that a protected author leaves as a
 * branch of its own: the shape is the whole of rule 1's second half, because a
 * model reading an empty name concludes the association holds nothing while one
 * reading a branch named `protected` concludes the value is withheld.
 */

const PROTECTED_AUTHOR = {
  id: "comment-1",
  author: { kind: "protected" as const, personId: "person-maja" },
  body: "Porten står öppen på nätterna.",
  hiddenAt: null,
  createdAt: "2026-09-01T09:00:00.000Z",
};

function build() {
  const list = vi.fn(
    async (
      _newsId: string,
      _reader: { personId: string; capabilities: ReadonlySet<string> },
      _before: { createdAt: Date; id: string } | null,
    ) => ({ comments: [PROTECTED_AUTHOR], earlier: null }),
  );
  const hide = vi.fn(async (_commentId: string, _actor: unknown) => ({
    ...PROTECTED_AUTHOR,
    hiddenAt: "now",
  }));
  const registered: ActionDefinition[] = [];
  const registrar = {
    register: (_module: string, definitions: readonly ActionDefinition[]) => {
      registered.push(...definitions);
    },
  } as unknown as CoreActionRegistrar;

  new NewsCommentActionsRegistrar(
    { list, hide } as unknown as NewsCommentService,
    registrar,
  ).onModuleInit();

  const held = (name: string): ActionDefinition => {
    const action = registered.find((entry) => entry.name === name);
    if (action === undefined) {
      throw new Error(`${name} was not registered`);
    }
    return action;
  };

  return { list, hide, registered, held };
}

const BOARD_MEMBER = {
  principal: { personId: "person-board", capabilities: ["site:manage"] },
  channel: "mcp",
  client: { clientId: "client-1", clientHost: "app.example" },
  requestId: "request-1",
  now: new Date("2026-09-18T08:00:00.000Z"),
} as unknown as ActionContext;

async function parse(
  action: ActionDefinition,
  input: unknown,
): Promise<{ ok: boolean }> {
  const result = await action.input["~standard"].validate(input);
  return { ok: result.issues === undefined };
}

describe("what the comments group registers", () => {
  it("is the read and the strike-through, and nothing else", () => {
    const { registered } = build();

    expect(registered.map((action) => action.name).sort()).toEqual([
      "news_comment_hide",
      "news_comment_list",
    ]);
  });

  it("declares the name and the free text, and never protected", () => {
    /*
     * The declaration is honest because the masking decision is inside the
     * service method the handler calls: a protected author's name is withheld
     * in `authorViewOf`, so the action inherits the decision rather than
     * reaching past it. Declaring `protected` would have been the dishonest
     * safe answer, and it would have barred the action from a connected app
     * altogether.
     */
    const { registered } = build();

    for (const action of registered) {
      expect([...action.personalData].sort(), action.name).toEqual([
        "freeText",
        "name",
      ]);
      expect(action.surfaces, action.name).toEqual(["ui", "mcp"]);
    }
  });

  it("says a strike-through cannot be undone and needs answering for", () => {
    // Not a row deletion: the comment stays and keeps its author. But nothing
    // clears the date, there is no un-hide route, and `delete` is the effect
    // whose annotation says "no undo" - `write` would tell a client the act is
    // reversible.
    const { held } = build();
    const action = held("news_comment_hide");

    expect(action.effect).toBe("delete");
    expect(action.needsConfirmation).toBe(true);
    expect(action.idempotent).toBe(true);
  });
});

describe("reading a thread through an action", () => {
  it("asks the service about the caller the registry resolved", async () => {
    // The thread's one decision is made from the reader, so a handler that
    // invented one would decide whether a struck-through comment's text is
    // withheld from somebody other than the caller.
    const { list, held } = build();

    await held("news_comment_list").handler({ newsId: "news-1" }, BOARD_MEMBER);

    expect(list.mock.calls[0]?.[0]).toBe("news-1");
    const reader = list.mock.calls[0]?.[1];
    expect(reader?.personId).toBe("person-board");
    expect(reader?.capabilities.has("site:manage")).toBe(true);
  });

  it("publishes a protected author as a branch rather than as an empty name", async () => {
    const { held } = build();

    const answer = (await held("news_comment_list").handler(
      { newsId: "news-1" },
      BOARD_MEMBER,
    )) as { comments: { author: Record<string, unknown> }[] };

    expect(answer.comments[0]?.author).toEqual({
      kind: "protected",
      personId: "person-maja",
    });
    // And the output schema is what publishes it, so a name added to that
    // branch by a later change is refused on the way out.
    const validated = await held("news_comment_list").output[
      "~standard"
    ].validate({
      comments: [
        {
          ...PROTECTED_AUTHOR,
          author: {
            kind: "protected",
            personId: "person-maja",
            name: "Maja Medlem",
          },
        },
      ],
      earlier: null,
    });
    expect(validated.issues).toBeDefined();
  });

  it("refuses a cursor this platform did not hand out", async () => {
    /*
     * Refused by the published document rather than in the handler, exactly as
     * the controller refuses it. Answering the newest page to a caller asking
     * for an older one would tell it the thread ends where it does not.
     */
    const { held } = build();
    const action = held("news_comment_list");

    expect(await parse(action, { newsId: "news-1" })).toEqual({ ok: true });
    expect(
      await parse(action, {
        newsId: "news-1",
        before: threadCursor({
          id: "comment-1",
          createdAt: new Date("2026-09-01T09:00:00.000Z"),
        }),
      }),
    ).toEqual({ ok: true });
    expect(await parse(action, { newsId: "news-1", before: "page 2" })).toEqual(
      { ok: false },
    );
  });

  it("passes the parsed cursor on to the service", async () => {
    const { list, held } = build();
    const createdAt = new Date("2026-09-01T09:00:00.000Z");

    await held("news_comment_list").handler(
      {
        newsId: "news-1",
        before: threadCursor({ id: "comment-1", createdAt }),
      },
      BOARD_MEMBER,
    );

    expect(list.mock.calls[0]?.[2]).toEqual({ createdAt, id: "comment-1" });
  });
});

describe("striking a comment through an action", () => {
  it("hands the service the caller the registry resolved", async () => {
    const { hide, held } = build();

    await held("news_comment_hide").handler({ id: "comment-1" }, BOARD_MEMBER);

    expect(hide.mock.calls[0]?.[0]).toBe("comment-1");
    expect(hide.mock.calls[0]?.[1]).toEqual({
      personId: "person-board",
      channel: "MCP",
      clientId: "client-1",
      clientHost: "app.example",
      requestId: "request-1",
    });
  });
});
