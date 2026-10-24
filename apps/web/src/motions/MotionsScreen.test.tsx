import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { Viewer } from "../api/instance";
import type { OwnMotion } from "../api/motions";
import { MotionsScreen } from "./MotionsScreen";

/**
 * What the house's motions page gives a seat.
 *
 * The API refuses every call whatever the browser was shown, so hiding a panel
 * is courtesy. What is not courtesy is the read behind it: the board's queue is
 * the one place a motion says which member proposed what, and a page that
 * asked for it on a member's behalf would be asking the server for other
 * people's data with nowhere to put it. The queue is the board's page now
 * (ADR 0049), so this file asserts that the house's page never makes the
 * request, for a board member as much as for anybody.
 *
 * Who is offered the form is a statute rather than a product decision.
 * `motions:submit` is derived from membership under EFL 6 kap. 15 §, applied
 * to a housing cooperative by BRL 9 kap. 14 §, so a resident who holds no
 * tenant-ownership is offered no form.
 */

const fetchMotionIntake = vi.fn();
const fetchMotionQueue = vi.fn();
const withdrawMotion = vi.fn();

vi.mock("../api/motions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/motions")>()),
  fetchMotionIntake: () => fetchMotionIntake(),
  fetchMotionQueue: (input?: unknown) => fetchMotionQueue(input),
  withdrawMotion: (input: unknown) => withdrawMotion(input),
}));

const fetchMeetings = vi.fn();

vi.mock("../api/meetings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/meetings")>()),
  fetchMeetings: () => fetchMeetings(),
}));

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

const OWN_MOTION = {
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
  fetchMeetings.mockReset().mockResolvedValue({ ok: true, value: [] });
  fetchMotionIntake.mockReset().mockResolvedValue({
    ok: true,
    value: { deadline: DEADLINE, motions: [OWN_MOTION] },
  });
  fetchMotionQueue.mockReset().mockResolvedValue({
    ok: true,
    value: {
      deadline: DEADLINE,
      motions: [
        {
          ...OWN_MOTION,
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
  withdrawMotion.mockReset().mockResolvedValue({
    ok: true,
    value: {
      ...OWN_MOTION,
      status: "WITHDRAWN",
      closedAt: "2027-02-01T09:00:00.000Z",
    },
  });
});

describe("a member", () => {
  it("is offered the form and their own motions, and never the queue", async () => {
    render(<MotionsScreen viewer={viewer(["motions:submit"])} />);

    await screen.findByText("Lämna in ett ärende till stämman");
    expect(screen.getByText("Dina motioner")).not.toBeNull();
    expect(screen.queryByText("Motioner från medlemmarna")).toBeNull();

    /*
     * And the read behind the panel was never issued. The queue says which member
     * proposed what, and a page with nowhere to put that must not ask for it -
     * asserting only the missing heading would pass while the request went out.
     */
    expect(fetchMotionQueue).not.toHaveBeenCalled();
    expect(fetchMotionIntake).toHaveBeenCalledTimes(1);
  });

  it("is told the bylaws' deadline, and that a later motion is still taken", async () => {
    // The deadline is the condition on reaching a particular meeting, not on the
    // association's ability to receive one. A form that showed the date without
    // saying so would leave a member believing a late item was on the agenda.
    render(<MotionsScreen viewer={viewer(["motions:submit"])} />);

    await screen.findByText("Lämna in ett ärende till stämman");
    expect(
      screen.getByText(/senast 2027-01-31.*tas ändå emot/s),
    ).not.toBeNull();
  });

  it("is told the bylaws set none rather than shown an invented date", async () => {
    fetchMotionIntake.mockResolvedValue({
      ok: true,
      value: { deadline: null, motions: [] },
    });

    render(<MotionsScreen viewer={viewer(["motions:submit"])} />);

    await screen.findByText("Lämna in ett ärende till stämman");
    expect(
      screen.getByText(/stadgar anger ingen tid för motioner/),
    ).not.toBeNull();
  });

  it("can withdraw an open motion, and is offered nothing on a closed one", async () => {
    fetchMotionIntake.mockResolvedValue({
      ok: true,
      value: {
        deadline: DEADLINE,
        motions: [
          OWN_MOTION,
          {
            ...OWN_MOTION,
            id: "motion-2",
            title: "Cykelställ på gaveln",
            status: "ACKNOWLEDGED" as const,
            closedAt: "2027-02-01T09:00:00.000Z",
          },
        ],
        nextCursor: null,
      },
    });

    render(<MotionsScreen viewer={viewer(["motions:submit"])} />);
    await screen.findByText("Dina motioner");

    // Offered on the open one, because that is the only state the API accepts.
    // A button on the closed one would always fail, which is a worse way to say
    // so than no button.
    expect(
      screen.getByRole("button", {
        name: "Återkalla motionen Laddstolpar i garaget",
      }),
    ).not.toBeNull();
    expect(
      screen.queryByRole("button", {
        name: "Återkalla motionen Cykelställ på gaveln",
      }),
    ).toBeNull();

    await userEvent.click(
      screen.getByRole("button", {
        name: "Återkalla motionen Laddstolpar i garaget",
      }),
    );
    await waitFor(() => {
      expect(withdrawMotion).toHaveBeenCalledWith({ motionId: "motion-1" });
    });
  });

  it("reads the list again after a refused withdrawal", async () => {
    // The refusal that matters most is the board having acknowledged the motion
    // meanwhile: the row on screen is wrong, and without a re-read every retry
    // is refused again.
    withdrawMotion.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "already-closed" },
    });

    render(<MotionsScreen viewer={viewer(["motions:submit"])} />);
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Återkalla motionen Laddstolpar i garaget",
      }),
    );

    await waitFor(() => {
      expect(fetchMotionIntake).toHaveBeenCalledTimes(2);
    });
  });

  it("holds every row's withdrawal while one is being sent", async () => {
    fetchMotionIntake.mockResolvedValue({
      ok: true,
      value: {
        deadline: DEADLINE,
        motions: [
          OWN_MOTION,
          { ...OWN_MOTION, id: "motion-2", title: "Cykelställ på gaveln" },
        ],
      },
    });
    withdrawMotion.mockReturnValue(new Promise(() => undefined));

    render(<MotionsScreen viewer={viewer(["motions:submit"])} />);
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Återkalla motionen Laddstolpar i garaget",
      }),
    );

    expect(
      screen.getByRole("button", {
        name: "Återkalla motionen Cykelställ på gaveln",
      }),
    ).toHaveProperty("disabled", true);
  });
});

