import { useTranslation } from "react-i18next";
import type { ReactElement, ReactNode } from "react";

import { ColourLegend } from "../theme/ColourLegend";
import type { TranslationKey } from "../i18n/translation-key";
import { type FloorGroup, groupByFloor, UNKNOWN_FLOOR } from "./floor-groups";
import { SignRow } from "./SignChip";
import {
  type DirectoryRow,
  REGISTER_FILTERS,
  type RegisterContact,
  type RegisterFilter,
  type RegisterPage,
} from "./register-api";

/**
 * The Board: the register as a Swedish stairwell name board.
 *
 * DESIGN.md's signature component. A dark panel on the register surface, house
 * tabs and an on-board filter strip, a raised header row, rows grouped by floor
 * the way a physical porttavla is, thin rails between them, names in the UI face
 * and every piece of register data in the mono grid so the columns align
 * character for character.
 *
 * The component is generic over its row so the resident-facing view can reuse it
 * without being able to show contact data: contact reaches the board through the
 * `contactOf` accessor, and a resident row type has no contact field for such an
 * accessor to read. The audience is therefore enforced by the caller's types,
 * not by a flag this component could get wrong.
 */

const FILTER_LABEL: Record<RegisterFilter, TranslationKey> = {
  all: "register.filter.all",
  members: "register.filter.members",
  residents: "register.filter.residents",
  board: "register.filter.board",
  movedOut: "register.filter.movedOut",
};

export interface BoardProps<TRow extends DirectoryRow> {
  page: RegisterPage<TRow>;
  filter: RegisterFilter;
  onFilterChange: (filter: RegisterFilter) => void;
  /** Undefined means every address, which is the default view. */
  addressId: string | undefined;
  onAddressChange: (addressId: string | undefined) => void;
  onPageChange: (page: number) => void;
  search: string;
  onSearchChange: (search: string) => void;
  /**
   * The register stamp's key. Passed in so the same board can carry the stamp of
   * whichever document it is showing: the address book here, and a statutory
   * extract in the register views, which are separate documents with their own
   * wording.
   */
  stampKey: TranslationKey;
  /**
   * Board audience only. Omitted for residents, whose rows carry no contact
   * data at all - the column is absent rather than empty.
   */
  contactOf?: (row: TRow) => RegisterContact;
  /** Board audience only: the derived service-tier erasure date. */
  purgeOf?: (row: TRow) => string | null;
  /** Board audience only: rows become openable when these are given. */
  onOpenPerson?: (personId: string) => void;
  onOpenApartment?: (apartmentId: string) => void;
  /** Dims the panel while a new page is in flight, without unmounting it. */
  loading: boolean;
}

/*
 * Rails between rows, per DESIGN.md: a 1px divider on the register border
 * token, with 9-12px vertical and 24px horizontal padding. These are layout
 * measurements for this one view, not theme tokens - a theme may recolour the
 * rail, never move the column.
 */
const CELL = "px-3 py-2.5 text-left align-middle first:pl-6 last:pr-6";
const HEAD_CELL = `${CELL} text-label uppercase text-register-ink-muted`;
/** Register data always sits in the mono grid so columns align. */
const DATA_CELL = `${CELL} font-data text-data whitespace-nowrap text-register-ink-muted`;
const DESKTOP_ONLY = "hidden sm:table-cell";
const PAGE_BUTTON =
  "min-h-11 rounded-control border border-register-line px-4 text-label uppercase text-register-ink-muted focus-visible:outline-trust-register enabled:hover:text-register-ink disabled:opacity-50";

/**
 * Marks a cell whose value the register does not hold.
 *
 * Hidden from assistive technology on purpose: a table cell that is empty
 * already reads as empty, and announcing "hyphen" in every such cell of a
 * register this size is noise rather than information.
 */
function NotRecorded(): ReactElement {
  return <span aria-hidden="true">-</span>;
}

function Tab({
  active,
  onClick,
  children,
  count,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  count?: number;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      /*
       * The active tab carries a 3px brass underline as well as brass text,
       * matching the navigation band. Two signals, because a brass-on-dark
       * colour shift alone is invisible to a red-green colour blind reader.
       */
      className={`flex min-h-11 items-center gap-2 border-b-[3px] px-1 text-label uppercase transition-colors duration-150 ease-out focus-visible:outline-trust-register ${
        active
          ? "border-trust-register text-trust-register"
          : "border-transparent text-register-ink-muted hover:text-register-ink"
      }`}
    >
      {children}
      {count === undefined ? null : (
        <span className="font-data text-chip">{count}</span>
      )}
    </button>
  );
}

