import { useCallback, useEffect, useState } from "react";

import {
  type BoardRow,
  fetchBoardRegister,
  type RegisterPage,
  type RegisterQuery,
  RegisterRequestError,
} from "./register-api";

/**
 * Loading the address book: the board's register, with contact details.
 *
 * The board's view only. The address book is the board's page (ADR 0049), and
 * the resident directory it once fell back to for a refused account has no
 * house page, so a refusal here is an answer of its own rather than a reason to
 * ask for the other view. The route mounts this only for an account offered
 * the page; a refusal after that - a seat that ended while the page was open -
 * says the page is not this account's, and the server stays the only
 * authority on who sees contact data.
 */

export type AddressBookView =
  | { state: "loading" }
  | { state: "failed" }
  | { state: "refused" }
  | { state: "board"; page: RegisterPage<BoardRow> };

export interface AddressBookState {
  view: AddressBookView;
  /** True while a new page is in flight, with the previous one still on screen. */
  refreshing: boolean;
  reload: () => void;
}

const LOADING: AddressBookView = { state: "loading" };

function isForbidden(error: unknown): boolean {
  return error instanceof RegisterRequestError && error.status === 403;
}

function isAborted(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function useAddressBook(query: RegisterQuery): AddressBookState {
  const [reloadToken, setReloadToken] = useState(0);
  /**
   * The last result, tagged with the request it answered.
   *
   * Stored together rather than as two pieces of state so "is a newer request in
   * flight" is derived during render by comparing keys, instead of being a flag
   * an effect has to set and clear - which is one more thing that can be left
   * true after a failure.
   */
  const [answer, setAnswer] = useState<{
    key: string;
    view: AddressBookView;
  } | null>(null);

  const { addressId, filter, search, page } = query;
  const key = [addressId ?? "", filter, search ?? "", page, reloadToken].join(
    "\u0000",
  );

  useEffect(() => {
    const controller = new AbortController();

    const load = async (): Promise<void> => {
      const request: RegisterQuery = { addressId, filter, search, page };

      try {
        const board = await fetchBoardRegister(request, controller.signal);
        setAnswer({ key, view: { state: "board", page: board } });
      } catch (error) {
        if (isAborted(error)) {
          return;
        }
        setAnswer({
          key,
          view: { state: isForbidden(error) ? "refused" : "failed" },
        });
      }
    };

    void load();

    return () => {
      controller.abort();
    };
  }, [addressId, filter, search, page, key]);

  const reload = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  return {
    // The previous page stays on screen while the next one loads, so changing a
    // filter does not blank the register.
    view: answer?.view ?? LOADING,
    refreshing: answer === null || answer.key !== key,
    reload,
  };
}

/**
 * Delays a value so an incremental search does not fire a request per keystroke.
 *
 * 250ms: long enough to collapse typing into one request, short enough that the
 * board does not feel like it is lagging behind the field.
 */
export function useDebouncedValue<T>(value: T, delayMs = 250): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(value);
    }, delayMs);
    return () => {
      clearTimeout(timer);
    };
  }, [value, delayMs]);

  return debounced;
}
