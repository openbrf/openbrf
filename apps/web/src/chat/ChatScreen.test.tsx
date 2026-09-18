import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import type { ChatMessage, ChatPage, ChatRoom } from "../api/chat";
import type { Viewer } from "../api/instance";
import { ChatScreen } from "./ChatScreen";

/**
 * What the chat screen may decide, and what it may only render.
 *
 * **It decides nothing about who is in a room.** The server answers with the
 * rooms this account is in, and an empty answer is an answer rather than a
 * failure: the administrator holds every capability and no board seat, so they
 * reach this screen and find no room. The screen says why in Swedish, because
 * the alternative is an empty conversation that reads as a broken page and
 * becomes a support question.
 *
 * **It never appends a message it has not read back.** A written message is not
 * put on the list by the browser: the box clears and a read brings the row. That
 * is what makes the poll the one delivery path rather than a second opinion
 * about one, and a screen that appended would be rendering a list nothing on the
 * server ever said.
 *
 * **It never renders a value a refusal withheld.** The refusal for a personal
 * identity number carries an offset and never the digits, and the sentence the
 * screen shows must not put them back - the draft stays in the box so the writer
 * can take the number out themselves.
 *
 * **It withholds a protected author's name**, every reader included: the name is
 * not on the payload at all, so what this asserts is that the screen says so
 * rather than rendering an empty attribution.
 *
 * The polling mechanics themselves are `ui/use-poll.test.ts`; what happens to
 * the rows is `apps/api/src/chat/chat.int-spec.ts`.
 */

const fetchChats = vi.fn();
const readChat = vi.fn();
const messagesSince = vi.fn();
const writeMessage = vi.fn();
const markChatRead = vi.fn();

vi.mock("../api/chat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/chat")>()),
  fetchChats: () => fetchChats(),
  readChat: (input: unknown) => readChat(input),
  messagesSince: (input: unknown) => messagesSince(input),
  writeMessage: (input: unknown) => writeMessage(input),
  markChatRead: (input: unknown) => markChatRead(input),
}));

const ASTRID = "person-astrid";

function viewer(capabilities: readonly string[]): Viewer {
  return {
    personId: ASTRID,
    firstName: "Astrid",
    lastName: "Lindqvist",
    preferredLocale: "sv",
    capabilities: [...capabilities],
    housingCooperative: null,
  };
}

const BOARD_ROOM: ChatRoom = {
  id: "chat-board",
  kind: "BOARD",
  name: null,
  unread: 0,
  lastMessageAt: "2026-09-17T09:00:00.000Z",
};

const FROM_A_COLLEAGUE: ChatMessage = {
  id: "message-1",
  author: { kind: "person", personId: "person-bo", name: "Bo Ek" },
  body: "Jag har tagit in en offert pa taket.",
  createdAt: "2026-09-17T09:00:00.000Z",
};

const MINE: ChatMessage = {
  id: "message-2",
  author: { kind: "person", personId: ASTRID, name: "Astrid Lindqvist" },
  body: "Bra, da tar vi den pa nasta mote.",
  createdAt: "2026-09-17T09:05:00.000Z",
};

function page(
  messages: ChatMessage[],
  earlier: string | null = null,
): ChatPage {
  return {
    messages,
    earlier,
    latest:
      messages.length === 0
        ? null
        : `${messages[messages.length - 1]?.createdAt ?? ""}|${
            messages[messages.length - 1]?.id ?? ""
          }`,
  };
}

beforeEach(() => {
  fetchChats.mockReset().mockResolvedValue({ ok: true, value: [BOARD_ROOM] });
  readChat.mockReset().mockResolvedValue({
    ok: true,
    value: page([FROM_A_COLLEAGUE]),
  });
  messagesSince.mockReset().mockResolvedValue({
    ok: true,
    value: { messages: [], cursor: "unchanged", more: false },
  });
  writeMessage.mockReset().mockResolvedValue({ ok: true, value: MINE });
  markChatRead
    .mockReset()
    .mockResolvedValue({ ok: true, value: { readAt: MINE.createdAt } });
});

