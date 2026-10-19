import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { Viewer } from "../api/instance";
import { MotionQueueScreen } from "./MotionQueueScreen";

/**
 * The board's page for motions: the queue the members' motions arrive in, and
 * which meeting takes each one up.
 *
 * The API refuses every call whatever the browser was shown, so hiding the page
 * is courtesy. What is not courtesy is the read behind it: the queue is the one
 * place a motion says which member proposed what, and a page that asked for it
 * on a member's behalf would be asking the server for other people's data with
 * nowhere to put it. So this file asserts the request as well as the panel.
 *
 * `motions:handle` is the board's, because a motion is addressed to it. Putting
 * an item in is a member's right under EFL 6 kap. 15 §, applied to a housing
 * cooperative by BRL 9 kap. 14 §, and a board member who is also a member puts
 * theirs in from the house's page (ADR 0044), so this page offers no form to
 * anybody.
 */

const fetchMotionIntake = vi.fn();
const fetchMotionQueue = vi.fn();
const acknowledgeMotion = vi.fn();
const setMotionMeeting = vi.fn();

vi.mock("../api/motions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/motions")>()),
  fetchMotionIntake: () => fetchMotionIntake(),
  fetchMotionQueue: (input?: unknown) => fetchMotionQueue(input),
  acknowledgeMotion: (input: unknown) => acknowledgeMotion(input),
  setMotionMeeting: (input: unknown) => setMotionMeeting(input),
}));

const fetchMeetings = vi.fn();

vi.mock("../api/meetings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/meetings")>()),
  fetchMeetings: () => fetchMeetings(),
}));

/** Two meetings: one still being arranged, one whose members are summoned. */
const ARRANGED = {
  id: "meeting-spring",
  kind: "ORDINARY" as const,
  heldOn: "2027-05-20",
  concludedAt: null,
  summoned: false,
  agendaItemCount: 2,
};

const CONCLUDED = {
  ...ARRANGED,
  id: "meeting-past",
  heldOn: "2026-05-20",
  concludedAt: "2026-05-20T19:00:00.000Z",
};

/**
 * A meeting still to be held whose members have already been summoned.
 *
 * The case a filter written on `concludedAt` alone lets through: it is neither
 * held nor free to take another item, because EFL 6 kap. 25 § leaves a meeting
 * unable to decide a matter its notice did not take up.
 */
const SUMMONED = {
  ...ARRANGED,
  id: "meeting-summoned",
  heldOn: "2027-04-10",
  summoned: true,
};

function viewer(capabilities: readonly string[]): Viewer {
  return {
    personId: "person-maja",
    firstName: "Maja",
    lastName: "Medlem",
    preferredLocale: "sv",
    capabilities: [...capabilities],
    housingCooperative: null,
  };
}

/** A motion as the queue answers with it, before the submitter is added. */
const MOTION = {
  id: "motion-1",
  title: "Laddstolpar i garaget",
  body: "Föreningen bör utreda vad laddstolpar skulle kosta.",
  status: "SUBMITTED" as const,
  submittedAt: "2027-01-20T09:00:00.000Z",
  closedAt: null,
  // With the board and on no meeting yet, which is where every motion starts:
  // which meeting takes it up is the board's answer and it has not given one.
  meeting: null,
};

const DEADLINE = { month: 1, day: 31, nextOn: "2027-01-31" };

beforeEach(() => {
  fetchMeetings.mockReset().mockResolvedValue({
    ok: true,
    value: [ARRANGED, CONCLUDED, SUMMONED],
  });
  setMotionMeeting.mockReset();
  fetchMotionIntake.mockReset().mockResolvedValue({
    ok: true,
    value: { deadline: DEADLINE, motions: [MOTION] },
  });
  fetchMotionQueue.mockReset().mockResolvedValue({
    ok: true,
    value: {
      deadline: DEADLINE,
      motions: [
        {
          ...MOTION,
          submitter: {
            kind: "member",
            personId: "person-maja",
            name: "Maja Medlem",
          },
          closedByPersonId: null,
        },
      ],
      nextCursor: null,
    },
  });
  acknowledgeMotion.mockReset().mockResolvedValue({
    ok: true,
    value: {
      ...MOTION,
      status: "ACKNOWLEDGED",
      closedAt: "2027-02-01T09:00:00.000Z",
      submitter: {
        kind: "member",
        personId: "person-maja",
        name: "Maja Medlem",
      },
      closedByPersonId: "person-bea",
    },
  });
});

