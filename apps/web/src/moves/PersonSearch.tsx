import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import { fetchBoardRegister } from "../register/register-api";
import { useDebouncedValue } from "../register/use-address-book";
import { FIELD, HINT, LABEL } from "../ui/controls";

/**
 * Picking a person already in the register.
 *
 * Search rather than a dropdown of everyone: a cooperative of two hundred
 * households has more names than a select is usable with, and the register is
 * already paged for that reason.
 *
 * Only people who are in the register can be picked. Creating one from here
 * would put half of "add a person" inside the move flow, and the hint says so
 * rather than leaving a board member hunting for a field that is not there.
 */

export interface PersonOption {
  personId: string;
  name: string;
}

export function PersonSearch({
  id,
  label,
  selected,
  onSelect,
}: {
  id: string;
  label: string;
  selected: PersonOption | null;
  onSelect: (person: PersonOption | null) => void;
}): ReactElement {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<PersonOption[]>([]);
  const search = useDebouncedValue(query);

  // Two characters before anything is asked for. A one-letter search returns
  // most of the register, which is neither useful nor cheap.
  const searching = search.trim().length >= 2;
  // Derived rather than cleared in the effect, so a shortened query hides the
  // previous answers without a second render to do it.
  const visible = searching ? options : [];

  useEffect(() => {
    if (!searching) {
      return;
    }

    const controller = new AbortController();
    void (async () => {
      try {
        const page = await fetchBoardRegister(
          { filter: "all", search, page: 1 },
          controller.signal,
        );
        // One row per residency, so the same person can come back twice.
        const seen = new Map<string, PersonOption>();
        for (const row of page.rows) {
          seen.set(row.personId, { personId: row.personId, name: row.name });
        }
        setOptions([...seen.values()]);
      } catch {
        setOptions([]);
      }
    })();

    return () => {
      controller.abort();
    };
  }, [search, searching]);

  if (selected !== null) {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-label text-ink-muted uppercase">{label}</span>
        <span className="flex flex-wrap items-center gap-3">
          <span className="text-body font-medium text-ink">
            {selected.name}
          </span>
          <button
            type="button"
            onClick={() => {
              onSelect(null);
              setQuery("");
            }}
            className="min-h-11 rounded-control border border-line px-3 text-small text-ink-muted"
          >
            {t("moves.cancel")}
          </button>
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <label className={LABEL} htmlFor={id}>
        {label}
        <input
          id={id}
          type="search"
          value={query}
          placeholder={t("moves.in.personPlaceholder")}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          className={FIELD}
        />
      </label>
      <p className={HINT}>{t("moves.in.personHint")}</p>

      {!searching ? null : visible.length === 0 ? (
        <p className={HINT}>{t("moves.in.noPersonMatch")}</p>
      ) : (
        <ul className="flex flex-col">
          {visible.map((option) => (
            <li key={option.personId}>
              <button
                type="button"
                onClick={() => {
                  onSelect(option);
                }}
                className="flex min-h-11 w-full items-center rounded-control px-2 text-left text-body text-ink hover:bg-sunken"
              >
                {option.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
