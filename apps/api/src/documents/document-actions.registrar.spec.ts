import type { ActionDefinition } from "@openbrf/plugin-sdk";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  ActionCallerFactory,
  type RequestWithToken,
} from "../actions/action-caller";
import { CoreActionRegistrar } from "../actions/action-registrar";
import { ActionRegistryService } from "../actions/action-registry.service";
import { markAuthenticated } from "../actions/authenticated-request";
import type { Principal } from "../authorization/capabilities";
import type { PrincipalService } from "../authorization/principal.service";
import type { Env } from "../config/env";
import type { I18nService } from "../i18n/i18n.service";
import { DocumentActionsRegistrar } from "./document-actions.registrar";
import type { DocumentText } from "./document-text";
import {
  DocumentError,
  type DocumentsService,
  type DocumentView,
} from "./documents.service";

/**
 * The document archive as reads for a connected app and the AI package (ADR
 * 0041).
 *
 * Asserted per action: who may call it - anybody with an account, through
 * `mcp`, and nobody through the board's own screen - and which shelves it
 * reaches, which is the members' and the public one and never the board's.
 */

const NAMES = ["document_list", "document_get"] as const;

const MINUTES: DocumentView = {
  id: "document-1",
  title: "Protokoll ordinarie föreningsstämma 2027",
  category: "Protokoll",
  audience: "MEMBER",
  fileName: "protokoll-2027.pdf",
  contentType: "application/pdf",
  byteSize: 48_213,
  url: "/api/media/file-1",
  uploadedAt: "2027-06-01T08:00:00.000Z",
};

const TEXT: DocumentText = {
  pageCount: 12,
  pages: [{ number: 1, text: "Protokoll fört vid ordinarie föreningsstämma" }],
  textLayer: true,
  truncated: false,
  next: { page: 2, character: 0 },
};

const BOARD_MEMBER = {
  personId: "person-board",
  capabilities: new Set(["self:manage", "documents:manage"]),
  isMember: false,
} as unknown as Principal;

function services(viewer: Principal | null = BOARD_MEMBER) {
  const list = vi.fn(async (_viewer: unknown, _narrowed?: unknown) => [
    MINUTES,
  ]);
  const readText = vi.fn(
    async (
      _id: string,
      _viewer: unknown,
      _range: unknown,
      _narrowed?: unknown,
    ) => ({
      document: MINUTES,
      text: TEXT,
    }),
  );
  const forPerson = vi.fn(async (_personId: string) => viewer);
  return {
    documents: { list, readText } as unknown as DocumentsService,
    principals: { forPerson } as unknown as PrincipalService,
    list,
    readText,
    forPerson,
  };
}

function registered(viewer: Principal | null = BOARD_MEMBER) {
  const built = services(viewer);
  const definitions: ActionDefinition[] = [];
  const registrar = {
    register: (_module: string, held: readonly ActionDefinition[]) => {
      definitions.push(...held);
    },
  } as unknown as CoreActionRegistrar;
  new DocumentActionsRegistrar(
    built.documents,
    built.principals,
    registrar,
  ).onModuleInit();

  const held = (name: string): ActionDefinition => {
    const action = definitions.find((entry) => entry.name === name);
    if (action === undefined) {
      throw new Error(`${name} was not registered`);
    }
    return action;
  };
  return { ...built, definitions, held };
}

const CONTEXT = {
  principal: { personId: "person-board", capabilities: ["self:manage"] },
  channel: "mcp" as const,
  requestId: "req-1",
  now: new Date("2027-06-02T08:00:00Z"),
};

describe("what the document reads declare", () => {
  const { definitions } = registered();

  it("registers the two reads and nothing that writes", () => {
    expect(definitions.map((action) => action.name)).toEqual([...NAMES]);
    for (const action of definitions) {
      expect(action.effect, action.name).toBe("read");
    }
  });

  it.each([...NAMES])("%s asks for what every account holds", (name) => {
    const action = definitions.find((entry) => entry.name === name);
    expect(action?.capability).toBe("self:manage");
  });

  it.each([...NAMES])("%s is offered on mcp and ai and not on ui", (name) => {
    const action = definitions.find((entry) => entry.name === name);
    expect([...(action?.surfaces ?? [])].sort()).toEqual(["ai", "mcp"]);
  });

  it.each([...NAMES])(
    "%s declares names and free text, and nothing protected",
    (name) => {
      const action = definitions.find((entry) => entry.name === name);
      expect([...(action?.personalData ?? [])].sort()).toEqual([
        "freeText",
        "name",
      ]);
    },
  );
});