describe("the board", () => {
  it("is given the page under the board's sign", async () => {
    render(<MotionQueueScreen viewer={viewer(["motions:handle"])} />);

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Styrelsen Hantera motioner",
      }),
    ).not.toBeNull();
    expect(
      screen.getByText("Det här ser bara styrelsen och administratören."),
    ).not.toBeNull();
    await screen.findByText("Motioner från medlemmarna");
  });

  it("is offered the queue and no form, whether or not it holds a tenant-ownership", async () => {
    /*
     * EFL 6 kap. 15 § attaches the right to put an item in to the membership
     * and not to the office. A board member who is also a member puts theirs in
     * from the house's page like anybody else, so this page neither offers the
     * form nor reads what it would need.
     */
    render(
      <MotionQueueScreen
        viewer={viewer(["motions:submit", "motions:handle"])}
      />,
    );

    await screen.findByText("Motioner från medlemmarna");
    expect(screen.queryByText("Lämna in ett ärende till stämman")).toBeNull();
    expect(screen.queryByText("Dina motioner")).toBeNull();
    expect(fetchMotionIntake).not.toHaveBeenCalled();
  });

  it("is told the bylaws' deadline from the queue's own read", async () => {
    // The queue carries the bylaws clause as the intake does, so the board's
    // page states it without asking for a member's intake on the board's
    // behalf.
    render(<MotionQueueScreen viewer={viewer(["motions:handle"])} />);

    await screen.findByText("Motioner från medlemmarna");
    expect(screen.getAllByText(/2027-01-31/u)).toHaveLength(1);
    expect(fetchMotionIntake).not.toHaveBeenCalled();
  });

  it("records a motion as received", async () => {
    render(<MotionQueueScreen viewer={viewer(["motions:handle"])} />);
    await screen.findByText("Motioner från medlemmarna");

    await userEvent.click(
      screen.getByRole("button", {
        name: "Anteckna motionen Laddstolpar i garaget som mottagen",
      }),
    );

    await waitFor(() => {
      expect(acknowledgeMotion).toHaveBeenCalledWith({ motionId: "motion-1" });
    });
  });

  it("reads the queue again after a refused acknowledgement", async () => {
    // Refused because a colleague closed it first: the row still says SUBMITTED,
    // and only a fresh read takes away a button that can only be refused again.
    acknowledgeMotion.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "already-closed" },
    });

    render(<MotionQueueScreen viewer={viewer(["motions:handle"])} />);
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Anteckna motionen Laddstolpar i garaget som mottagen",
      }),
    );

    await waitFor(() => {
      expect(fetchMotionQueue).toHaveBeenCalledTimes(2);
    });
  });

  it("holds every row's acknowledgement while one is being sent", async () => {
    const queued = {
      ...MOTION,
      submitter: { kind: "member", personId: "person-maja", name: "Maja" },
      closedByPersonId: null,
    };
    fetchMotionQueue.mockResolvedValue({
      ok: true,
      value: {
        deadline: DEADLINE,
        motions: [
          queued,
          { ...queued, id: "motion-2", title: "Cykelställ på gaveln" },
        ],
        nextCursor: null,
      },
    });
    acknowledgeMotion.mockReturnValue(new Promise(() => undefined));

    render(<MotionQueueScreen viewer={viewer(["motions:handle"])} />);
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Anteckna motionen Laddstolpar i garaget som mottagen",
      }),
    );

    expect(
      screen.getByRole("button", {
        name: "Anteckna motionen Cykelställ på gaveln som mottagen",
      }),
    ).toHaveProperty("disabled", true);
  });

  it("is offered no way to reject a motion", async () => {
    // Refusing to take up a member's item is not the board's to decide under EFL
    // 6 kap. 15 §, and whether the meeting adopts the proposal is minuted at the
    // meeting. There is no endpoint for it and there must be no control either.
    render(<MotionQueueScreen viewer={viewer(["motions:handle"])} />);
    await screen.findByText("Motioner från medlemmarna");

    for (const label of [/avslå/i, /avvisa/i, /neka/i]) {
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    }
  });

  it("does not name a member with protected personal data", async () => {
    // The board's own address book prints that name because a statutory register
    // has a reason to; a queue has none.
    fetchMotionQueue.mockResolvedValue({
      ok: true,
      value: {
        deadline: DEADLINE,
        motions: [
          {
            ...MOTION,
            submitter: { kind: "protected", personId: "person-maja" },
            closedByPersonId: null,
          },
        ],
        nextCursor: null,
      },
    });

    render(<MotionQueueScreen viewer={viewer(["motions:handle"])} />);
    await screen.findByText("Motioner från medlemmarna");

    expect(screen.queryByText("Maja Medlem")).toBeNull();
    expect(screen.getByText(/Skyddade personuppgifter/)).not.toBeNull();
  });
});

