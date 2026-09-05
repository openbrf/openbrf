import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useMeetingPeople } from "./use-meeting-people";

/**
 * Reading the address book so the meetings screens can write a name beside an
 * identifier.
 *
 * That the whole book is read rather than a page of it, and that the server's
 * own total decides when to stop. A page can be short of the size asked for
 * while more remain - the endpoint draws its rows from residencies and from
 * persons without one, and takes what is left of a page from the second source -
 * so stopping at a short page would silently lose everybody after it.
 *
 * That the book is read whole rather than filtered to members. Who may be
 * checked in is a question about the member register on the meeting day and the
 * server answers it; a screen that offered only the people it had decided were
 * members today would hide somebody the server would have accepted.
 *
 * That a person appearing twice is one person. Somebody holding two
 * tenant-ownerships has two rows in the register and one vote at the meeting.
 *
 * That a failure is an answer rather than a hang. The meetings screens stay
 * usable with identifiers, so the hook has to settle either way.
 */

const fetchBoardRegister = vi.fn();

vi.mock("../register/register-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../register/register-api")>()),
  fetchBoardRegister: (query: unknown, signal: unknown) =>
    fetchBoardRegister(query, signal),
}));

function row(
  personId: string,
  name: string,
  apartmentNumber: string | null,
  protectedPersonalData = false,
) {
  return {
    key: `${personId}-${apartmentNumber ?? "none"}`,
    personId,
    name,
    apartment:
      apartmentNumber === null
        ? null
        : {
            id: `apartment-${apartmentNumber}`,
            addressId: "address-1",
            number: apartmentNumber,
            floor: 1,
          },
    signs: [],
    movedInOn: "2020-01-01",
    movedOutOn: null,
    contact: { state: "visible" as const, email: null, phone: null },
    purgeOn: null,
    protectedPersonalData,
  };
}

function page(rows: ReturnType<typeof row>[], total: number, pageNumber = 1) {
  return {
    rows,
    addresses: [],
    counts: { all: total, members: 0, residents: 0, board: 0, movedOut: 0 },
    total,
    page: pageNumber,
    pageSize: 100,
    stats: { apartments: 0, persons: total, members: 0 },
    generatedOn: "2027-05-01",
  };
}

beforeEach(() => {
  fetchBoardRegister.mockReset();
});

describe("the people a meeting names", () => {
  it("asks for the whole book rather than a page a reader scrolls", async () => {
    fetchBoardRegister.mockResolvedValue(
      page([row("person-1", "Astrid Lindqvist", "1001")], 1),
    );

    const { result } = renderHook(() => useMeetingPeople());
    await waitFor(() => {
      expect(result.current.ready).toBe(true);
    });

    // `filter: "all"` puts no residency condition on the query at all, so the
    // answer covers people who have moved out and people the board entered
    // without moving in - both of whom can be the answer to "who is this
    // identifier" on a meeting held about a day in the past.
    expect(fetchBoardRegister).toHaveBeenCalledWith(
      { filter: "all", page: 1, pageSize: 100 },
      expect.anything(),
    );
    expect(result.current.find("person-1")?.name).toBe("Astrid Lindqvist");
  });

  it("keeps paging on a short page while the total says there is more", async () => {
    /*
     * The regression this exists for. The endpoint takes what is left of a page
     * from a second source, so a page shorter than the size asked for is not the
     * end of the book - and a reader that stopped there would lose everybody
     * after it, silently, on exactly the instances with the most people.
     */
    fetchBoardRegister
      .mockResolvedValueOnce(page([row("person-1", "Astrid", "1001")], 2, 1))
      .mockResolvedValueOnce(page([row("person-2", "Nils", "1002")], 2, 2))
      .mockResolvedValueOnce(page([], 2, 3));

    const { result } = renderHook(() => useMeetingPeople());
    await waitFor(() => {
      expect(result.current.ready).toBe(true);
    });

    expect(fetchBoardRegister).toHaveBeenCalledTimes(2);
    expect(result.current.find("person-2")?.name).toBe("Nils");
  });

  it("stops on an empty page even where the total disagrees", async () => {
    // Nothing else would end the loop if the count and the rows ever disagreed,
    // and a screen asking for a hundred pages is worse than a screen missing a
    // name.
    fetchBoardRegister
      .mockResolvedValueOnce(page([row("person-1", "Astrid", "1001")], 99, 1))
      .mockResolvedValueOnce(page([], 99, 2));

    const { result } = renderHook(() => useMeetingPeople());
    await waitFor(() => {
      expect(result.current.ready).toBe(true);
    });

    expect(fetchBoardRegister).toHaveBeenCalledTimes(2);
    expect(result.current.everyone).toHaveLength(1);
  });

  it("stops once the total has been covered", async () => {
    fetchBoardRegister.mockResolvedValue(
      page([row("person-1", "Astrid", "1001")], 1),
    );

    const { result } = renderHook(() => useMeetingPeople());
    await waitFor(() => {
      expect(result.current.ready).toBe(true);
    });

    expect(fetchBoardRegister).toHaveBeenCalledTimes(1);
  });

  it("merges the two rows of somebody holding two tenant-ownerships", async () => {
    fetchBoardRegister.mockResolvedValue(
      page(
        [
          row("person-1", "Astrid Lindqvist", "1002"),
          row("person-1", "Astrid Lindqvist", "1001"),
        ],
        2,
      ),
    );

    const { result } = renderHook(() => useMeetingPeople());
    await waitFor(() => {
      expect(result.current.ready).toBe(true);
    });

    // One person, one entry, both apartments - which is what the voting register
    // says too: EFL 6 kap. 3 § gives the vote to the member, so two holdings are
    // still one vote.
    expect(result.current.everyone).toHaveLength(1);
    expect(result.current.find("person-1")?.apartmentNumbers).toEqual([
      "1001",
      "1002",
    ]);
  });

  it("carries whether a person's personal data is protected", async () => {
    fetchBoardRegister.mockResolvedValue(
      page([row("person-1", "Astrid Lindqvist", "1001", true)], 1),
    );

    const { result } = renderHook(() => useMeetingPeople());
    await waitFor(() => {
      expect(result.current.ready).toBe(true);
    });

    // The board's own view of the register carries the name and the flag, and
    // this is the same data through the same capability. The flag is what lets a
    // chair reading the register out loud know not to.
    expect(result.current.find("person-1")?.protectedPersonalData).toBe(true);
  });

  it("answers nothing rather than hanging when the book cannot be read", async () => {
    fetchBoardRegister.mockRejectedValue(new Error("no"));

    const { result } = renderHook(() => useMeetingPeople());
    await waitFor(() => {
      expect(result.current.ready).toBe(true);
    });

    expect(result.current.failed).toBe(true);
    // Null is a real answer: the screens render an identifier rather than a
    // blank, and a meeting stays workable.
    expect(result.current.find("person-1")).toBeNull();
  });
});