describe("the room a board member opens", () => {
  it("shows what has been written, with who wrote it", async () => {
    render(<ChatScreen viewer={viewer(["chat:participate"])} />);

    expect(
      await screen.findByText("Jag har tagit in en offert pa taket."),
    ).not.toBeNull();
    expect(screen.getByText("Bo Ek")).not.toBeNull();
    expect(
      screen.getByRole("heading", { name: "Styrelsechatten" }),
    ).not.toBeNull();
  });

  it("marks the room read at the newest message on screen, never at now", async () => {
    render(<ChatScreen viewer={viewer(["chat:participate"])} />);
    await screen.findByText("Jag har tagit in en offert pa taket.");

    /*
     * The instant of the newest message actually shown. A marker set to "now"
     * would mark a message read that was written while the request was in
     * flight and that nobody has seen.
     */
    await waitFor(() => {
      expect(markChatRead).toHaveBeenCalledWith({
        chatId: "chat-board",
        readAt: FROM_A_COLLEAGUE.createdAt,
      });
    });
  });

  it("says how many are unread", async () => {
    fetchChats.mockResolvedValue({
      ok: true,
      value: [{ ...BOARD_ROOM, unread: 3 }],
    });

    render(<ChatScreen viewer={viewer(["chat:participate"])} />);

    expect(await screen.findByText("3 olästa meddelanden.")).not.toBeNull();
  });

  it("names nobody with protected personal data", async () => {
    readChat.mockResolvedValue({
      ok: true,
      value: page([
        {
          id: "message-9",
          author: { kind: "protected", personId: "person-skyddad" },
          body: "Jag tar offerten.",
          createdAt: "2026-09-17T09:00:00.000Z",
        },
      ]),
    });

    render(<ChatScreen viewer={viewer(["chat:participate"])} />);

    // The words stay; what is withheld is the attribution.
    expect(await screen.findByText("Jag tar offerten.")).not.toBeNull();
    expect(
      screen.getByText("Skyddade personuppgifter: namnges inte här."),
    ).not.toBeNull();
  });

  it("offers no control that would edit, delete or strike a message through", async () => {
    render(<ChatScreen viewer={viewer(["chat:participate"])} />);
    await screen.findByText("Jag har tagit in en offert pa taket.");

    /*
     * The absence is the feature. There is no strike-through in the board chat
     * at all: the board is the whole room, and a board able to strike a
     * colleague's line would be deciding what the record of its own
     * deliberation says. The send button is the only one on the screen.
     */
    const buttons = screen
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(buttons).toEqual(["Skicka meddelandet"]);
  });
});

describe("the account that is in no room", () => {
  it("says why rather than showing an empty conversation", async () => {
    // The administrator: every capability, and no seat on the board.
    fetchChats.mockResolvedValue({ ok: true, value: [] });

    render(<ChatScreen viewer={viewer(["chat:participate"])} />);

    expect(
      await screen.findByText(/Styrelsechatten är för den som har ett uppdrag/),
    ).not.toBeNull();
    expect(screen.queryByLabelText("Ditt meddelande")).toBeNull();
  });
});

describe("the account the chat is not for", () => {
  it("says the room is the board's rather than offering a retry", async () => {
    // The guard's refusal is not a failure to answer. Telling a resident to
    // reload would teach them a part of the product is broken for them, when
    // what is true is that it is not theirs.
    fetchChats.mockResolvedValue({
      ok: false,
      failure: { status: 403, reason: "forbidden" },
    });

    render(<ChatScreen viewer={viewer([])} />);

    expect(
      await screen.findByText(/Chatten här är styrelsens egen/),
    ).not.toBeNull();
    expect(screen.queryByText(/Ladda om sidan/)).toBeNull();
  });
});