describe("putting an item to a meeting", () => {
  /*
   * EFL 6 kap. 15 § gives the member the right to have the item taken up at a
   * general meeting if the request reaches the board in time to go into the
   * notice, and 6 kap. 22 § has the notice state the matters to be dealt with.
   * So the board answers "which meeting", and the notice settles the answer.
   */
  const BOARD = ["motions:handle", "meetings:manage"];

  it("offers the meetings the server would accept, and no others", async () => {
    render(<MotionQueueScreen viewer={viewer(BOARD)} />);
    await screen.findByText("Motioner från medlemmarna");

    const choice = await screen.findByLabelText("Tas upp på");
    const offered = [...choice.querySelectorAll("option")].map(
      (option) => option.textContent,
    );

    /*
     * The meeting still being arranged, and neither of the two the server would
     * refuse: one recorded as held, and one whose members have been summoned.
     * A control that could only refuse is a worse way of saying so than not
     * offering it - and `concludedAt` alone does not tell the summoned one
     * apart, which is why the summary carries `summoned`.
     */
    expect(offered).toContain("Ordinarie föreningsstämma 2027-05-20");
    expect(offered).not.toContain("Ordinarie föreningsstämma 2026-05-20");
    expect(offered).not.toContain("Ordinarie föreningsstämma 2027-04-10");
    // And a way back to no meeting at all, which is the same answer set to none.
    expect(offered).toContain("Ingen stämma än");
  });

  it("records which meeting takes the item up", async () => {
    const user = userEvent.setup();
    setMotionMeeting.mockResolvedValue({
      ok: true,
      value: {
        ...MOTION,
        submitter: {
          kind: "member",
          personId: "person-maja",
          name: "Maja Medlem",
        },
        closedByPersonId: null,
        meeting: {
          id: ARRANGED.id,
          kind: "ORDINARY",
          heldOn: ARRANGED.heldOn,
          summoned: false,
        },
      },
    });

    render(<MotionQueueScreen viewer={viewer(BOARD)} />);
    await screen.findByText("Motioner från medlemmarna");

    await user.selectOptions(
      await screen.findByLabelText("Tas upp på"),
      ARRANGED.id,
    );

    await waitFor(() => {
      expect(setMotionMeeting).toHaveBeenCalledWith({
        motionId: MOTION.id,
        meetingId: ARRANGED.id,
      });
    });
    // The queue is read again rather than the write's answer being believed:
    // another board member may have moved the same item in the meantime.
    await waitFor(() => {
      expect(fetchMotionQueue.mock.calls.length).toBeGreaterThan(1);
    });
  });

  it("states the meeting instead of a control once the notice has gone out", async () => {
    fetchMotionQueue.mockResolvedValue({
      ok: true,
      value: {
        deadline: DEADLINE,
        motions: [
          {
            ...MOTION,
            submitter: {
              kind: "member",
              personId: "person-maja",
              name: "Maja Medlem",
            },
            closedByPersonId: null,
            meeting: {
              id: ARRANGED.id,
              kind: "ORDINARY",
              heldOn: ARRANGED.heldOn,
              summoned: true,
            },
          },
        ],
        nextCursor: null,
      },
    });

    render(<MotionQueueScreen viewer={viewer(BOARD)} />);
    await screen.findByText("Motioner från medlemmarna");

    /*
     * A meeting cannot decide a matter its notice did not take up (EFL 6 kap.
     * 25 §), so the item can no longer be moved off or on. The server refuses
     * the change; the row says where the item is rather than offering a select
     * that could only be set back to the value it already had.
     */
    expect(screen.queryByLabelText("Tas upp på")).toBeNull();
    expect(
      screen.getByText(/Kallelsen till den st.mman .r utf.rdad/u),
    ).toBeTruthy();
  });

  it("states a meeting already held instead of offering to move the item", async () => {
    /*
     * The server checks the meeting being left as well as the one being joined,
     * and refuses one that has been recorded as held - so a select here could
     * only move the item off a meeting the server will not let go of.
     *
     * The motion's own copy of a meeting carries `summoned` and not
     * `concludedAt`, which is why the panel reads that state from the list.
     */
    fetchMotionQueue.mockResolvedValue({
      ok: true,
      value: {
        deadline: DEADLINE,
        motions: [
          {
            ...MOTION,
            submitter: {
              kind: "member",
              personId: "person-maja",
              name: "Maja Medlem",
            },
            closedByPersonId: null,
            meeting: {
              id: CONCLUDED.id,
              kind: "ORDINARY",
              heldOn: CONCLUDED.heldOn,
              summoned: false,
            },
          },
        ],
        nextCursor: null,
      },
    });

    render(<MotionQueueScreen viewer={viewer(BOARD)} />);
    await screen.findByText("Motioner från medlemmarna");

    await screen.findByText(/som är antecknad som hållen/u);
    expect(screen.queryByLabelText("Tas upp på")).toBeNull();
  });

  it("says the read failed rather than that no meeting is arranged", async () => {
    /*
     * Null meetings mean two different things and the board is owed the right
     * one. "The association has arranged no meeting" is a claim about the
     * cooperative; a read that never answered supports no such claim.
     */
    fetchMeetings.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });

    render(<MotionQueueScreen viewer={viewer(BOARD)} />);
    await screen.findByText("Motioner från medlemmarna");

    await screen.findByText(/Stämmorna kunde inte läsas/u);
    expect(screen.queryByText(/har inte planerat in någon stämma/u)).toBeNull();
  });

  it("offers no control to a board member who may not read the meetings", async () => {
    render(<MotionQueueScreen viewer={viewer(["motions:handle"])} />);
    await screen.findByText("Motioner från medlemmarna");

    // Which meeting deals with an item is a fact about a meeting, so it is read
    // with the capability that answers for meetings. A seat granted only the
    // queue is offered no control rather than an empty one.
    expect(fetchMeetings).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Tas upp på")).toBeNull();
  });
});