/**
 * The header a floor group carries.
 *
 * Four cases, and the fourth is the one that matters: an apartment whose floor
 * is neither stored nor derivable from its number keeps its address group and
 * says so, rather than being labelled "Without apartment" while its number is
 * printed in the row below.
 */
function groupLabel<TRow extends DirectoryRow>(
  t: (key: TranslationKey, options?: Record<string, unknown>) => string,
  group: FloorGroup<TRow>,
): string {
  if (group.floor === null) {
    return t("register.group.withoutApartment");
  }
  if (group.floor === UNKNOWN_FLOOR) {
    return t("register.group.unknownFloor");
  }
  if (group.floor === 0) {
    return t("register.group.ground", { prefix: group.numberPrefix ?? "" });
  }
  return t("register.group.floor", {
    floor: group.floor,
    prefix: group.numberPrefix ?? "",
  });
}

/** The mono stamp in the board's footer, naming the document and its date. */
function RegisterStamp({
  stampKey,
  scope,
  date,
}: {
  stampKey: TranslationKey;
  scope: string;
  date: string;
}): ReactElement {
  const { t } = useTranslation();

  return (
    <p className="font-data text-data text-register-ink-muted">
      {t(stampKey, { scope, date })}
    </p>
  );
}

export function Board<TRow extends DirectoryRow>({
  page,
  filter,
  onFilterChange,
  addressId,
  onAddressChange,
  onPageChange,
  search,
  onSearchChange,
  stampKey,
  contactOf,
  purgeOf,
  onOpenPerson,
  onOpenApartment,
  loading,
}: BoardProps<TRow>): ReactElement {
  const { t } = useTranslation();

  const showContact = contactOf !== undefined;
  const multipleAddresses = page.addresses.length > 1;
  const groups = groupByFloor(page.rows, { multipleAddresses });
  const columnCount = showContact ? 6 : 5;
  const pages = Math.max(1, Math.ceil(page.total / page.pageSize));

  const addressLabel = (id: string): string => {
    const address = page.addresses.find((candidate) => candidate.id === id);
    return address === undefined ? id : `${address.street} ${address.number}`;
  };
  const scope =
    addressId === undefined ? t("register.house.all") : addressLabel(addressId);

  return (
    <section
      className={`overflow-hidden rounded-panel bg-register text-register-ink shadow-raised transition-opacity duration-150 ease-out ${
        loading ? "opacity-60" : "opacity-100"
      }`}
      aria-busy={loading}
    >
      {multipleAddresses ? (
        <nav
          aria-label={t("register.house.label")}
          className="flex flex-wrap items-center gap-5 border-b border-register-line px-6"
        >
          <Tab
            active={addressId === undefined}
            onClick={() => {
              onAddressChange(undefined);
            }}
          >
            {t("register.house.all")}
          </Tab>
          {page.addresses.map((address) => (
            <Tab
              key={address.id}
              active={addressId === address.id}
              onClick={() => {
                onAddressChange(address.id);
              }}
            >
              {`${address.street} ${address.number}`}
            </Tab>
          ))}
        </nav>
      ) : null}

      <div className="flex flex-col gap-3 border-b border-register-line px-6 py-3 lg:flex-row lg:items-start lg:justify-between">
        <nav
          aria-label={t("register.filter.label")}
          className="flex flex-wrap items-center gap-5"
        >
          {REGISTER_FILTERS.map((candidate) => (
            <Tab
              key={candidate}
              active={filter === candidate}
              count={page.counts[candidate]}
              onClick={() => {
                onFilterChange(candidate);
              }}
            >
              {t(FILTER_LABEL[candidate])}
            </Tab>
          ))}
        </nav>

        <div className="flex flex-col gap-1">
          <label
            htmlFor="register-search"
            className="text-label text-register-ink-muted uppercase"
          >
            {t("register.search.label")}
          </label>
          <input
            id="register-search"
            type="search"
            value={search}
            onChange={(event) => {
              onSearchChange(event.target.value);
            }}
            placeholder={t("register.search.placeholder")}
            aria-describedby="register-search-hint"
            className="h-11 w-full rounded-control border border-register-line bg-register-raised px-3 text-body text-register-ink placeholder:text-register-ink-muted focus-visible:outline-trust-register lg:w-80"
          />
          <p
            id="register-search-hint"
            className="max-w-80 text-small text-register-ink-muted"
          >
            {t(
              showContact
                ? "register.search.hint"
                : "register.search.residentHint",
            )}
          </p>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <caption className="sr-only">{t("register.heading")}</caption>
          <thead className="bg-register-raised">
            <tr>
              <th scope="col" className={HEAD_CELL}>
                {t("register.column.apartmentNumber")}
              </th>
              <th scope="col" className={HEAD_CELL}>
                {t("register.column.name")}
              </th>
              <th scope="col" className={`${HEAD_CELL} ${DESKTOP_ONLY}`}>
                {t("register.column.role")}
              </th>
              {showContact ? (
                <th scope="col" className={`${HEAD_CELL} ${DESKTOP_ONLY}`}>
                  {t("register.column.contact")}
                </th>
              ) : null}
              <th scope="col" className={`${HEAD_CELL} ${DESKTOP_ONLY}`}>
                {t("register.column.movedIn")}
              </th>
              <th scope="col" className={`${HEAD_CELL} ${DESKTOP_ONLY}`}>
                {t("register.column.movedOut")}
              </th>
            </tr>
          </thead>

          {groups.length === 0 ? (
            <tbody>
              <tr>
                <td colSpan={columnCount} className="px-6 py-8">
                  <p className="text-title">{t("register.empty.title")}</p>
                  <p className="text-body text-register-ink-muted">
                    {t("register.empty.description")}
                  </p>
                </td>
              </tr>
            </tbody>
          ) : (
            groups.map((group) => (
              <tbody key={group.key}>
                <tr className="bg-register-raised">
                  <th
                    scope="colgroup"
                    colSpan={columnCount}
                    className="px-6 py-1.5 text-left text-label text-register-ink-muted uppercase"
                  >
                    {groupLabel(t, group)}
                    {group.showAddress && group.addressId !== null ? (
                      <span className="ml-2 font-data text-data normal-case">
                        {addressLabel(group.addressId)}
                      </span>
                    ) : null}
                  </th>
                </tr>

                {group.rows.map((row) => (
                  <BoardRowView
                    key={row.key}
                    row={row}
                    contact={contactOf?.(row)}
                    purgeOn={purgeOf?.(row) ?? null}
                    showContact={showContact}
                    onOpenPerson={onOpenPerson}
                    onOpenApartment={onOpenApartment}
                  />
                ))}
              </tbody>
            ))
          )}
        </table>
      </div>

      <footer className="flex flex-col gap-4 border-t border-register-line px-6 py-4 lg:flex-row lg:items-center lg:justify-between">
        <ColourLegend />
        <RegisterStamp
          stampKey={stampKey}
          scope={scope}
          date={page.generatedOn}
        />
      </footer>

      {pages > 1 ? (
        <nav
          aria-label={t("register.pagination.status", {
            page: page.page,
            pages,
          })}
          className="flex items-center justify-between gap-4 border-t border-register-line px-6 py-3"
        >
          <button
            type="button"
            disabled={page.page <= 1}
            onClick={() => {
              onPageChange(page.page - 1);
            }}
            className={PAGE_BUTTON}
          >
            {t("register.pagination.previous")}
          </button>
          <p
            aria-live="polite"
            className="font-data text-data text-register-ink-muted"
          >
            {t("register.pagination.status", { page: page.page, pages })}
          </p>
          <button
            type="button"
            disabled={page.page >= pages}
            onClick={() => {
              onPageChange(page.page + 1);
            }}
            className={PAGE_BUTTON}
          >
            {t("register.pagination.next")}
          </button>
        </nav>
      ) : null}
    </section>
  );
}