describe("two acts whose answers cross", () => {
  it("keeps the newer read and drops the one it overtook", async () => {
    /*
     * Every act on this screen ends in a re-read, so two of them can be in
     * flight at once - a member withdraws one motion and then another before the
     * first answer is back. Both answers are well formed and the screen cannot
     * tell them apart by content, so the only rule available is that the newest
     * read wins. Applying whichever response happens to arrive last puts a
     * withdrawn motion back on the screen as open, with a control that would now
     * be refused.
     */
    const SECOND: OwnMotion = {
      ...OWN_MOTION,
      id: "motion-2",
      title: "Cykelställ på gaveln",
    };
    const withdrawn = (motion: OwnMotion): OwnMotion => ({
      ...motion,
      status: "WITHDRAWN",
      closedAt: "2027-02-01T09:00:00.000Z",
    });
    const intake = (
      motions: readonly OwnMotion[],
    ): { ok: true; value: unknown } => ({
      ok: true,
      value: { deadline: DEADLINE, motions },
    });

    // The read behind the first withdrawal, held open so the second one's answer
    // gets in front of it.
    let overtaken = (): void => undefined;
    const slow = new Promise((resolve) => {
      overtaken = () => {
        resolve(intake([withdrawn(OWN_MOTION), SECOND]));
      };
    });

    fetchMotionIntake
      .mockResolvedValueOnce(intake([OWN_MOTION, SECOND]))
      .mockReturnValueOnce(slow)
      .mockResolvedValueOnce(
        intake([withdrawn(OWN_MOTION), withdrawn(SECOND)]),
      );
    withdrawMotion.mockResolvedValue({ ok: true, value: withdrawn(SECOND) });

    render(<MotionsScreen viewer={viewer(["motions:submit"])} />);
    await screen.findByText("Dina motioner");

    const withdrawSecond = screen.getByRole("button", {
      name: `Återkalla motionen ${SECOND.title}`,
    });
    await userEvent.click(
      screen.getByRole("button", {
        name: `Återkalla motionen ${OWN_MOTION.title}`,
      }),
    );
    await userEvent.click(withdrawSecond);

    // Both reads have gone out and the second has been applied.
    await waitFor(() => {
      expect(fetchMotionIntake).toHaveBeenCalledTimes(3);
    });
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /^Återkalla motionen/ }),
      ).toBeNull();
    });

    // And now the read they overtook comes back.
    await act(async () => {
      overtaken();
      await slow;
    });

    expect(
      screen.queryByRole("button", {
        name: `Återkalla motionen ${SECOND.title}`,
      }),
    ).toBeNull();
  });
});