describe("a queue longer than one page", () => {
  it("offers the page behind it, and adds it to the end", async () => {
    /*
     * The queue is read a page at a time because a motion's body runs to eight
     * thousand characters and an association accumulates a queue for as long as
     * it exists. The control is offered from the server's own cursor rather than
     * from the page's length, so a queue ending exactly on a boundary is not
     * offered a control that would fetch nothing.
     */
    const second = {
      ...MOTION,
      id: "motion-2",
      title: "Laddstolpar på gården",
      submitter: {
        kind: "member",
        personId: "person-nils",
        name: "Nils Medlem",
      },
      closedByPersonId: null,
    };
    fetchMotionQueue
      .mockResolvedValueOnce({
        ok: true,
        value: {
          deadline: DEADLINE,
          motions: [
            {
              ...MOTION,
              submitter: {
                kind: "member",
                personId: "person-maja",
                name: "Maja Medlem",
              },
              closedByPersonId: null,
            },
          ],
          nextCursor: "SUBMITTED|2027-01-02T09:00:00.000Z|motion-1",
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { deadline: DEADLINE, motions: [second], nextCursor: null },
      });

    render(
      <MotionQueueScreen
        viewer={viewer(["motions:handle", "meetings:manage"])}
      />,
    );
    await screen.findByText("Motioner från medlemmarna");

    await userEvent.click(screen.getByText("Visa fler motioner"));

    // The first page is still there: the board has read what is above and is
    // reaching for what is below.
    expect(await screen.findByText("Laddstolpar på gården")).not.toBeNull();
    expect(screen.getByText(MOTION.title)).not.toBeNull();
    expect(fetchMotionQueue.mock.calls[1]?.[0]).toEqual({
      after: "SUBMITTED|2027-01-02T09:00:00.000Z|motion-1",
    });
    // And the end of the queue takes the control away.
    expect(screen.queryByText("Visa fler motioner")).toBeNull();
  });

  it("keeps one row when an item comes back on a later page, where it now sorts", async () => {
    /*
     * The queue is ordered by the state an item is in, and it is written into
     * while it is being read: an item read as open on the first page can be
     * acknowledged before the second is asked for, and it then sorts into a
     * later group - which is after the cursor, so the server answers with it
     * again. The server is right to; nothing there remembers what this reader
     * has seen. So the screen merges by id, the later copy wins because it
     * carries the state the item is now in, and it takes the later copy's
     * place, because that is where the server's ordering now puts it.
     */
    const submitter = {
      kind: "member",
      personId: "person-maja",
      name: "Maja Medlem",
    };
    const first = { ...MOTION, submitter, closedByPersonId: null };
    const second = {
      ...MOTION,
      id: "motion-2",
      title: "Cykelrum i källaren",
      submitter,
      closedByPersonId: null,
    };
    fetchMotionQueue
      .mockResolvedValueOnce({
        ok: true,
        value: {
          deadline: DEADLINE,
          motions: [first, second],
          nextCursor: "SUBMITTED|2027-01-20T09:00:00.000Z|motion-2",
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          deadline: DEADLINE,
          motions: [
            {
              ...first,
              status: "ACKNOWLEDGED",
              closedAt: "2027-02-01T09:00:00.000Z",
              closedByPersonId: "person-bea",
            },
          ],
          nextCursor: null,
        },
      });

    render(
      <MotionQueueScreen
        viewer={viewer(["motions:handle", "meetings:manage"])}
      />,
    );
    await screen.findByText("Motioner från medlemmarna");

    await userEvent.click(screen.getByText("Visa fler motioner"));

    // One row for it, not two.
    await waitFor(() => {
      expect(screen.getAllByText(MOTION.title)).toHaveLength(1);
    });
    // And after the item still open, not above it: an acknowledged item left
    // among the open ones would contradict the order the queue is read in.
    const titles = screen
      .getAllByText(/^(Laddstolpar i garaget|Cykelrum i källaren)$/u)
      .map((element) => element.textContent);
    expect(titles).toEqual(["Cykelrum i källaren", "Laddstolpar i garaget"]);
  });

  it("says so beside the control when the page below cannot be read", async () => {
    /*
     * One request for more failed; the queue on the screen did not. So the
     * sentence is beside the control that made the request, the rows already
     * read stay, and the control is offered again - the comment thread's rule
     * for a failed earlier page. A control that silently came back would leave
     * the board pressing it with nothing to tell them why nothing happened.
     */
    const open = {
      ...MOTION,
      submitter: {
        kind: "member",
        personId: "person-maja",
        name: "Maja Medlem",
      },
      closedByPersonId: null,
    };
    fetchMotionQueue
      .mockResolvedValueOnce({
        ok: true,
        value: {
          deadline: DEADLINE,
          motions: [open],
          nextCursor: "SUBMITTED|2027-01-20T09:00:00.000Z|motion-1",
        },
      })
      .mockResolvedValueOnce({
        ok: false,
        failure: { status: 503, reason: "unexpected" },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { deadline: DEADLINE, motions: [], nextCursor: null },
      });

    render(
      <MotionQueueScreen
        viewer={viewer(["motions:handle", "meetings:manage"])}
      />,
    );
    await screen.findByText("Motioner från medlemmarna");

    await userEvent.click(screen.getByText("Visa fler motioner"));

    expect(
      await screen.findByText(/Fler motioner kunde inte läsas just nu/u),
    ).not.toBeNull();
    expect(screen.getByText(MOTION.title)).not.toBeNull();
    // Not the screen-wide failure: the first read did not fail.
    expect(
      screen.queryByText("Motionerna kunde inte läsas just nu."),
    ).toBeNull();

    // Asked again, and answered: the sentence goes with the failure it was
    // about.
    await userEvent.click(screen.getByText("Visa fler motioner"));
    await waitFor(() => {
      expect(
        screen.queryByText(/Fler motioner kunde inte läsas just nu/u),
      ).toBeNull();
    });
  });

  it("keeps the pages below in view after acting on an item on one of them", async () => {
    const submitter = {
      kind: "member",
      personId: "person-maja",
      name: "Maja Medlem",
    };
    const first = { ...MOTION, submitter, closedByPersonId: null };
    const below = {
      ...first,
      id: "motion-2",
      title: "Cykelrum i källaren",
    };
    const cursor = "SUBMITTED|2027-01-20T09:00:00.000Z|motion-1";
    const page = (motions: readonly unknown[], nextCursor: string | null) => ({
      ok: true,
      value: { deadline: DEADLINE, motions, nextCursor },
    });
    fetchMotionQueue.mockImplementation((input?: { after?: string }) =>
      Promise.resolve(
        input?.after === cursor ? page([below], null) : page([first], cursor),
      ),
    );

    render(<MotionQueueScreen viewer={viewer(["motions:handle"])} />);
    await userEvent.click(await screen.findByText("Visa fler motioner"));
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Anteckna motionen Cykelrum i källaren som mottagen",
      }),
    );

    // The re-read reaches as far down as the board had read, so the item just
    // handled is still on the screen rather than the queue collapsing to its top.
    await waitFor(() => {
      expect(fetchMotionQueue).toHaveBeenCalledTimes(4);
    });
    expect(fetchMotionQueue.mock.calls[3]?.[0]).toEqual({ after: cursor });
    expect(await screen.findByText("Cykelrum i källaren")).not.toBeNull();
    expect(screen.queryByText("Visa fler motioner")).toBeNull();
  });

  it("keeps the pages it has read when a later page fails during the re-read after an act", async () => {
    const submitter = {
      kind: "member",
      personId: "person-maja",
      name: "Maja Medlem",
    };
    const first = { ...MOTION, submitter, closedByPersonId: null };
    const second = { ...first, id: "motion-2", title: "Cykelrum i källaren" };
    const third = { ...first, id: "motion-3", title: "Ny grind" };
    const cursorOne = "SUBMITTED|2027-01-20T09:00:00.000Z|motion-1";
    const cursorTwo = "SUBMITTED|2027-01-21T09:00:00.000Z|motion-2";
    const page = (motions: readonly unknown[], nextCursor: string | null) => ({
      ok: true,
      value: { deadline: DEADLINE, motions, nextCursor },
    });
    let secondPageFails = false;
    fetchMotionQueue.mockImplementation((input?: { after?: string }) => {
      if (input?.after === cursorOne) {
        return Promise.resolve(
          secondPageFails
            ? { ok: false, failure: { status: 503, reason: "unexpected" } }
            : page([second], cursorTwo),
        );
      }
      if (input?.after === cursorTwo) {
        return Promise.resolve(page([third], null));
      }
      return Promise.resolve(page([first], cursorOne));
    });

    render(<MotionQueueScreen viewer={viewer(["motions:handle"])} />);
    await userEvent.click(await screen.findByText("Visa fler motioner"));
    await userEvent.click(await screen.findByText("Visa fler motioner"));
    await screen.findByText("Ny grind");

    // The next read of page two fails, as the re-read after the act reaches it.
    secondPageFails = true;
    await userEvent.click(
      screen.getByRole("button", {
        name: "Anteckna motionen Ny grind som mottagen",
      }),
    );

    // What was read before the failure stays, the failure is said beside the
    // control, and the screen-wide failure is not raised.
    expect(
      await screen.findByText(/Fler motioner kunde inte läsas just nu/u),
    ).not.toBeNull();
    expect(screen.getByText(MOTION.title)).not.toBeNull();
    expect(
      screen.queryByText("Motionerna kunde inte läsas just nu."),
    ).toBeNull();

    // The control offers the page that failed, and gets it.
    secondPageFails = false;
    await userEvent.click(screen.getByText("Visa fler motioner"));
    expect(await screen.findByText("Cykelrum i källaren")).not.toBeNull();
    expect(
      screen.queryByText(/Fler motioner kunde inte läsas just nu/u),
    ).toBeNull();
  });
});