/**
 * One row.
 *
 * A residency that has ended is dimmed by moving its ink to the secondary
 * register token rather than by lowering opacity. Opacity would take the text
 * below the 4.5:1 floor this register is held to; the secondary token is a pair
 * the contrast matrix enforces, so the row reads as quieter without becoming
 * harder to read. The dashed sign and the purge date carry the rest of the
 * signal.
 */
function BoardRowView<TRow extends DirectoryRow>({
  row,
  contact,
  purgeOn,
  showContact,
  onOpenPerson,
  onOpenApartment,
}: {
  row: TRow;
  contact: RegisterContact | undefined;
  purgeOn: string | null;
  showContact: boolean;
  onOpenPerson?: (personId: string) => void;
  onOpenApartment?: (apartmentId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const movedOut = row.signs.includes("MOVED_OUT");
  const nameInk = movedOut ? "text-register-ink-muted" : "text-register-ink";
  const apartment = row.apartment;

  return (
    <tr className="border-t border-register-line">
      <td className={DATA_CELL}>
        {apartment === null ? (
          <NotRecorded />
        ) : onOpenApartment === undefined ? (
          apartment.number
        ) : (
          <button
            type="button"
            onClick={() => {
              onOpenApartment(apartment.id);
            }}
            aria-label={t("register.actions.openApartment", {
              number: apartment.number,
            })}
            className="min-h-11 text-trust-register underline-offset-4 hover:underline focus-visible:outline-trust-register"
          >
            {apartment.number}
          </button>
        )}
      </td>

      <td className={CELL}>
        <span className="flex flex-col gap-1.5">
          {onOpenPerson === undefined ? (
            <span className={`text-body font-medium ${nameInk}`}>
              {row.name}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => {
                onOpenPerson(row.personId);
              }}
              aria-label={t("register.actions.openPerson", { name: row.name })}
              className={`flex min-h-11 items-center text-left text-body font-medium underline-offset-4 hover:underline focus-visible:outline-trust-register ${nameInk}`}
            >
              {row.name}
            </button>
          )}

          <span className="sm:hidden">
            <SignRow signs={row.signs} />
          </span>

          {/*
           * The narrow-screen fold: the columns hidden below `sm` reappear here
           * as labelled mono pairs, so nothing is clipped and a phone needs no
           * horizontal scrolling.
           */}
          <span className="flex flex-wrap gap-x-4 gap-y-1 sm:hidden">
            {showContact ? <ContactValue contact={contact} labelled /> : null}
            <MetaPair
              labelKey="register.column.movedIn"
              value={row.movedInOn}
            />
            {row.movedOutOn === null ? null : (
              <MetaPair
                labelKey="register.column.movedOut"
                value={row.movedOutOn}
              />
            )}
          </span>

          {purgeOn === null ? null : (
            <span
              className="font-data text-data text-warn-register"
              title={t("register.purge.explanation")}
            >
              {`${t("register.purge.label")} ${purgeOn}`}
            </span>
          )}
        </span>
      </td>

      <td className={`${CELL} ${DESKTOP_ONLY}`}>
        <SignRow signs={row.signs} />
      </td>

      {showContact ? (
        <td className={`${DATA_CELL} ${DESKTOP_ONLY}`}>
          <ContactValue contact={contact} labelled={false} />
        </td>
      ) : null}

      <td className={`${DATA_CELL} ${DESKTOP_ONLY}`}>
        {row.movedInOn ?? <NotRecorded />}
      </td>
      <td className={`${DATA_CELL} ${DESKTOP_ONLY}`}>
        {row.movedOutOn ?? <NotRecorded />}
      </td>
    </tr>
  );
}

function MetaPair({
  labelKey,
  value,
}: {
  labelKey: TranslationKey;
  value: string | null;
}): ReactElement {
  const { t } = useTranslation();

  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-chip text-register-ink-muted uppercase">
        {t(labelKey)}
      </span>
      <span className="font-data text-data text-register-ink-muted">
        {value ?? <NotRecorded />}
      </span>
    </span>
  );
}

