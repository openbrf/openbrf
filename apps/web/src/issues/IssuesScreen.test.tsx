import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import "../i18n";
import { ok, post, refused, viewer } from "../feed/feed-fixtures";
import { IssuesScreen } from "./IssuesScreen";

/**
 * An issue report made from a post in the feed ("Gör felanmälan").
 *
 * **The form opens with the post.** Its text, and its images as photographs
 * the form uploads like any it was given.
 *
 * **A post that cannot be read is said in a sentence**, and the form opens
 * empty: the feed answers a post this account may not read exactly as one that
 * does not exist, and so does this screen.
 *
 * **Once filed, the way back to the post is offered**, where the report's
 * status now shows.
 */

const fetchPost = vi.fn();
const reportIssue = vi.fn();
const attachIssuePhoto = vi.fn();
const fetchOwnIssues = vi.fn();
const fetchOwnIssueMessages = vi.fn();
const sendOwnIssueMessage = vi.fn();
const fetchKnownFaults = vi.fn();
const fetchGuide = vi.fn();

vi.mock("../api/feed", () => ({
  fetchPost: (input: unknown) => fetchPost(input),
}));

vi.mock("../api/issues", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/issues")>()),
  fetchReportableTypes: () =>
    Promise.resolve(
      ok([{ id: "type-lift", name: "Hiss", reporters: ["RESIDENTS"] }]),
    ),
  fetchOwnApartments: () => Promise.resolve(ok([])),
  fetchReporterResponsibilityGuide: () => fetchGuide(),
  fetchOwnIssues: () => fetchOwnIssues(),
  fetchKnownFaults: () => fetchKnownFaults(),
  fetchOwnIssueMessages: (id: string) => fetchOwnIssueMessages(id),
  sendOwnIssueMessage: (input: unknown) => sendOwnIssueMessage(input),
  fetchIssueQueue: () => Promise.resolve(ok([])),
  reportIssue: (input: unknown) => reportIssue(input),
  attachIssuePhoto: (issueId: string, file: File) =>
    attachIssuePhoto(issueId, file),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    params,
    children,
    className,
  }: {
    to: string;
    params?: { postId?: string };
    children: ReactNode;
    className?: string;
  }): ReactElement => (
    <a
      href={
        params?.postId === undefined ? to : to.replace("$postId", params.postId)
      }
      className={className}
    >
      {children}
    </a>
  ),
}));

const LIFT = post({
  id: "post-1",
  body: "Hissen i port 14 står still igen.",
  images: [
    { id: "file-1", url: "/media/file-1", width: 800, height: 600 },
    { id: "file-2", url: "/media/file-2", width: 800, height: 600 },
  ],
});

const READER = viewer(["issues:report"]);

/** jsdom lays nothing out and has no scrollIntoView; a follow-up calls it. */
const scrollIntoView = vi.fn();
const ownScrollIntoView = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "scrollIntoView",
);

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = scrollIntoView;
  fetchOwnIssues.mockResolvedValue(ok([]));
  fetchKnownFaults.mockResolvedValue(ok([]));
  fetchGuide.mockResolvedValue(ok({ guide: null }));
  reportIssue.mockResolvedValue(ok({ id: "issue-1" }));
  attachIssuePhoto.mockResolvedValue(
    ok({
      id: "photo-1",
      url: "/media/photo-1",
      fileName: "x",
      width: null,
      height: null,
    }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      Promise.resolve(
        url === "/media/file-2"
          ? new Response(null, { status: 404 })
          : new Response(new Blob(["bytes"], { type: "image/jpeg" })),
      ),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (ownScrollIntoView !== undefined) {
    Object.defineProperty(
      Element.prototype,
      "scrollIntoView",
      ownScrollIntoView,
    );
  } else {
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  }
});