describe("two re-reads that overlap", () => {
  it("does not let the older one, failing on a later page, shorten the next re-read", async () => {
    /*
     * How deep a re-read goes is what the board has read down to. An older read
     * that stops short on a page must not move it once a newer read has gone
     * through to the end, or the next re-read would cut the queue back and take
     * the rows the board is working on out of view.
     */
    const submitter = {
      kind: "member",
      personId: "person-maja",
      name: "Maja Medlem",
    };
    const first = { ...MOTION, submitter, closedByPersonId: null };
    const second = { ...first, id: "motion-2", title: "Cykelrum i källaren" };
    const third = { ...first, id: "motion-3", title: "Ny grind" };
    const cursorOne = "SUBMITTED|2027-01-20T09:00:00.000Z|motion-1";
    const cursorTwo = "SUBMITTED|2027-01-21T09:00:00.000Z|motion-2";
    const page = (motions: readonly unknown[], nextCursor: string | null) => ({
      ok: true,
      value: { deadline: DEADLINE, motions, nextCursor },
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let secondPageReads = 0;
    fetchMotionQueue.mockImplementation(async (input?: { after?: string }) => {
      if (input?.after === cursorOne) {
        secondPageReads += 1;
        // The read started by the first act fails, but only once the second has
        // gone through.
        if (secondPageReads === 2) {
          await held;
          return { ok: false, failure: { status: 503, reason: "unexpected" } };
        }
        return page([second], cursorTwo);
      }
      if (input?.after === cursorTwo) {
        return page([third], null);
      }
      return page([first], cursorOne);
    });

    render(<MotionQueueScreen viewer={viewer(["motions:handle"])} />);
    await userEvent.click(await screen.findByText("Visa fler motioner"));
    await userEvent.click(await screen.findByText("Visa fler motioner"));
    await screen.findByText("Ny grind");

    await userEvent.click(
      screen.getByRole("button", {
        name: "Anteckna motionen Ny grind som mottagen",
      }),
    );
    await waitFor(() => {
      expect(secondPageReads).toBe(2);
    });
    await userEvent.click(
      screen.getByRole("button", {
        name: "Anteckna motionen Cykelrum i källaren som mottagen",
      }),
    );
    await waitFor(() => {
      expect(secondPageReads).toBe(3);
    });
    await screen.findByText("Ny grind");

    await act(async () => {
      release();
      await held;
    });

    fetchMotionQueue.mockClear();
    await userEvent.click(
      screen.getByRole("button", {
        name: "Anteckna motionen Ny grind som mottagen",
      }),
    );
    await waitFor(() => {
      expect(fetchMotionQueue).toHaveBeenCalledWith({ after: cursorTwo });
    });
  });
});

describe("a re-read that fails", () => {
  /*
   * Every act ends in a re-read, and that read can fail. What the page showed
   * is then the last thing it knew, and the failure notice says it could not
   * read again. Emptying the queue instead put a sentence under the notice that
   * was not true: that nothing was waiting for the board.
   */
  const FAILED = {
    ok: false,
    failure: { status: 503, reason: "unexpected" },
  };

  it("keeps the board's queue", async () => {
    fetchMotionQueue
      .mockResolvedValueOnce({
        ok: true,
        value: {
          deadline: DEADLINE,
          motions: [
            {
              ...MOTION,
              submitter: {
                kind: "member",
                personId: "person-maja",
                name: "Maja Medlem",
              },
              closedByPersonId: null,
            },
          ],
          nextCursor: null,
        },
      })
      .mockResolvedValueOnce(FAILED);

    render(<MotionQueueScreen viewer={viewer(["motions:handle"])} />);
    await screen.findByText("Motioner från medlemmarna");

    await userEvent.click(
      screen.getByRole("button", {
        name: `Anteckna motionen ${MOTION.title} som mottagen`,
      }),
    );

    await screen.findByText("Motionerna kunde inte läsas just nu.");
    expect(screen.getByText(MOTION.title)).not.toBeNull();
    expect(
      screen.queryByText("Inga motioner har lämnats in till stämman."),
    ).toBeNull();
  });
});

describe("a member who is not on the board", () => {
  it("is told the page is the board's, under no sign, and nothing is read", async () => {
    render(<MotionQueueScreen viewer={viewer(["motions:submit"])} />);

    await screen.findByText(
      "Den här sidan är styrelsens. Ditt konto har inget att göra här.",
    );
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(screen.queryByText("Styrelsen")).toBeNull();
    expect(screen.queryByText("Motioner från medlemmarna")).toBeNull();
    expect(fetchMotionQueue).not.toHaveBeenCalled();
    expect(fetchMeetings).not.toHaveBeenCalled();
    expect(fetchMotionIntake).not.toHaveBeenCalled();
  });
});
