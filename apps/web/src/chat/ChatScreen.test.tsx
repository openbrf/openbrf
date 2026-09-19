import { act, render, screen, waitFor } from "@testing-library/react";
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
const createChatGroup = vi.fn();
const reportChatMessage = vi.fn();
const fetchGroupMembers = vi.fn();
const fetchGroupCandidates = vi.fn();
const fetchChatReports = vi.fn();

vi.mock("../api/chat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/chat")>()),
  fetchChats: () => fetchChats(),
  readChat: (input: unknown) => readChat(input),
  messagesSince: (input: unknown) => messagesSince(input),
  writeMessage: (input: unknown) => writeMessage(input),
  markChatRead: (input: unknown) => markChatRead(input),
  createChatGroup: (input: unknown) => createChatGroup(input),
  reportChatMessage: (input: unknown) => reportChatMessage(input),
  fetchGroupMembers: (input: unknown) => fetchGroupMembers(input),
  fetchGroupCandidates: (input: unknown) => fetchGroupCandidates(input),
  fetchChatReports: () => fetchChatReports(),
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

const GARDEN_GROUP: ChatRoom = {
  id: "chat-garden",
  kind: "GROUP",
  name: "Trädgårdsgruppen",
  unread: 0,
  lastMessageAt: "2026-09-17T09:00:00.000Z",
};

const FROM_A_COLLEAGUE: ChatMessage = {
  id: "message-1",
  author: { kind: "person", personId: "person-bo", name: "Bo Ek" },
  body: "Jag har tagit in en offert pa taket.",
  struckAt: null,
  createdAt: "2026-09-17T09:00:00.000Z",
};

const MINE: ChatMessage = {
  id: "message-2",
  author: { kind: "person", personId: ASTRID, name: "Astrid Lindqvist" },
  body: "Bra, da tar vi den pa nasta mote.",
  struckAt: null,
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
  fetchChats.mockReset().mockResolvedValue({
    ok: true,
    value: { rooms: [BOARD_ROOM], mayCreateGroup: false },
  });
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
  createChatGroup.mockReset().mockResolvedValue({
    ok: true,
    value: { chatId: "chat-new", name: "Uppgång C" },
  });
  reportChatMessage
    .mockReset()
    .mockResolvedValue({ ok: true, value: { reportId: "report-1" } });
  fetchGroupMembers.mockReset().mockResolvedValue({ ok: true, value: [] });
  fetchGroupCandidates.mockReset().mockResolvedValue({ ok: true, value: [] });
  fetchChatReports.mockReset().mockResolvedValue({ ok: true, value: [] });
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
      value: { rooms: [{ ...BOARD_ROOM, unread: 3 }], mayCreateGroup: false },
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
          struckAt: null,
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
    // The administrator: every capability, no seat on the board, and no home
    // here - so there is no room and no form for making one either.
    fetchChats.mockResolvedValue({
      ok: true,
      value: { rooms: [], mayCreateGroup: false },
    });

    render(<ChatScreen viewer={viewer(["chat:participate"])} />);

    expect(
      await screen.findByText(/Styrelsechatten är för den som har ett uppdrag/),
    ).not.toBeNull();
    expect(screen.queryByLabelText("Ditt meddelande")).toBeNull();
  });
});