describe("a report made from a post", () => {
  it("opens with the post's text and images, and offers the way back once filed", async () => {
    fetchPost.mockResolvedValue(ok(LIFT));
    render(<IssuesScreen viewer={READER} fromPostId="post-1" />);

    const description = (await screen.findByLabelText(
      /vad har hänt/i,
    )) as HTMLTextAreaElement;
    expect(description.value).toBe("Hissen i port 14 står still igen.");
    expect(fetchPost).toHaveBeenCalledWith({ postId: "post-1" });
    expect(screen.getByText(/^Bild 1 från inlägget/u)).toBeTruthy();
    // The second image could not be read, and the reporter is told so.
    expect(
      screen.getByText(/1 bild från inlägget kunde inte läggas till/u),
    ).toBeTruthy();

    await userEvent.selectOptions(
      screen.getByLabelText(/vad gäller det/i),
      "type-lift",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /skicka anmälan/i }),
    );

    await waitFor(() => {
      expect(reportIssue).toHaveBeenCalledWith(
        expect.objectContaining({ postId: "post-1" }),
      );
    });
    expect(
      (
        await screen.findByRole("link", { name: "Tillbaka till inlägget" })
      ).getAttribute("href"),
    ).toBe("/feed/post-1");
  });

  it("says so when the post cannot be read, and opens the form empty", async () => {
    fetchPost.mockResolvedValue(refused(404, "post-not-found"));
    render(<IssuesScreen viewer={READER} fromPostId="post-secret" />);

    expect(await screen.findByText(/Inlägget kunde inte läsas/u)).toBeTruthy();
    const description = (await screen.findByLabelText(
      /vad har hänt/i,
    )) as HTMLTextAreaElement;
    expect(description.value).toBe("");
  });

  it("reads no post for an account that does not report issues", async () => {
    render(
      <IssuesScreen viewer={viewer(["issues:handle"])} fromPostId="post-1" />,
    );
    await waitFor(() => {
      expect(screen.queryByRole("status")).toBeNull();
    });
    expect(fetchPost).not.toHaveBeenCalled();
  });

  it("keeps the reports on show when the list cannot be read again after a reply finds one closed", async () => {
    fetchOwnIssues.mockResolvedValueOnce(
      ok([
        {
          id: "issue-1",
          meaning: "IN_PROGRESS",
          typeId: "type-lift",
          typeName: "Hiss",
          location: null,
          description: "Hissen står still.",
          apartment: null,
          photos: [],
          enteredByHandler: false,
          descriptionRedactedAt: null,
          locationRedactedAt: null,
          freeTextRemovedAt: null,
          createdAt: "2026-08-20T08:00:00.000Z",
          updatedAt: "2026-08-20T08:00:00.000Z",
        },
      ]),
    );
    fetchOwnIssueMessages.mockResolvedValue(ok([]));
    sendOwnIssueMessage.mockResolvedValue(refused(409, "issue-closed"));
    const session = userEvent.setup();
    render(<IssuesScreen viewer={READER} />);

    expect(await screen.findByText("Hissen står still.")).toBeTruthy();
    // The re-read that the closed answer asks for fails.
    fetchOwnIssues.mockResolvedValue(refused(500, "unknown"));
    await session.click(screen.getByText("Meddelanden om Hiss"));
    await session.type(
      await screen.findByLabelText("Hiss: ditt meddelande"),
      "Hallå",
    );
    await session.click(screen.getByRole("button", { name: "Skicka" }));

    await waitFor(() => {
      expect(fetchOwnIssues).toHaveBeenCalledTimes(2);
    });
    await screen.findByText("Ärendena kunde inte läsas just nu.");
    expect(screen.getByText("Hissen står still.")).toBeTruthy();
  });

  /*
   * Opens a report with the adopted guide on show, then has the answer to a
   * reply say the report is closed, which makes the screen read everything
   * again. Comes back once that re-read has been applied: the composer is gone
   * only after the lists have been set, and the guide is set with them.
   */
  async function reopenWithAdoptedGuide(
    guideAfter: ReturnType<typeof ok> | ReturnType<typeof refused>,
  ): Promise<void> {
    const guide = {
      adoptedAt: "2026-08-01T08:00:00.000Z",
      version: "2026-08-01T08:00:00.000Z",
      items: [
        {
          part: "Golvbrunn",
          responsibility: "ASSOCIATION" as const,
          note: null,
        },
      ],
    };
    fetchGuide.mockResolvedValueOnce(ok({ guide }));
    fetchOwnIssueMessages.mockResolvedValue(ok([]));
    const report = {
      id: "issue-1",
      meaning: "IN_PROGRESS" as const,
      typeId: "type-lift",
      typeName: "Hiss",
      location: null,
      description: "Hissen står still.",
      apartment: null,
      photos: [],
      enteredByHandler: false,
      replyMode: "MESSAGE" as const,
      mergedIntoMeaning: null,
      createdAt: "2026-08-20T08:00:00.000Z",
      updatedAt: "2026-08-20T08:00:00.000Z",
    };
    fetchOwnIssues.mockResolvedValueOnce(ok([report]));
    sendOwnIssueMessage.mockResolvedValue(refused(409, "issue-closed"));
    const session = userEvent.setup();
    render(<IssuesScreen viewer={READER} />);

    expect(
      await screen.findByText("Vem ansvarar för vad?", { selector: "summary" }),
    ).toBeTruthy();
    expect(screen.getByText("Golvbrunn")).toBeTruthy();

    // The re-read that a closed answer asks for.
    fetchGuide.mockResolvedValue(guideAfter);
    fetchOwnIssues.mockResolvedValue(
      ok([{ ...report, meaning: "DONE", replyMode: "NEW_REPORT" }]),
    );
    await session.click(screen.getByText("Meddelanden om Hiss"));
    await session.type(
      await screen.findByLabelText("Hiss: ditt meddelande"),
      "Hallå",
    );
    await session.click(screen.getByRole("button", { name: "Skicka" }));
    await waitFor(() => {
      expect(screen.queryByLabelText("Hiss: ditt meddelande")).toBeNull();
    });
    expect(fetchGuide).toHaveBeenCalledTimes(2);
  }

  it("keeps the guide on show when it cannot be read again", async () => {
    await reopenWithAdoptedGuide(refused(500, "unknown"));

    expect(
      screen.getByText("Vem ansvarar för vad?", { selector: "summary" }),
    ).toBeTruthy();
    expect(screen.getByText("Golvbrunn")).toBeTruthy();
  });

  it("removes the guide when it is read again and has been withdrawn", async () => {
    await reopenWithAdoptedGuide(ok({ guide: null }));

    expect(
      screen.queryByText("Vem ansvarar för vad?", { selector: "summary" }),
    ).toBeNull();
    expect(screen.queryByText("Golvbrunn")).toBeNull();
  });

  it("hides the composer once the list is read again and shows the report closed", async () => {
    const report = {
      id: "issue-1",
      meaning: "IN_PROGRESS" as const,
      typeId: "type-lift",
      typeName: "Hiss",
      location: null,
      description: "Hissen står still.",
      apartment: null,
      photos: [],
      enteredByHandler: false,
      replyMode: "MESSAGE" as const,
      mergedIntoMeaning: null,
      descriptionRedactedAt: null,
      locationRedactedAt: null,
      freeTextRemovedAt: null,
      createdAt: "2026-08-20T08:00:00.000Z",
      updatedAt: "2026-08-20T08:00:00.000Z",
    };
    fetchOwnIssues.mockResolvedValueOnce(ok([report]));
    fetchOwnIssueMessages.mockResolvedValue(ok([]));
    sendOwnIssueMessage.mockResolvedValue(refused(409, "issue-closed"));
    const session = userEvent.setup();
    render(<IssuesScreen viewer={READER} />);

    expect(await screen.findByText("Hissen står still.")).toBeTruthy();
    fetchOwnIssues.mockResolvedValue(
      ok([{ ...report, meaning: "DONE", replyMode: "NEW_REPORT" }]),
    );
    await session.click(screen.getByText("Meddelanden om Hiss"));
    await session.type(
      await screen.findByLabelText("Hiss: ditt meddelande"),
      "Hallå",
    );
    await session.click(screen.getByRole("button", { name: "Skicka" }));

    await waitFor(() => {
      expect(fetchOwnIssues).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.queryByLabelText("Hiss: ditt meddelande")).toBeNull();
    });
    expect(screen.getByText("Hissen står still.")).toBeTruthy();
  });
});

