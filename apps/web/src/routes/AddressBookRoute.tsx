import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
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
import { AppShell, type NavItem } from "../shell/AppShell";
import { ThemeModeToggle } from "../theme/ThemeModeToggle";

const NAV_ITEMS: readonly NavItem[] = [
  { to: "/", labelKey: "nav.addressBook" },
];

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
  const openPerson = useCallback((personId: string) => {
    setPanel({ kind: "person", personId });
  }, []);
  const openApartment = useCallback((apartmentId: string) => {
    setPanel({ kind: "apartment", apartmentId });
  }, []);

  const panelOpen = panel.kind !== "none";
  const stats =
    view.state === "board" || view.state === "resident"
      ? view.page.stats
      : null;

  return (
    <AppShell
      housingCooperativeName={t("app.housingCooperative")}
      personName={session?.user.name}
      navItems={NAV_ITEMS}
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
                  setPanel({ kind: "addPerson" });
                }}
                className="inline-flex min-h-11 items-center rounded-control bg-ink px-4 text-label text-page uppercase"
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
              className="min-h-11 rounded-control border border-line-strong px-4 text-label text-ink uppercase"
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
