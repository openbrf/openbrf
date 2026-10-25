import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import type { Viewer } from "../api/instance";
import { MoveInPanel } from "../moves/MoveInPanel";
import { MoveOutPanel, type MoveOutTarget } from "../moves/MoveOutPanel";
import { AddPersonPanel } from "../register/AddPersonPanel";
import { ApartmentPanel } from "../register/ApartmentPanel";
import { Board } from "../register/Board";
import { DataSubjectReport } from "../register/DataSubjectReport";
import { PersonPanel } from "../register/PersonPanel";
import type { RegisterFilter } from "../register/register-api";
import {
  useAddressBook,
  useDebouncedValue,
} from "../register/use-address-book";
import { isOffered } from "../shell/nav-items";
import { isReadOnly } from "../support/read-only";
import { ThemeModeToggle } from "../theme/ThemeModeToggle";
import {
  BoardPageNote,
  BoardPageRefused,
  BoardPageTitle,
} from "../ui/BoardPage";
import { SECONDARY_BUTTON } from "../ui/controls";
import { SignedInFrame } from "./SignedInFrame";

/** Which panel, if any, sits beside the board. */
type OpenPanel =
  | { kind: "none" }
  | { kind: "person"; personId: string }
  | { kind: "apartment"; apartmentId: string }
  | { kind: "addPerson" }
  | { kind: "moveIn" }
  | { kind: "moveOut"; target: MoveOutTarget }
  /**
   * The data subject access report. Not a panel beside the board but a
   * document instead of it: it decrypts everything about one person, and a
   * register left on the same page would put somebody else's data on the
   * paper it is printed onto.
   */
  | { kind: "dataSubjectReport"; personId: string };

/**
 * The address book, the board's page, inside the application frame.
 *
 * Mounted only for an account offered the page, which is addressBook:read; any
 * other account reads the sentence every refused board page says, and its
 * browser asks for no part of the register. The resident directory this
 * address once answered a resident with has no house page (ADR 0049), so there
 * is no second view to fall back to. Courtesy only, as everywhere: the API
 * refuses the board's view to whoever may not read it.
 */
export function AddressBookRoute(): ReactElement {
  return (
    <SignedInFrame>
      {(viewer) =>
        isOffered(viewer.capabilities, "/board/address-book") ? (
          <AddressBook viewer={viewer} />
        ) : (
          <BoardPageRefused />
        )
      }
    </SignedInFrame>
  );
}

/**
 * The register with contact details, as the board works it.
 *
 * The register stamp names the address book, not the member register. The two are
 * different documents: this view carries members and non-member residents
 * together, while the member register (medlemsforteckning, EFL 5 kap.) carries
 * members only and is public on request. Stamping this screen as an extract from
 * that register would misdescribe it, so the statutory extracts keep their own
 * views and their own stamp.
 */
