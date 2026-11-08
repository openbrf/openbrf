import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { listEveryMessage, type Message } from "./mailpit";

// The helper is read against a mailbox held here rather than a running
// mailpit: what is under test is how it pages, and a real mailbox cannot be
// made to gain a message between two pages on cue.
vi.mock("./stack", () => ({
  stack: { mailpitUrl: "http://mailpit.test" },
}));

function message(id: string, subject = `Message ${id}`): Message {
  return { ID: id, Subject: subject, To: [], Created: "2026-11-08T12:00:00Z" };
}

/** `count` messages, newest first, as mailpit lists them. */
function messages(count: number): Message[] {
  return Array.from({ length: count }, (_, index) =>
    message(`m${String(count - index)}`),
  );
}

/**
 * A mailbox that answers mailpit's list request, newest first. `afterPage` runs
 * once each page has been answered, with the number of pages answered so far,
 * so a test can deliver mail between two pages.
 */
function fakeMailbox(
  held: Message[],
  options: {
    readonly afterPage?: (pagesAnswered: number) => void;
    readonly page?: (start: number, limit: number) => readonly Message[];
    readonly total?: () => number;
  } = {},
) {
  const starts: number[] = [];
  const fetchMock = vi.fn((input: string | URL) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("http://mailpit.test");
    expect(url.pathname).toBe("/api/v1/messages");
    const start = Number(url.searchParams.get("start"));
    const limit = Number(url.searchParams.get("limit"));
    starts.push(start);
    const body = {
      messages:
        options.page?.(start, limit) ?? held.slice(start, start + limit),
      total: options.total?.() ?? held.length,
    };
    options.afterPage?.(starts.length);
    return Promise.resolve(Response.json(body));
  });
  vi.stubGlobal("fetch", fetchMock);
  return { starts };
}

/** Delivers a new message, which mailpit lists first. */
function deliver(held: Message[], id: string): void {
  held.unshift(message(id));
}

describe("listEveryMessage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads past the first 200 messages, a page at a time", async () => {
    const held = messages(450);
    // The one the scan is after sits on the second page, which the first-page
    // read this helper replaced never saw.
    held[300] = message("late", "carries the forbidden value");
    const { starts } = fakeMailbox(held);

    const read = await listEveryMessage();

    expect(starts).toEqual([0, 200, 400]);
    expect(read.map((each) => each.ID)).toEqual(held.map((each) => each.ID));
    expect(read.some((each) => each.Subject.includes("forbidden value"))).toBe(
      true,
    );
  });

  it("fails when the pages end before the mailbox's own count", async () => {
    const held = messages(450);
    fakeMailbox(held, {
      page: (start, limit) => (start === 0 ? held.slice(0, limit) : []),
    });

    await expect(listEveryMessage()).rejects.toThrow(
      "mailpit holds 450 messages but 200 were read",
    );
  });

  it("fails when a page comes back short of the mailbox's own count", async () => {
    const held = messages(250);
    fakeMailbox(held, { total: () => 300 });

    await expect(listEveryMessage()).rejects.toThrow(
      "mailpit holds 300 messages but 250 were read",
    );
  });

  it("reads the mailbox again when mail arrives between two pages", async () => {
    const held = messages(250);
    // One message arrives after the first page of the first scan only. It
    // pushes the oldest message of the first page onto the second, where it
    // is read twice while the new one is never read, and the count still
    // adds up: 251 read for 251 held.
    const { starts } = fakeMailbox(held, {
      afterPage: (pagesAnswered) => {
        if (pagesAnswered === 1) {
          deliver(held, "arrived");
        }
      },
    });

    const read = await listEveryMessage();

    expect(starts).toEqual([0, 200, 0, 200]);
    const ids = read.map((each) => each.ID);
    expect(ids).toContain("arrived");
    expect(new Set(ids).size).toBe(251);
    expect(ids).toEqual(held.map((each) => each.ID));
  });

  it("gives up after three scans that each saw the mailbox move", async () => {
    const held = messages(250);
    // Mail arrives after the first page of every scan, so no scan reads a
    // mailbox that stood still.
    const { starts } = fakeMailbox(held, {
      afterPage: (pagesAnswered) => {
        if (pagesAnswered % 2 === 1) {
          deliver(held, `arrived${String(pagesAnswered)}`);
        }
      },
    });

    await expect(listEveryMessage()).rejects.toThrow(
      "mailpit gained a message while its pages were read, three times in a row",
    );
    expect(starts).toEqual([0, 200, 0, 200, 0, 200]);
  });
});
