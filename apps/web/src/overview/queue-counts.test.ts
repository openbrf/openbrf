import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { CHAT_REPORTS_PER_PAGE, QUEUE_COUNTS } from "./queue-counts";

/**
 * How each queue's count is read, at the request: which path it asks for and
 * what it makes of the answer.
 *
 * The path matters as much as the count. A queue read without its state filter
 * would still count correctly once filtered here, and would carry every issue
 * the association ever had to a page that shows one number.
 */

const apiRequest = vi.fn();

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  apiRequest: (method: string, path: string) => apiRequest(method, path),
}));

const ok = (value: unknown) => ({ ok: true, value });

beforeEach(() => {
  apiRequest.mockReset();
});

describe("the queue counts", () => {
  it("counts the new issues, asking for those alone", async () => {
    apiRequest.mockResolvedValue(ok([{ id: "a" }, { id: "b" }]));

    expect(await QUEUE_COUNTS.issues()).toEqual(ok({ count: 2, more: false }));
    expect(apiRequest).toHaveBeenCalledWith(
      "GET",
      "/api/issue-queue?status=NEW",
    );
  });

  it("counts the submitted motions, and says when there is a page beyond", async () => {
    apiRequest.mockResolvedValue(
      ok({ deadline: null, motions: [{ id: "a" }], nextCursor: "cursor" }),
    );

    expect(await QUEUE_COUNTS.motions()).toEqual(ok({ count: 1, more: true }));
    expect(apiRequest).toHaveBeenCalledWith(
      "GET",
      "/api/motion-queue?status=SUBMITTED",
    );
  });

  it("counts the submitted sublet applications and key orders", async () => {
    apiRequest.mockResolvedValueOnce(ok({ applications: [{ id: "a" }] }));
    expect(await QUEUE_COUNTS.sublets()).toEqual(ok({ count: 1, more: false }));
    expect(apiRequest).toHaveBeenLastCalledWith(
      "GET",
      "/api/sublet-queue?status=SUBMITTED",
    );

    apiRequest.mockResolvedValueOnce(ok({ orders: [] }));
    expect(await QUEUE_COUNTS.keyOrders()).toEqual(
      ok({ count: 0, more: false }),
    );
    expect(apiRequest).toHaveBeenLastCalledWith(
      "GET",
      "/api/key-order-queue?status=SUBMITTED",
    );
  });

  it("counts every open update request, not only the page of them", async () => {
    apiRequest.mockResolvedValue(
      ok({ open: [{ id: "a" }], answered: [{ id: "b" }], openTotal: 201 }),
    );
    expect(await QUEUE_COUNTS.brokerUpdateRequests()).toEqual(
      ok({ count: 201, more: false }),
    );
    expect(apiRequest).toHaveBeenCalledWith(
      "GET",
      "/api/broker-update-requests",
    );
  });

  it("counts the pending account requests", async () => {
    apiRequest.mockResolvedValue(ok([{ id: "a" }, { id: "b" }, { id: "c" }]));
    expect(await QUEUE_COUNTS.accountRequests()).toEqual(
      ok({ count: 3, more: false }),
    );
    expect(apiRequest).toHaveBeenCalledWith("GET", "/api/signup-requests");
  });

  describe("the board mailbox", () => {
    const thread = (status: string) => ({ id: status, status });

    it("counts the new and taken threads at the head of the inbox", async () => {
      apiRequest.mockResolvedValue(
        ok({
          threads: [
            thread("NEW"),
            thread("NEW"),
            thread("TAKEN"),
            thread("ANSWERED"),
          ],
          more: true,
          nextCursor: "cursor",
        }),
      );

      // An answered thread on the page means every unanswered one is on it.
      expect(await QUEUE_COUNTS.boardMailbox()).toEqual(
        ok({ count: 3, more: false }),
      );
      expect(apiRequest).toHaveBeenCalledWith(
        "GET",
        "/api/board-mailbox/threads",
      );
    });

    it("says at least when the whole page is unanswered and the inbox goes on", async () => {
      apiRequest.mockResolvedValue(
        ok({
          threads: [thread("NEW"), thread("TAKEN")],
          more: true,
          nextCursor: "cursor",
        }),
      );
      expect(await QUEUE_COUNTS.boardMailbox()).toEqual(
        ok({ count: 2, more: true }),
      );
    });
  });

  describe("the reported messages", () => {
    it("counts the open reports", async () => {
      apiRequest.mockResolvedValue(
        ok({ reports: [{ reportId: "a" }], mayModerate: true }),
      );
      expect(await QUEUE_COUNTS.chatReports()).toEqual(
        ok({ count: 1, more: false }),
      );
    });

    it("says at least on a full page, which is all the queue tells", async () => {
      apiRequest.mockResolvedValue(
        ok({
          reports: Array.from(
            { length: CHAT_REPORTS_PER_PAGE },
            (_, index) => ({
              reportId: String(index),
            }),
          ),
          mayModerate: true,
        }),
      );
      expect(await QUEUE_COUNTS.chatReports()).toEqual(
        ok({ count: CHAT_REPORTS_PER_PAGE, more: true }),
      );
    });

    it("answers that the queue is not this account's without a board seat", async () => {
      apiRequest.mockResolvedValue(ok({ reports: [], mayModerate: false }));
      expect(await QUEUE_COUNTS.chatReports()).toEqual(ok(null));
    });
  });

  it("passes a failed read on as a failure", async () => {
    const failure = { status: 500, reason: "unexpected" };
    apiRequest.mockResolvedValue({ ok: false, failure });
    expect(await QUEUE_COUNTS.issues()).toEqual({ ok: false, failure });
  });
});