describe("known faults and a report that follows up another", () => {
  it("shows the known faults the house is told of before the form", async () => {
    fetchKnownFaults.mockResolvedValue(
      ok([
        {
          body: "Hissen i port 14 står still. Tekniker kommer torsdag.",
          signature: "PROPERTY_MANAGER",
          publishedAt: "2026-08-20T08:00:00.000Z",
          typeName: "Hiss",
        },
      ]),
    );
    render(<IssuesScreen viewer={READER} />);

    expect(
      await screen.findByText(
        "Hissen i port 14 står still. Tekniker kommer torsdag.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Kända fel")).toBeTruthy();
    expect(screen.getByText("Förvaltaren")).toBeTruthy();
  });

  it("stops showing a known fault when the faults cannot be read again", async () => {
    fetchKnownFaults.mockResolvedValueOnce(
      ok([
        {
          body: "Hissen i port 14 står still. Tekniker kommer torsdag.",
          signature: "PROPERTY_MANAGER",
          publishedAt: "2026-08-20T08:00:00.000Z",
          typeName: "Hiss",
        },
      ]),
    );
    const report = {
      id: "issue-1",
      meaning: "IN_PROGRESS" as const,
      typeId: "type-lift",
      typeName: "Hiss",
      location: null,
      description: "Hissen står still.",
      apartment: null,
      photos: [],
      enteredByHandler: false,
      replyMode: "MESSAGE" as const,
      mergedIntoMeaning: null,
      createdAt: "2026-08-20T08:00:00.000Z",
      updatedAt: "2026-08-20T08:00:00.000Z",
    };
    fetchOwnIssues.mockResolvedValueOnce(ok([report]));
    fetchOwnIssueMessages.mockResolvedValue(ok([]));
    sendOwnIssueMessage.mockResolvedValue(refused(409, "issue-closed"));
    const session = userEvent.setup();
    render(<IssuesScreen viewer={READER} />);

    expect(
      await screen.findByText(
        "Hissen i port 14 står still. Tekniker kommer torsdag.",
      ),
    ).toBeTruthy();
    // The re-read that a closed answer asks for fails on the known faults.
    fetchKnownFaults.mockResolvedValue(refused(500, "unknown"));
    fetchOwnIssues.mockResolvedValue(
      ok([{ ...report, meaning: "DONE", replyMode: "NEW_REPORT" }]),
    );
    await session.click(screen.getByText("Meddelanden om Hiss"));
    await session.type(
      await screen.findByLabelText("Hiss: ditt meddelande"),
      "Hallå",
    );
    await session.click(screen.getByRole("button", { name: "Skicka" }));

    await screen.findByText("Ärendena kunde inte läsas just nu.");
    expect(
      screen.queryByText(
        "Hissen i port 14 står still. Tekniker kommer torsdag.",
      ),
    ).toBeNull();
  });

  it("files a new report linked to a closed one, on its type", async () => {
    fetchOwnIssues.mockResolvedValue(
      ok([
        {
          id: "issue-old",
          meaning: "DONE",
          typeId: "type-lift",
          typeName: "Hiss",
          location: null,
          description: "Hissen stod still i våras.",
          apartment: null,
          photos: [],
          enteredByHandler: false,
          replyMode: "NEW_REPORT",
          mergedIntoMeaning: null,
          createdAt: "2026-03-20T08:00:00.000Z",
          updatedAt: "2026-04-20T08:00:00.000Z",
        },
      ]),
    );
    fetchOwnIssueMessages.mockResolvedValue(ok([]));
    const session = userEvent.setup();
    render(<IssuesScreen viewer={READER} />);

    await session.click(await screen.findByText("Meddelanden om Hiss"));
    await session.click(
      await screen.findByRole("button", { name: "Gör en ny anmälan om detta" }),
    );
    expect(
      await screen.findByText(
        "Den här anmälan följer upp din tidigare anmälan om Hiss.",
      ),
    ).toBeTruthy();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    expect(
      (screen.getByLabelText("Vad gäller det") as HTMLSelectElement).value,
    ).toBe("type-lift");

    await session.type(
      screen.getByLabelText("Vad har hänt"),
      "Hissen står still igen.",
    );
    await session.click(screen.getByRole("button", { name: "Skicka anmälan" }));

    await waitFor(() => {
      expect(reportIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          typeId: "type-lift",
          followsIssueId: "issue-old",
        }),
      );
    });
  });

  it("files a follow-up chosen while the form is open from a post, and starts from the text it was refused", async () => {
    fetchPost.mockResolvedValue(ok(LIFT));
    const report = {
      id: "issue-old",
      meaning: "IN_PROGRESS" as const,
      typeId: "type-lift",
      typeName: "Hiss",
      location: null,
      description: "Hissen stod still i våras.",
      apartment: null,
      photos: [],
      enteredByHandler: false,
      replyMode: "MESSAGE" as const,
      mergedIntoMeaning: null,
      createdAt: "2026-03-20T08:00:00.000Z",
      updatedAt: "2026-04-20T08:00:00.000Z",
    };
    fetchOwnIssues.mockResolvedValueOnce(ok([report]));
    fetchOwnIssueMessages.mockResolvedValue(ok([]));
    sendOwnIssueMessage.mockResolvedValue(refused(409, "issue-closed"));
    const session = userEvent.setup();
    render(<IssuesScreen viewer={READER} fromPostId="post-1" />);

    expect(
      await screen.findByDisplayValue("Hissen i port 14 står still igen."),
    ).toBeTruthy();
    // The re-read that the closed answer asks for: the window has passed.
    fetchOwnIssues.mockResolvedValue(
      ok([{ ...report, meaning: "DONE", replyMode: "NEW_REPORT" }]),
    );
    await session.click(screen.getByText("Meddelanden om Hiss"));
    await session.type(
      await screen.findByLabelText("Hiss: ditt meddelande"),
      "Det står still igen sedan i morse.",
    );
    await session.click(screen.getByRole("button", { name: "Skicka" }));
    await session.click(
      await screen.findByRole("button", { name: "Gör en ny anmälan om detta" }),
    );
    expect(
      await screen.findByText(
        "Den här anmälan följer upp din tidigare anmälan om Hiss.",
      ),
    ).toBeTruthy();
    // The reporter's own refused reply, not the post's text.
    expect(
      (screen.getByLabelText("Vad har hänt") as HTMLTextAreaElement).value,
    ).toBe("Det står still igen sedan i morse.");
    await session.click(screen.getByRole("button", { name: "Skicka anmälan" }));

    await waitFor(() => {
      expect(reportIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          followsIssueId: "issue-old",
          description: "Det står still igen sedan i morse.",
        }),
      );
    });
    // The post may already name the report followed up, which the server
    // refuses to name a second one: a follow-up carries no post.
    expect(reportIssue.mock.calls.at(-1)?.[0]).not.toHaveProperty("postId");
  });

  it("keeps the notice and the failed-photograph warning after a follow-up is filed", async () => {
    fetchOwnIssues.mockResolvedValue(
      ok([
        {
          id: "issue-old",
          meaning: "DONE",
          typeId: "type-lift",
          typeName: "Hiss",
          location: null,
          description: "Hissen stod still i våras.",
          apartment: null,
          photos: [],
          enteredByHandler: false,
          replyMode: "NEW_REPORT",
          mergedIntoMeaning: null,
          createdAt: "2026-03-20T08:00:00.000Z",
          updatedAt: "2026-04-20T08:00:00.000Z",
        },
      ]),
    );
    fetchOwnIssueMessages.mockResolvedValue(ok([]));
    attachIssuePhoto.mockResolvedValue({
      ok: false,
      failure: { status: 413, reason: "too-large" },
    });
    const session = userEvent.setup();
    render(<IssuesScreen viewer={READER} />);

    await session.click(await screen.findByText("Meddelanden om Hiss"));
    await session.click(
      await screen.findByRole("button", { name: "Gör en ny anmälan om detta" }),
    );
    await session.type(
      screen.getByLabelText("Vad har hänt"),
      "Hissen står still igen.",
    );
    await session.upload(
      screen.getByLabelText(/lägg till foto/i),
      new File(["bytes"], "hiss.png", { type: "image/png" }),
    );
    await session.click(screen.getByRole("button", { name: "Skicka anmälan" }));

    // The form is not mounted again by the follow-up being cleared, so both
    // notices outlive the screen reading its lists again.
    expect(await screen.findByText(/ligger nu i kön/i)).toBeTruthy();
    expect(await screen.findByText(/kunde inte läggas till/i)).toBeTruthy();
    await waitFor(() => {
      expect(fetchOwnIssues.mock.calls.length).toBeGreaterThan(1);
    });
    expect(screen.getByText(/ligger nu i kön/i)).toBeTruthy();
    expect(screen.getByText(/kunde inte läggas till/i)).toBeTruthy();
    expect(
      screen.queryByText(
        "Den här anmälan följer upp din tidigare anmälan om Hiss.",
      ),
    ).toBeNull();
  });
});
