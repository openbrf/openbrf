import {
  type FormEvent,
  type ReactElement,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

/**
 * The reference plugin's view for the residents: the days the person reading
 * it is away, which they note, read and withdraw.
 *
 * Exposed as `./Away` and offered in the building's section to an account
 * that holds a residency today. Its routes are the plugin's resident route
 * `away` (ADR 0051), so a resident without a board seat reaches them; the
 * occupancy screen is the board's view, `./View`, with routes of its own.
 *
 * Nothing here shows anybody but the reader: the routes answer only with the
 * caller's own days, and the lead says so before the reader notes any.
 *
 * The classes are ones the application uses itself, because its stylesheet is
 * built from its own source and a utility it does not use is not there.
 */

/** What the `away` routes answer with. Mirrors src/server.ts. */
interface Days {
  from: string;
  to: string;
}

type ViewState =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "refused"; messageKey: string }
  | { status: "ready"; away: Days | null };

const AWAY_URL = "/api/plugin/occupancy/away";

/** The keys of refusals that say the whole view is not for this person. */
const VIEW_REFUSALS = new Set([
  "away.refused.notListed",
  "away.refused.unsupported",
]);

const LABEL = "flex flex-col gap-1.5 text-label uppercase text-ink-muted";
const FIELD =
  "min-h-11 w-full rounded-control border border-line-strong bg-raised px-3 py-px text-body text-ink font-data";
const PRIMARY_BUTTON =
  "inline-flex min-h-11 items-center justify-center rounded-control bg-ink px-4 text-small font-semibold text-page transition-colors duration-150 ease-out disabled:opacity-60";
const SECONDARY_BUTTON =
  "inline-flex min-h-11 items-center justify-center rounded-control border border-line-strong bg-raised px-4 text-small font-semibold text-ink transition-colors duration-150 ease-out disabled:opacity-60";

/**
 * The key of the sentence a refused answer is shown as, or null when the
 * answer is not a refusal this view knows.
 *
 * The host refuses a caller the address book does not list to the plugin
 * before the plugin's code runs, with the reason `resident-route-not-listed`
 * and no text of the plugin's, so the view reads the reason and says what the
 * plugin itself says to a person it does not find listed. Every other refusal
 * is the plugin's own and names its key. An instance from before resident
 * routes refuses a resident at the plugin's floor with another reason, which
 * is none of these.
 */
async function refusalKey(response: Response): Promise<string | null> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const { reason, messageKey } = body as {
    reason?: unknown;
    messageKey?: unknown;
  };
  if (reason === "resident-route-not-listed") {
    return "away.refused.notListed";
  }
  return typeof messageKey === "string" &&
    messageKey.startsWith("away.refused.")
    ? messageKey
    : null;
}

export default function AwayView(): ReactElement {
  const { t } = useTranslation("plugin-occupancy");
  const [state, setState] = useState<ViewState>({ status: "loading" });
  const [draft, setDraft] = useState<Days>({ from: "", to: "" });
  // A refusal of what was entered, or a failure of the last act.
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Held apart from `busy`, which a second click can read before it renders.
  const inFlight = useRef(false);
  // An act's answer that arrives after the view has gone sets nothing.
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();

    const load = async (): Promise<void> => {
      try {
        // Same origin, so the host's session cookie travels with the request
        // and the plugin never handles a credential of its own.
        const response = await fetch(AWAY_URL, {
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (!response.ok) {
          const key = await refusalKey(response);
          if (!controller.signal.aborted) {
            setState(
              key === null
                ? { status: "failed" }
                : { status: "refused", messageKey: key },
            );
          }
          return;
        }
        const data = (await response.json()) as {
          listed: boolean;
          away: Days | null;
        };
        if (controller.signal.aborted) {
          return;
        }
        setState(
          data.listed
            ? { status: "ready", away: data.away }
            : { status: "refused", messageKey: "away.refused.notListed" },
        );
      } catch {
        if (!controller.signal.aborted) {
          setState({ status: "failed" });
        }
      }
    };

    void load();
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, []);

  /**
   * One act at a time: the form is disabled while one is out, so the draft it
   * sent cannot change under it and a second act cannot overtake the first.
   */
  const act = async (
    init: RequestInit,
    done: (response: Response) => Promise<Days | null>,
  ): Promise<void> => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(AWAY_URL, {
        credentials: "same-origin",
        ...init,
      });
      if (response.ok) {
        const away = await done(response);
        if (mounted.current) {
          setState({ status: "ready", away });
        }
        return;
      }
      const key = await refusalKey(response);
      if (!mounted.current) {
        return;
      }
      if (key !== null && VIEW_REFUSALS.has(key)) {
        setState({ status: "refused", messageKey: key });
      } else {
        setNotice(key ?? "away.failed");
      }
    } catch {
      // Whether the act went through is not known, so the days shown stay
      // what was last read and the reader is asked to try again.
      if (mounted.current) {
        setNotice("away.failed");
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        setBusy(false);
      }
    }
  };

  const note = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void act(
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      },
      async (response) => {
        const written = (await response.json()) as Days;
        return { from: written.from, to: written.to };
      },
    );
  };

  const withdraw = (): void => {
    void act({ method: "DELETE" }, async () => null);
  };

  const edit = (field: keyof Days, value: string): void => {
    setDraft((current) => ({ ...current, [field]: value }));
    // A refusal is about what was entered, so it goes when that changes.
    setNotice(null);
  };

  return (
    <section className="flex flex-col gap-4 rounded-panel border border-line bg-raised p-5 text-ink shadow-raised">
      {state.status === "loading" ? (
        <p className="text-small text-ink-muted">{t("away.loading")}</p>
      ) : null}

      {state.status === "failed" ? (
        <p role="alert" className="text-small text-danger">
          {t("away.error")}
        </p>
      ) : null}

      {state.status === "refused" ? (
        <p role="status" className="text-body text-ink">
          {t(state.messageKey)}
        </p>
      ) : null}

      {state.status === "ready" ? (
        <>
          <p className="text-body text-ink">{t("away.lead")}</p>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <p
              role="status"
              className={
                state.away === null
                  ? "text-body text-ink"
                  : "font-data text-body text-ink"
              }
            >
              {state.away === null
                ? t("away.none")
                : t("away.current", {
                    from: state.away.from,
                    to: state.away.to,
                  })}
            </p>
            {state.away === null ? null : (
              <button
                type="button"
                className={SECONDARY_BUTTON}
                disabled={busy}
                onClick={withdraw}
              >
                {t("away.withdraw")}
              </button>
            )}
          </div>

          <form
            className="flex flex-col gap-4 border-t border-line pt-4"
            onSubmit={note}
          >
            <fieldset className="flex flex-wrap gap-4" disabled={busy}>
              <label className={LABEL}>
                {t("records.away.from")}
                <input
                  type="date"
                  required
                  className={FIELD}
                  value={draft.from}
                  onChange={(event) => {
                    edit("from", event.target.value);
                  }}
                />
              </label>
              <label className={LABEL}>
                {t("records.away.to")}
                <input
                  type="date"
                  required
                  className={FIELD}
                  value={draft.to}
                  onChange={(event) => {
                    edit("to", event.target.value);
                  }}
                />
              </label>
            </fieldset>

            {notice === null ? null : (
              <p role="alert" className="text-small text-danger">
                {t(notice)}
              </p>
            )}

            <div>
              <button type="submit" className={PRIMARY_BUTTON} disabled={busy}>
                {t("away.save")}
              </button>
            </div>
          </form>
        </>
      ) : null}
    </section>
  );
}