describe("which shelves the reads reach", () => {
  it("lists the members' and the public shelf, never the board's", async () => {
    const { held, list } = registered();

    await held("document_list").handler(
      { search: "protokoll", limit: 20 },
      CONTEXT,
    );

    expect(list).toHaveBeenCalledWith(BOARD_MEMBER, {
      within: ["MEMBER", "PUBLIC"],
      matching: "protokoll",
      take: 21,
    });
  });

  it("reads a document on those shelves only", async () => {
    const { held, readText } = registered();

    await held("document_get").handler(
      { id: "document-1", fromPage: 3, fromCharacter: 0 },
      CONTEXT,
    );

    expect(readText).toHaveBeenCalledWith(
      "document-1",
      BOARD_MEMBER,
      { firstPage: 3, firstCharacter: 0, lastPage: 12 },
      { within: ["MEMBER", "PUBLIC"] },
    );
  });

  it("refuses a board document the service hands back, rather than publishing it", async () => {
    /*
     * The query narrows to the two shelves. This is what holds if that
     * narrowing were ever lost: a board document is refused as not found, the
     * answer it would get had it not existed.
     */
    const { held, list, readText } = registered();
    const boardPaper = { ...MINUTES, audience: "BOARD" as const };
    list.mockResolvedValueOnce([boardPaper]);
    readText.mockResolvedValueOnce({ document: boardPaper, text: TEXT });

    await expect(
      held("document_list").handler({ limit: 20 }, CONTEXT),
    ).rejects.toBeInstanceOf(DocumentError);
    await expect(
      held("document_get").handler({ id: "document-1", fromPage: 1 }, CONTEXT),
    ).rejects.toMatchObject({ reason: "not-found" });
  });

  it("reads the person again, because membership decides the members' shelf", async () => {
    const { held, forPerson } = registered();

    await held("document_list").handler({ limit: 20 }, CONTEXT);

    expect(forPerson).toHaveBeenCalledWith("person-board");
  });

  it("answers a person who is gone as a document that is not there", async () => {
    const { held, list } = registered(null);

    await expect(
      held("document_list").handler({ limit: 20 }, CONTEXT),
    ).rejects.toMatchObject({ reason: "not-found" });
    expect(list).not.toHaveBeenCalled();
  });
});

describe("what document_get answers with", () => {
  it("returns the pages, and the file's address stays in", async () => {
    const { held } = registered();

    const answer = await held("document_get").handler(
      { id: "document-1", fromPage: 1, fromCharacter: 0 },
      CONTEXT,
    );

    expect(answer).toEqual({
      id: "document-1",
      title: MINUTES.title,
      category: "Protokoll",
      audience: "MEMBER",
      fileName: "protokoll-2027.pdf",
      byteSize: 48_213,
      uploadedAt: MINUTES.uploadedAt,
      pageCount: 12,
      pages: TEXT.pages,
      textLayer: true,
      truncated: false,
      next: { fromPage: 2, fromCharacter: 0 },
    });
  });

  it("goes on inside a page where the last answer stopped, as it said to", async () => {
    // The answer's next is the input of the call after it, field for field,
    // so a page longer than one answer holds is read whole across several.
    const { held, readText } = registered();
    readText.mockResolvedValueOnce({
      document: MINUTES,
      text: {
        ...TEXT,
        truncated: true,
        next: { page: 4, character: 18_250 },
      },
    });

    const first = (await held("document_get").handler(
      { id: "document-1", fromPage: 4, fromCharacter: 0 },
      CONTEXT,
    )) as { truncated: boolean; next: Record<string, number> };
    expect(first).toMatchObject({
      truncated: true,
      next: { fromPage: 4, fromCharacter: 18_250 },
    });

    const parsed = await held("document_get").input["~standard"].validate({
      id: "document-1",
      ...first.next,
    });
    if (parsed.issues !== undefined) {
      throw new Error("next was not an input document_get takes");
    }
    await held("document_get").handler(parsed.value, CONTEXT);
    expect(readText).toHaveBeenLastCalledWith(
      "document-1",
      BOARD_MEMBER,
      { firstPage: 4, firstCharacter: 18_250, lastPage: 13 },
      { within: ["MEMBER", "PUBLIC"] },
    );
  });

  it("answers the end of the document with no next", async () => {
    const { held, readText } = registered();
    readText.mockResolvedValueOnce({
      document: MINUTES,
      text: { ...TEXT, next: null },
    });

    await expect(
      held("document_get").handler(
        { id: "document-1", fromPage: 12, fromCharacter: 0 },
        CONTEXT,
      ),
    ).resolves.toMatchObject({ truncated: false, next: null });
  });

  it.each<[string, Record<string, unknown>]>([
    ["eleven pages", { id: "document-1", fromPage: 1, toPage: 11 }],
    ["a range that ends first", { id: "document-1", fromPage: 5, toPage: 4 }],
    ["a page before the first", { id: "document-1", fromPage: 0 }],
    [
      "a character before the first",
      { id: "document-1", fromPage: 1, fromCharacter: -1 },
    ],
  ])("refuses %s", async (_name, input) => {
    const { held } = registered();
    const parsed =
      await held("document_get").input["~standard"].validate(input);
    expect(parsed.issues).toBeDefined();
  });
});