/**
 * One page, one audience: a board member who is also a member puts an item in
 * from here like anybody else, and works the queue on the board's own page
 * (ADR 0049).
 */
describe("a board member who is also a member", () => {
  it("shows no board content to a board member", async () => {
    render(
      <MotionsScreen
        viewer={viewer(["motions:submit", "motions:handle", "meetings:manage"])}
      />,
    );

    await screen.findByText("Lämna in ett ärende till stämman");
    expect(screen.getByText("Dina motioner")).not.toBeNull();
    expect(screen.queryByText("Motioner från medlemmarna")).toBeNull();
    expect(screen.queryByText("Styrelsen")).toBeNull();
    // One deadline, from the intake: the queue that also carries it is not read.
    expect(screen.getAllByText(/2027-01-31/u)).toHaveLength(1);
    expect(fetchMotionQueue).not.toHaveBeenCalled();
    expect(fetchMeetings).not.toHaveBeenCalled();
  });
});

describe("a resident who is not a member", () => {
  it("is offered no form, and no read is issued", async () => {
    // A partner, an adult child or a tenant. They live here and hold no
    // tenant-ownership, so EFL 6 kap. 15 § gives them nothing here - and the
    // navigation does not offer this destination to them either.
    render(
      <MotionsScreen
        viewer={viewer(["self:manage", "residentDirectory:read"])}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("Läser in motionerna...")).toBeNull();
    });
    expect(screen.queryByText("Lämna in ett ärende till stämman")).toBeNull();
    expect(screen.queryByText("Motioner från medlemmarna")).toBeNull();
    expect(fetchMotionIntake).not.toHaveBeenCalled();
    expect(fetchMotionQueue).not.toHaveBeenCalled();
  });
});

describe("a re-read that fails", () => {
  /*
   * Every act ends in a re-read, and that read can fail. What the screen
   * showed is then the last thing it knew, and the failure notice says it could
   * not read again. Emptying the lists instead put sentences under the notice
   * that were not true: that the member had sent no motion, that the bylaws
   * set no deadline.
   */
  const FAILED = {
    ok: false,
    failure: { status: 503, reason: "unexpected" },
  };

  it("keeps a member's own motions and the deadline", async () => {
    fetchMotionIntake
      .mockResolvedValueOnce({
        ok: true,
        value: { deadline: DEADLINE, motions: [OWN_MOTION] },
      })
      .mockResolvedValueOnce(FAILED);

    render(<MotionsScreen viewer={viewer(["motions:submit"])} />);
    await screen.findByText("Dina motioner");

    await userEvent.click(
      screen.getByRole("button", {
        name: `Återkalla motionen ${OWN_MOTION.title}`,
      }),
    );

    await screen.findByText("Motionerna kunde inte läsas just nu.");
    expect(screen.getByText(OWN_MOTION.title)).not.toBeNull();
    expect(screen.getByText(/senast 2027-01-31/u)).not.toBeNull();
    expect(
      screen.queryByText("Du har inte lämnat in någon motion."),
    ).toBeNull();
    expect(screen.queryByText(/stadgar anger ingen tid/u)).toBeNull();
  });
});