/**
 * Contact data as the board sees it.
 *
 * A masked person shows the word "Maskerad" rather than a row of asterisks. A
 * placeholder shaped like a value invites the reader to think the value is there
 * and merely unreadable, when the truth is that seeing it is a separate and
 * logged act.
 */
function ContactValue({
  contact,
  labelled,
}: {
  contact: RegisterContact | undefined;
  labelled: boolean;
}): ReactElement | null {
  const { t } = useTranslation();

  if (contact === undefined) {
    return null;
  }

  if (contact.state === "masked") {
    return (
      <span className="flex items-baseline gap-1.5">
        {labelled ? (
          <span className="text-chip text-register-ink-muted uppercase">
            {t("register.column.contact")}
          </span>
        ) : null}
        <span className="font-data text-data text-warn-register">
          {t("register.contact.masked")}
        </span>
      </span>
    );
  }

  const values = [contact.email, contact.phone].filter(
    (value): value is string => value !== null && value !== "",
  );

  return (
    <span className="flex flex-col">
      {labelled ? (
        <span className="text-chip text-register-ink-muted uppercase">
          {t("register.column.contact")}
        </span>
      ) : null}
      {values.length === 0 ? (
        <span className="font-data text-data text-register-ink-muted">
          {t("register.contact.none")}
        </span>
      ) : (
        values.map((value) => (
          <span
            key={value}
            className="font-data text-data text-register-ink-muted"
          >
            {value}
          </span>
        ))
      )}
    </span>
  );
}