function AddressBook({ viewer }: { viewer: Viewer }): ReactElement {
  const { t } = useTranslation();

  const [addressId, setAddressId] = useState<string | undefined>(undefined);
  const [filter, setFilter] = useState<RegisterFilter>("all");
  const [searchInput, setSearchInput] = useState("");
  const [page, setPage] = useState(1);
  const [panel, setPanel] = useState<OpenPanel>({ kind: "none" });

  const search = useDebouncedValue(searchInput);
  const query = useMemo(
    () => ({ addressId, filter, search, page }),
    [addressId, filter, search, page],
  );
  const { view, refreshing, reload } = useAddressBook(query);

  /*
   * Focus management for the panels. Each panel moves focus to its own heading
   * on mount; returning it is this route's job, because only the route knows
   * what opened the panel. It matters below `xl`, where an open panel hides the
   * board: the button the user activated stops being focusable in the same
   * commit, so focus would otherwise drop to the document body both on open and
   * on close, and a keyboard user would have to traverse the whole shell twice.
   */
  const opener = useRef<HTMLElement | null>(null);
  const rememberOpener = useCallback(() => {
    // Only the first opener in a chain: a person opened from the apartment
    // panel should still hand focus back to the button that started it.
    if (opener.current !== null) {
      return;
    }
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement ? active : null;
  }, []);

  /** Any change to what is being asked for starts again at the first page. */
  const changeFilter = useCallback((next: RegisterFilter) => {
    setFilter(next);
    setPage(1);
  }, []);
  const changeAddress = useCallback((next: string | undefined) => {
    setAddressId(next);
    setPage(1);
  }, []);
  const changeSearch = useCallback((next: string) => {
    setSearchInput(next);
    setPage(1);
  }, []);
  const closePanel = useCallback(() => {
    setPanel({ kind: "none" });
  }, []);
  const openPerson = useCallback(
    (personId: string) => {
      rememberOpener();
      setPanel({ kind: "person", personId });
    },
    [rememberOpener],
  );
  const openApartment = useCallback(
    (apartmentId: string) => {
      rememberOpener();
      setPanel({ kind: "apartment", apartmentId });
    },
    [rememberOpener],
  );
  const openReport = useCallback((personId: string) => {
    setPanel({ kind: "dataSubjectReport", personId });
  }, []);
  /**
   * Back to the person the report was about, rather than to the bare board.
   * The report was opened from their panel, and closing a document returns to
   * where it was produced from.
   */
  const closeReport = useCallback((personId: string) => {
    setPanel({ kind: "person", personId });
  }, []);

  const panelOpen = panel.kind !== "none";

  // After the commit that unmounts the panel and unhides the board, so the
  // opener is focusable again by the time it is asked to take focus.
  useEffect(() => {
    if (panelOpen) {
      return;
    }
    const previous = opener.current;
    opener.current = null;
    previous?.focus();
  }, [panelOpen]);

  const stats = view.state === "board" ? view.page.stats : null;

  /*
   * What this account may do, for the person panel's role controls. Read-only
   * for a support session (ADR 0028): the board's view without its acts -
   * adding a person, a move, the import, and everything the person panel
   * records.
   */
  const { capabilities } = viewer;
  const readOnly = isReadOnly(viewer);

  /*
   * A seat that ended while the page was open: the server refuses the board's
   * view, and the page says what any refused board page says.
   */
  if (view.state === "refused") {
    return <BoardPageRefused />;
  }

  return (
    <>
      {/*
       * The report replaces the whole screen while it is open, rather than
       * being one more panel beside the board. It is a document that gets
       * printed: the frame drops itself on paper, and the board would not.
       */}
      {panel.kind === "dataSubjectReport" ? (
        <DataSubjectReport
          key={panel.personId}
          personId={panel.personId}
          onClose={() => {
            closeReport(panel.personId);
          }}
        />
      ) : (
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="flex flex-col gap-2">
              {/*
               * The board's page, signed as one once the board's view has
               * answered, and not while the answer is on its way or has
               * failed: a sign over a register that never came would say the
               * page held something of the board's when it holds nothing.
               */}
              {view.state === "board" ? (
                <>
                  <BoardPageTitle>{t("register.heading")}</BoardPageTitle>
                  <BoardPageNote />
                </>
              ) : (
                <h1 className="text-display">{t("register.heading")}</h1>
              )}
              {stats === null ? null : (
                /*
                 * The header stats line: uppercase labels with their numbers in the
                 * mono grid, so the figures line up with the register below rather
                 * than reading as prose. Label-then-value also keeps the line free
                 * of grammatical number, which a sentence would need in both
                 * languages.
                 */
                <dl className="flex flex-wrap gap-x-6 gap-y-1">
                  <StatPair
                    label={t("register.stats.apartments")}
                    value={stats.apartments}
                  />
                  <StatPair
                    label={t("register.stats.persons")}
                    value={stats.persons}
                  />
                  <StatPair
                    label={t("register.stats.members")}
                    value={stats.members}
                  />
                </dl>
              )}
            </div>

            {/*
             * The statutory registers are reached from here rather than from the
             * navigation band: they are documents produced out of the address
             * book, and each has its own screen because the two may never be
             * blended. Offered once the board's view has answered, as the sign
             * is; the API decides what each of them receives.
             */}
            <div className="flex flex-wrap items-center gap-3">
              {view.state === "board" ? (
                <>
                  {readOnly ? null : (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          rememberOpener();
                          setPanel({ kind: "addPerson" });
                        }}
                        className="inline-flex min-h-11 items-center rounded-control bg-ink px-4 text-small font-semibold text-page transition-colors duration-150 ease-out"
                      >
                        {t("register.actions.addPerson")}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          rememberOpener();
                          setPanel({ kind: "moveIn" });
                        }}
                        className={SECONDARY_BUTTON}
                      >
                        {t("moves.in.heading")}
                      </button>
                      <Link to="/board/import" className={SECONDARY_BUTTON}>
                        {t("import.open")}
                      </Link>
                    </>
                  )}
                  <Link
                    to="/board/registers/members"
                    className={SECONDARY_BUTTON}
                  >
                    {t("registers.nav.memberRegister")}
                  </Link>
                  <Link
                    to="/board/registers/apartments"
                    className={SECONDARY_BUTTON}
                  >
                    {t("registers.nav.apartmentRegister")}
                  </Link>
                  <Link
                    to="/board/registers/reports"
                    className={SECONDARY_BUTTON}
                  >
                    {t("registers.nav.reportQueue")}
                  </Link>
                </>
              ) : null}
              <ThemeModeToggle />
            </div>
          </div>

          {view.state === "loading" ? (
            <p className="text-body text-ink-muted" aria-live="polite">
              {t("register.loading")}
            </p>
          ) : null}

          {view.state === "failed" ? (
            <div className="flex flex-col items-start gap-3 rounded-panel border border-line bg-raised p-5">
              <p className="text-title text-danger">
                {t("register.error.title")}
              </p>
              <button
                type="button"
                onClick={reload}
                className="min-h-11 rounded-control border border-line-strong px-4 text-small font-semibold text-ink"
              >
                {t("register.error.retry")}
              </button>
            </div>
          ) : null}

          <div
            className={
              panelOpen
                ? "grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]"
                : "grid gap-5"
            }
          >
            {/*
             * On a phone an open panel replaces the board rather than sitting
             * below it, where a reader would never find it.
             */}
            <div className={panelOpen ? "hidden xl:block" : "block"}>
              {view.state === "board" ? (
                <Board
                  page={view.page}
                  filter={filter}
                  onFilterChange={changeFilter}
                  addressId={addressId}
                  onAddressChange={changeAddress}
                  onPageChange={setPage}
                  search={searchInput}
                  onSearchChange={changeSearch}
                  stampKey="register.stamp.addressBook"
                  contactOf={(row) => row.contact}
                  purgeOf={(row) => row.purgeOn}
                  onOpenPerson={(row) => {
                    openPerson(row.personId);
                  }}
                  onOpenApartment={openApartment}
                  loading={refreshing}
                />
              ) : null}
            </div>

            {panel.kind === "person" ? (
              <PersonPanel
                key={panel.personId}
                personId={panel.personId}
                capabilities={capabilities}
                readOnly={readOnly}
                onClose={closePanel}
                onChanged={reload}
                onMoveOut={(target) => {
                  setPanel({ kind: "moveOut", target });
                }}
                onOpenReport={openReport}
              />
            ) : null}

            {panel.kind === "moveIn" && !readOnly ? (
              <MoveInPanel onClose={closePanel} onMoved={reload} />
            ) : null}

            {panel.kind === "moveOut" && !readOnly ? (
              <MoveOutPanel
                key={panel.target.residencyId}
                target={panel.target}
                onClose={closePanel}
                onMoved={reload}
              />
            ) : null}

            {panel.kind === "apartment" ? (
              <ApartmentPanel
                key={panel.apartmentId}
                apartmentId={panel.apartmentId}
                onClose={closePanel}
                onOpenPerson={openPerson}
              />
            ) : null}

            {panel.kind === "addPerson" && !readOnly ? (
              <AddPersonPanel
                onClose={closePanel}
                onAdded={(personId) => {
                  reload();
                  openPerson(personId);
                }}
              />
            ) : null}
          </div>
        </div>
      )}
    </>
  );
}

function StatPair({
  label,
  value,
}: {
  label: string;
  value: number;
}): ReactElement {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="text-label text-ink-muted uppercase">{label}</dt>
      <dd className="font-data text-data text-ink">{value}</dd>
    </div>
  );
}