describe("the account the chat is not for", () => {
  it("says who the chat is for rather than offering a retry", async () => {
    // The guard's refusal is not a failure to answer. Telling somebody to
    // reload would teach them a part of the product is broken for them, when
    // what is true is that it is not theirs.
    fetchChats.mockResolvedValue({
      ok: false,
      failure: { status: 403, reason: "forbidden" },
    });

    render(<ChatScreen viewer={viewer([])} />);

    expect(
      await screen.findByText(/Chatten är för styrelsen och för dem som bor/),
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

describe("catching up after the screen was closed", () => {
  it("asks from the cursor each page answered with, and stops when told to", async () => {
    /*
     * The backlog case, and the one the loop exists for. The server bounds a
     * poll's answer and says whether more was waiting, so a screen closed for a
     * week catches up a page at a time.
     *
     * The cursor has to advance between iterations. It is carried through the
     * loop rather than re-read from the ref, because the ref is written by an
     * effect that runs after React commits and nothing commits while the loop is
     * awaiting - so a loop reading the ref would ask for the same page again,
     * be told again that more was waiting, and never stop. Asserted on the
     * second call's `after` rather than only on the message arriving, because a
     * loop that never advanced would still show the first page.
     */
    messagesSince
      .mockReset()
      .mockResolvedValueOnce({
        ok: true,
        value: { messages: [MINE], cursor: "cursor-2", more: true },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { messages: [], cursor: "cursor-3", more: false },
      });

    render(<ChatScreen viewer={viewer(["chat:participate"])} />);
    await screen.findByText("Jag har tagit in en offert pa taket.");

    await userEvent.type(screen.getByLabelText("Ditt meddelande"), "Hej.");
    await userEvent.click(
      screen.getByRole("button", { name: "Skicka meddelandet" }),
    );

    await waitFor(() => {
      expect(messagesSince).toHaveBeenCalledTimes(2);
    });
    // The second page is asked for from where the first one ended, not from
    // where the run started.
    expect(messagesSince).toHaveBeenLastCalledWith({
      chatId: "chat-board",
      after: "cursor-2",
    });
    // And it stopped: `more: false` ends the run rather than another round.
    expect(messagesSince).toHaveBeenCalledTimes(2);
  });
});

describe("a room that could not be read at all", () => {
  it("says so once, and does not also call the room empty", async () => {
    /*
     * A failed first read stores no messages, so a branch that only asked
     * whether the list was empty would print "nothing has been written here
     * yet" underneath a notice saying the room could not be read - two claims,
     * one of them invented by the screen.
     */
    readChat.mockResolvedValue({
      ok: false,
      failure: { status: 404, reason: "chat-not-found" },
    });

    render(<ChatScreen viewer={viewer(["chat:participate"])} />);

    expect(await screen.findByText(/Den chatten finns inte/)).not.toBeNull();
    expect(screen.queryByText("Ingenting har skrivits här än.")).toBeNull();
  });

  it("offers no write box for a room this client never got", async () => {
    // A message sent into it would be sent blind, at a room the screen has no
    // answer about.
    readChat.mockResolvedValue({
      ok: false,
      failure: { status: 404, reason: "chat-not-found" },
    });

    render(<ChatScreen viewer={viewer(["chat:participate"])} />);
    await screen.findByText(/Den chatten finns inte/);

    expect(screen.queryByLabelText("Ditt meddelande")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Skicka meddelandet" }),
    ).toBeNull();
  });

  it("gives the room back once a later read answers", async () => {
    /*
     * A first read that fails leaves no cursor, so the poll reads the room
     * again four seconds later. When that read answers, the failure has to go
     * with it. Held on, it leaves an empty room unreadable for good - no write
     * box and no send button at a room this client has in fact read - and a
     * room with messages shows them beneath a notice saying it could not be
     * read. Only a reload cleared either.
     *
     * The first read fails the way a restarting server fails, which falls
     * through to the general sentence; the one after it answers.
     */
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      readChat
        .mockReset()
        .mockResolvedValueOnce({
          ok: false,
          failure: { status: 502, reason: "unavailable" },
        })
        .mockResolvedValue({ ok: true, value: page([]) });

      render(<ChatScreen viewer={viewer(["chat:participate"])} />);
      expect(
        await screen.findByText("Det gick inte just nu. Försök igen."),
      ).not.toBeNull();
      expect(screen.queryByLabelText("Ditt meddelande")).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(4000);
      });

      expect(await screen.findByLabelText("Ditt meddelande")).not.toBeNull();
      expect(
        screen.queryByText("Det gick inte just nu. Försök igen."),
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a room nobody has written in yet", () => {
  it("still reads, so the first message is not waited for for ever", async () => {
    /*
     * An empty room comes back with no forward cursor, because there is no
     * message to take one from. A poll gated on having one would not start
     * until the room already had a line in it - which is exactly backwards, as
     * a room nobody has written in is the one most likely to be sitting open on
     * somebody's screen. The reader would watch it and never see the first
     * message arrive, and nor would whoever wrote it.
     *
     * Driven through the write here rather than through the interval, because
     * it is the same branch and needs no clock: the send asks the poll for a
     * read, and with no cursor that read is the newest page again.
     */
    readChat.mockReset().mockResolvedValueOnce({ ok: true, value: page([]) });

    render(<ChatScreen viewer={viewer(["chat:participate"])} />);
    expect(
      await screen.findByText("Ingenting har skrivits här än."),
    ).not.toBeNull();

    readChat.mockResolvedValue({ ok: true, value: page([MINE]) });
    await userEvent.type(
      screen.getByLabelText("Ditt meddelande"),
      "Bra, da tar vi den pa nasta mote.",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Skicka meddelandet" }),
    );

    // The newest page, asked for again: `messagesSince` has no cursor to ask
    // from and is never called.
    await waitFor(() => {
      expect(readChat).toHaveBeenCalledTimes(2);
    });
    expect(messagesSince).not.toHaveBeenCalled();
    expect(
      await screen.findByText("Bra, da tar vi den pa nasta mote."),
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
          struckAt: null,
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

describe("a group", () => {
  /** A resident: in one group, and able to make another. */
  function inTheGarden(): void {
    fetchChats.mockResolvedValue({
      ok: true,
      value: { rooms: [GARDEN_GROUP], mayCreateGroup: true },
    });
  }

  it("is made from the screen by whoever wants one", async () => {
    fetchChats.mockResolvedValue({
      ok: true,
      value: { rooms: [], mayCreateGroup: true },
    });

    render(<ChatScreen viewer={viewer(["chat:participate"])} />);

    // The empty screen for somebody who lives here is a form and not a refusal:
    // the board appoints nobody here, so there is nothing to ask for.
    await userEvent.type(
      await screen.findByLabelText("Gruppens namn"),
      "Uppgång C",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Skapa gruppen" }),
    );

    await waitFor(() => {
      expect(createChatGroup).toHaveBeenCalledWith({ name: "Uppgång C" });
    });
  });

  it("offers reporting a neighbour's message and never one's own", async () => {
    inTheGarden();
    readChat.mockResolvedValue({
      ok: true,
      value: page([FROM_A_COLLEAGUE, MINE]),
    });

    render(<ChatScreen viewer={viewer(["chat:participate"])} />);
    await screen.findByText("Jag har tagit in en offert pa taket.");

    /*
     * One control for the two messages: the colleague's. Reporting one's own
     * line to the board is not an act this product needs to offer, and the
     * absence is what the count asserts.
     */
    expect(
      screen.getAllByRole("button", { name: /^Anmäl meddelandet från/ }),
    ).toHaveLength(1);

    /*
     * Named after its author rather than labelled "report", because that is
     * what assistive technology announces: a control announced as "report" in a
     * list of messages names none of them.
     */
    await userEvent.click(
      screen.getByRole("button", {
        name: "Anmäl meddelandet från Bo Ek till styrelsen",
      }),
    );
    await userEvent.type(
      screen.getByLabelText("Vad vill du säga om meddelandet?"),
      "Det har handlar om min lagenhet.",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Skicka anmälan" }),
    );

    await waitFor(() => {
      expect(reportChatMessage).toHaveBeenCalledWith({
        messageId: "message-1",
        note: "Det har handlar om min lagenhet.",
      });
    });
    // What the screen owes the reporter afterwards is the sentence saying the
    // board has it. The message itself is untouched until the board answers.
    expect(
      await screen.findByText("Meddelandet är anmält till styrelsen."),
    ).not.toBeNull();
  });

  it("renders a struck message as the server answered it", async () => {
    inTheGarden();
    readChat.mockResolvedValue({
      ok: true,
      value: page([
        {
          id: "message-struck",
          author: { kind: "person", personId: "person-bo", name: "Bo Ek" },
          // Withheld from this reader: they neither wrote it nor moderate.
          body: null,
          struckAt: "2026-09-17T10:00:00.000Z",
          createdAt: "2026-09-17T09:00:00.000Z",
        },
      ]),
    });

    render(<ChatScreen viewer={viewer(["chat:participate"])} />);

    expect(
      await screen.findByText(/Styrelsen har strukit över meddelandet/),
    ).not.toBeNull();
    // The author stays named, because a strike is a strike-through and never a
    // disappearance.
    expect(screen.getByText("Bo Ek")).not.toBeNull();
    // And there is nothing left to report about a message the board answered.
    expect(
      screen.queryByRole("button", { name: /^Anmäl meddelandet från/ }),
    ).toBeNull();
  });

  it("offers no reporting in the board chat", async () => {
    render(<ChatScreen viewer={viewer(["chat:participate"])} />);
    await screen.findByText("Jag har tagit in en offert pa taket.");

    // The board is the whole room: there is nobody to report a colleague's line
    // to, so the control does not exist there at all.
    expect(
      screen.queryByRole("button", { name: /^Anmäl meddelandet från/ }),
    ).toBeNull();
  });
});

describe("the board's queue of reported messages", () => {
  it("is on the screen for whoever moderates, and nowhere else", async () => {
    render(
      <ChatScreen viewer={viewer(["chat:participate", "chat:moderate"])} />,
    );

    expect(
      await screen.findByRole("heading", { name: "Anmälda chattmeddelanden" }),
    ).not.toBeNull();
    // The whole of what a board with no report learns: that nothing has been
    // reported. There is no list of groups here or anywhere else.
    expect(await screen.findByText("Ingenting är anmält.")).not.toBeNull();
  });

  it("is absent for somebody who does not moderate", async () => {
    render(<ChatScreen viewer={viewer(["chat:participate"])} />);
    await screen.findByText("Jag har tagit in en offert pa taket.");

    expect(
      screen.queryByRole("heading", { name: "Anmälda chattmeddelanden" }),
    ).toBeNull();
    expect(fetchChatReports).not.toHaveBeenCalled();
  });
});

describe("a board member who lives somewhere else", () => {
  it("is shown their room and not the sentence for an account with none", async () => {
    /*
     * One room and no form: they hold a seat and no home here, so there is no
     * list above the board's room and nothing to make. The sentence for an
     * account in no room says this account holds no seat, which is false about
     * them, and it belongs only to a screen with no room on it at all.
     */
    render(<ChatScreen viewer={viewer(["chat:participate"])} />);
    await screen.findByText("Jag har tagit in en offert pa taket.");

    expect(
      screen.queryByText(/Styrelsechatten är för den som har ett uppdrag/),
    ).toBeNull();
  });
});

describe("pressing another room", () => {
  it("never marks the new room read at the old room's newest message", async () => {
    /*
     * The room changes at once and its messages arrive a moment later, so for
     * that moment the screen still holds the room being left. A marker posted in
     * that moment would mark the new room read up to an instant taken from a
     * different conversation - and the new room's unread count would be wrong
     * the first time anybody looked at it.
     *
     * The second room's read is held open here, so the moment lasts as long as
     * the assertions need it to.
     */
    fetchChats.mockResolvedValue({
      ok: true,
      value: { rooms: [BOARD_ROOM, GARDEN_GROUP], mayCreateGroup: true },
    });
    let answerGarden: (value: unknown) => void = () => undefined;
    const gardenAnswered = new Promise((resolve) => {
      answerGarden = resolve;
    });
    const IN_THE_GARDEN: ChatMessage = {
      id: "message-garden",
      author: { kind: "person", personId: "person-bo", name: "Bo Ek" },
      body: "Krattorna star i forradet.",
      struckAt: null,
      createdAt: "2026-09-17T10:30:00.000Z",
    };
    readChat
      .mockReset()
      .mockImplementation((input: { chatId: string }) =>
        input.chatId === GARDEN_GROUP.id
          ? gardenAnswered
          : Promise.resolve({ ok: true, value: page([FROM_A_COLLEAGUE]) }),
      );

    render(<ChatScreen viewer={viewer(["chat:participate"])} />);
    await screen.findByText("Jag har tagit in en offert pa taket.");
    await waitFor(() => {
      expect(markChatRead).toHaveBeenCalledWith({
        chatId: BOARD_ROOM.id,
        readAt: FROM_A_COLLEAGUE.createdAt,
      });
    });

    await userEvent.click(
      screen.getByRole("button", { name: "Trädgårdsgruppen" }),
    );

    // The room being left is not shown under the new room's name.
    expect(await screen.findByText("Läser meddelandena...")).not.toBeNull();
    expect(
      screen.queryByText("Jag har tagit in en offert pa taket."),
    ).toBeNull();
    expect(markChatRead).not.toHaveBeenCalledWith({
      chatId: GARDEN_GROUP.id,
      readAt: FROM_A_COLLEAGUE.createdAt,
    });

    await act(async () => {
      answerGarden({ ok: true, value: page([IN_THE_GARDEN]) });
      await gardenAnswered;
    });

    // Once the new room's own messages are on screen, its own newest instant.
    expect(
      await screen.findByText("Krattorna star i forradet."),
    ).not.toBeNull();
    await waitFor(() => {
      expect(markChatRead).toHaveBeenCalledWith({
        chatId: GARDEN_GROUP.id,
        readAt: IN_THE_GARDEN.createdAt,
      });
    });
  });
});
