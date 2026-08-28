import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import { authClient, useSession } from "../auth/auth-client";
import { AddPersonPanel } from "../register/AddPersonPanel";
import { ApartmentPanel } from "../register/ApartmentPanel";
import { Board } from "../register/Board";
import { PersonPanel } from "../register/PersonPanel";
import type { RegisterFilter } from "../register/register-api";
import {
  useAddressBook,
  useDebouncedValue,
} from "../register/use-address-book";
import { AppShell } from "../shell/AppShell";
import { navItemsFor } from "../shell/nav-items";
import { useHousingCooperativeLogo } from "../shell/use-housing-cooperative-logo";
import { ThemeModeToggle } from "../theme/ThemeModeToggle";

/** Which panel, if any, sits beside the board. */
type OpenPanel =
  | { kind: "none" }
  | { kind: "person"; personId: string }
  | { kind: "apartment"; apartmentId: string }
  | { kind: "addPerson" };

/**
 * The address book.
 *
 * Which of the two views this renders is the server's decision, not this
 * component's: the hook asks for the board's view and takes a refusal as the
 * answer that the viewer is a resident. The two branches differ in more than
 * styling - the resident branch passes no contact accessor and no row actions, so
 * a resident's board cannot show contact data or open a person, and the types
 * make that structural rather than conditional.
 *
 * The register stamp names the address book, not the member register. The two are
 * different documents: this view carries members and non-member residents
 * together, while the member register (medlemsforteckning, EFL 5 kap.) carries
 * members only and is public on request. Stamping this screen as an extract from
 * that register would misdescribe it, so the statutory extracts keep their own
 * views and their own stamp.
 */
export function AddressBookRoute(): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: session } = useSession();

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

  const stats =
    view.state === "board" || view.state === "resident"
      ? view.page.stats
      : null;

  const logo = useHousingCooperativeLogo();

  return (
    <AppShell
      housingCooperativeName={t("app.housingCooperative")}
      logo={logo}
      personName={session?.user.name}
      /*
       * The board view is served only to a principal holding addressBook:read,
       * which in the capability model is granted together with
       * association:read - so the answer the server already gave to the
       * register request settles the navigation too, without a second call to
       * ask who this is.
       *
       * Undefined until that answer arrives, which navItemsFor reads as "the
       * viewer is not known yet" and answers with the full band. A defined
       * empty list means "a resident", so passing it while the request is
       * still out would drop the Plugins link and then put it back, which is
       * the band shuffling that navItemsFor exists to prevent.
       */
      navItems={navItemsFor(
        view.state === "board"
          ? ["association:read"]
          : view.state === "resident"
            ? []
            : undefined,
      )}
      onSignOut={() => {
        /*
         * Navigating is part of signing out: the session is only checked in this
         * route's beforeLoad, so revoking it does not unmount anything by
         * itself, and the register would stay on screen until something else
         * happened to trigger a load.
         */
        void authClient.signOut({
          fetchOptions: {
            onSuccess: () => {
              void navigate({ to: "/sign-in" });
            },
          },
        });
      }}
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-2">
            <h1 className="text-display">{t("register.heading")}</h1>
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

          <div className="flex flex-wrap items-center gap-3">
            {view.state === "board" ? (
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
                onOpenPerson={openPerson}
                onOpenApartment={openApartment}
                loading={refreshing}
              />
            ) : null}

            {view.state === "resident" ? (
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
                loading={refreshing}
              />
            ) : null}
          </div>

          {panel.kind === "person" ? (
            <PersonPanel
              key={panel.personId}
              personId={panel.personId}
              onClose={closePanel}
              onChanged={reload}
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

          {panel.kind === "addPerson" ? (
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
    </AppShell>
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