describe("writing a message", () => {
  it("clears the box and reads the room rather than appending", async () => {
    messagesSince.mockResolvedValue({
      ok: true,
      value: { messages: [MINE], cursor: "moved", more: false },
    });

    render(<ChatScreen viewer={viewer(["chat:participate"])} />);
    await screen.findByText("Jag har tagit in en offert pa taket.");

    const box = screen.getByLabelText("Ditt meddelande");
    await userEvent.type(box, "Bra, da tar vi den pa nasta mote.");
    await userEvent.click(
      screen.getByRole("button", { name: "Skicka meddelandet" }),
    );

    await waitFor(() => {
      expect(writeMessage).toHaveBeenCalledWith({
        chatId: "chat-board",
        body: "Bra, da tar vi den pa nasta mote.",
      });
    });
    // The row arrives because a read brought it, which is the same way
    // everybody else's arrives.
    await waitFor(() => {
      expect(messagesSince).toHaveBeenCalled();
    });
    expect(
      await screen.findByText("Bra, da tar vi den pa nasta mote."),
    ).not.toBeNull();
    expect((box as HTMLTextAreaElement).value).toBe("");
  });

  it("puts a refused personal identity number in words, and keeps the draft", async () => {
    writeMessage.mockResolvedValue({
      ok: false,
      failure: { status: 422, reason: "personal-identity-number" },
    });

    render(<ChatScreen viewer={viewer(["chat:participate"])} />);
    await screen.findByText("Jag har tagit in en offert pa taket.");

    const box = screen.getByLabelText("Ditt meddelande");
    await userEvent.type(box, "Det är 19811218-9876 som står där.");
    await userEvent.click(
      screen.getByRole("button", { name: "Skicka meddelandet" }),
    );

    expect(
      await screen.findByText(/innehåller ett personnummer/),
    ).not.toBeNull();
    // The writer takes the number out themselves, so the text they wrote stays.
    expect((box as HTMLTextAreaElement).value).toBe(
      "Det är 19811218-9876 som står där.",
    );
  });

  it("puts the write budget in words", async () => {
    writeMessage.mockResolvedValue({
      ok: false,
      failure: { status: 429, reason: "too-many-messages" },
    });

    render(<ChatScreen viewer={viewer(["chat:participate"])} />);
    await screen.findByText("Jag har tagit in en offert pa taket.");

    await userEvent.type(screen.getByLabelText("Ditt meddelande"), "Hej.");
    await userEvent.click(
      screen.getByRole("button", { name: "Skicka meddelandet" }),
    );

    expect(
      await screen.findByText(/många meddelanden på kort tid/),
    ).not.toBeNull();
  });
});

describe("the messages before this page", () => {
  it("is one press away, and puts them in front", async () => {
    readChat.mockResolvedValueOnce({
      ok: true,
      value: page([FROM_A_COLLEAGUE], "2026-09-01T09:00:00.000Z|message-0"),
    });

    render(<ChatScreen viewer={viewer(["chat:participate"])} />);
    await screen.findByText("Jag har tagit in en offert pa taket.");

    readChat.mockResolvedValueOnce({
      ok: true,
      value: page([
        {
          id: "message-0",
          author: { kind: "person", personId: "person-bo", name: "Bo Ek" },
          body: "Skrivet innan den har sidan.",
          createdAt: "2026-09-01T09:00:00.000Z",
        },
      ]),
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Visa tidigare meddelanden" }),
    );

    const messages = await screen.findAllByRole("listitem");
    // Older messages were written first and so read first.
    expect(messages[0]?.textContent).toContain("Skrivet innan den har sidan.");
    expect(messages[1]?.textContent).toContain(
      "Jag har tagit in en offert pa taket.",
    );
  });

  it("offers no control when the room starts on this page", async () => {
    render(<ChatScreen viewer={viewer(["chat:participate"])} />);
    await screen.findByText("Jag har tagit in en offert pa taket.");

    // Null is the whole of the answer to "is there more", so the screen never
    // infers it from a page that came back full.
    expect(
      screen.queryByRole("button", { name: "Visa tidigare meddelanden" }),
    ).toBeNull();
  });
});

describe("a room that could not be read", () => {
  it("says so rather than showing an empty room", async () => {
    readChat.mockResolvedValue({
      ok: false,
      failure: { status: 404, reason: "chat-not-found" },
    });

    render(<ChatScreen viewer={viewer(["chat:participate"])} />);

    expect(await screen.findByText(/Den chatten finns inte/)).not.toBeNull();
  });
});