/** The two actions in a real registry, against a person holding these. */
function registryWith(capabilities: string[]) {
  const callers = new ActionCallerFactory();
  const principal = {
    personId: "person-board",
    capabilities: new Set(capabilities),
    isMember: false,
  } as unknown as Principal;
  const forPerson = vi.fn(async () => principal);
  const registry = new ActionRegistryService(
    callers,
    { forPerson } as unknown as PrincipalService,
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
  const built = services(principal);
  new DocumentActionsRegistrar(
    built.documents,
    built.principals,
    new CoreActionRegistrar(registry),
  ).onModuleInit();
  return { registry, callers, list: built.list, readText: built.readText };
}

function request(token?: RequestWithToken["token"]): RequestWithToken {
  const held = {
    id: "req-1",
    principal: { personId: "person-board" },
    ...(token === undefined ? {} : { token }),
  } as unknown as RequestWithToken;
  markAuthenticated(held);
  return held;
}

const APP = {
  tokenRowId: "token-1",
  clientId: "client-1",
  clientHost: "app.example",
  scopes: ["mcp:read"],
};

const INPUT: Record<(typeof NAMES)[number], unknown> = {
  document_list: {},
  document_get: { id: "document-1" },
};

describe.each([...NAMES])("who may call %s", (name) => {
  it("answers anybody with an account, through a connected app", async () => {
    // A resident who is neither a member nor on the board: the shelf decides
    // what they read, and the action lets them ask.
    const { registry, callers, list, readText } = registryWith(["self:manage"]);

    await expect(
      registry.invoke(callers.forRequest(request(APP)), name, INPUT[name]),
    ).resolves.toBeDefined();
    expect(list.mock.calls.length + readText.mock.calls.length).toBe(1);
  });

  it("refuses a person holding nothing, before the service", async () => {
    const { registry, callers, list, readText } = registryWith([]);

    await expect(
      registry.invoke(callers.forRequest(request(APP)), name, INPUT[name]),
    ).rejects.toMatchObject({ reason: "forbidden-capability" });
    expect(list).not.toHaveBeenCalled();
    expect(readText).not.toHaveBeenCalled();
  });

  it("refuses the board's own screen, which reads through its controller", async () => {
    const { registry, callers, list, readText } = registryWith([
      "self:manage",
      "documents:manage",
    ]);

    await expect(
      registry.invoke(callers.forRequest(request()), name, INPUT[name]),
    ).rejects.toMatchObject({ reason: "forbidden-surface" });
    expect(list).not.toHaveBeenCalled();
    expect(readText).not.toHaveBeenCalled();
  });

  it("refuses a connection that may not read", async () => {
    const { registry, callers, list, readText } = registryWith(["self:manage"]);

    await expect(
      registry.invoke(
        callers.forRequest(request({ ...APP, scopes: ["mcp:write"] })),
        name,
        INPUT[name],
      ),
    ).rejects.toMatchObject({ reason: "insufficient-scope" });
    expect(list).not.toHaveBeenCalled();
    expect(readText).not.toHaveBeenCalled();
  });

  it("publishes no property that holds a person", () => {
    const { registry } = registryWith([]);
    const forbidden =
      /"(personId|[a-zA-Z]+PersonId|name|email|phone|apartment|url)"/u;
    expect(JSON.stringify(registry.outputJsonSchema(name))).not.toMatch(
      forbidden,
    );
  });
});
