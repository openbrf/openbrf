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

vi.mock("../api/feed", () => ({
  fetchPost: (input: unknown) => fetchPost(input),
}));

vi.mock("../api/issues", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/issues")>()),
  fetchReportableTypes: () =>
    Promise.resolve(
      ok([{ id: "type-lift", name: "Hiss", audience: "MEMBER" }]),
    ),
  fetchOwnApartments: () => Promise.resolve(ok([])),
  fetchOwnIssues: () => Promise.resolve(ok([])),
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

beforeEach(() => {
  vi.clearAllMocks();
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
});
