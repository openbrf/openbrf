import type { APIRequestContext } from "@playwright/test";

import * as api from "./api";
import type { holdPendingChange } from "./pending-changes";

/**
 * Holds a proposal to replace the agenda of the meeting held on a day, for
 * whoever the request is signed in as.
 *
 * The day picks the meeting, not its place in the list: an instance that is
 * already up may hold meetings from earlier captures, and the first of them is
 * not the one the board arranged. The list is ordered by day, then id, so two
 * meetings on one day resolve the same way every time. A day with no meeting is
 * an error and nothing is held, however many other meetings the list has.
 *
 * Written against the agenda the meeting has now, which is what the AI package
 * does: it reads the meeting, and the ids of the items it read travel with the
 * proposal so the write is refused if the agenda has moved by the time it is
 * confirmed.
 *
 * The write is handed in, so that this can be exercised without a database.
 */
export async function proposeAgenda(
  request: APIRequestContext,
  baseUrl: string,
  proposal: { readonly heldOn: string; readonly items: readonly string[] },
  hold: typeof holdPendingChange,
): Promise<void> {
  const meetings = await getJson<{ id: string; heldOn: string }[]>(
    request,
    `${baseUrl}/api/meetings`,
  );
  const first = meetings.find((meeting) => meeting.heldOn === proposal.heldOn);
  if (first === undefined) {
    throw new Error(
      `no meeting held on ${proposal.heldOn} to propose an agenda for`,
    );
  }
  const meeting = await getJson<{ agenda: { id: string }[] }>(
    request,
    `${baseUrl}/api/meetings/${first.id}`,
  );
  const viewer = await api.viewer(request, baseUrl);
  await hold({
    actionName: "meeting_set_agenda",
    input: {
      meetingId: first.id,
      expectedItemIds: meeting.agenda.map((item) => item.id),
      items: proposal.items.map((title) => ({ title })),
    },
    proposedByPersonId: viewer.personId,
  });
}

async function getJson<T>(request: APIRequestContext, url: string): Promise<T> {
  const response = await request.get(url);
  if (!response.ok()) {
    throw new Error(`GET ${url} answered ${String(response.status())}`);
  }
  return (await response.json()) as T;
}
