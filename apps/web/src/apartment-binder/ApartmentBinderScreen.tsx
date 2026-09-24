import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import type { Viewer } from "../api/instance";
import { Notice } from "../ui/Notice";
import {
  type Binder,
  type BoardBinder,
  type BoardBinderSummary,
  fetchBinder,
  fetchBinders,
  fetchMyBinders,
  fileAsBoard,
  fileInMyBinder,
  takeOutAsBoard,
  takeOutOfMyBinder,
} from "./apartment-binder-api";
import { BinderEntryRow } from "./BinderEntryRow";
import { groupByKind, KIND_LABEL } from "./binder-kinds";
import { BoardApartmentChooser } from "./BoardApartmentChooser";
import { FileEntryPanel } from "./FileEntryPanel";

/**
 * The apartment binder (lagenhetsparm): the papers about one home.
 *
 * Two halves on one route, because they are two ways of reaching the same
 * thing. Above, the binder of whoever is reading, which follows their residency
 * and needs no capability at all: the server answers the apartments they live
 * in today and the entries their role allows, and this screen shows exactly
 * that. Below, and only for a board seat, every apartment's binder.
 *
 * The screen never decides who may read what. An entry for the tenant-owners is
 * one the database never hands to a resident, and the file behind it is decided
 * again by the media route. What is decided here is what is offered: a form for
 * somebody who holds the apartment, the board's own kinds for a board seat, and
 * "take out" on what this account filed.
 *
 * Nobody is named on a household's half. The answer it reads carries no name to
 * render - one rule for every household, rather than a rule with an exception
 * for people who live together.
 */

export interface ApartmentBinderScreenProps {
  viewer: Viewer;
}

export function ApartmentBinderScreen({
  viewer,
}: ApartmentBinderScreenProps): ReactElement {
  const { t } = useTranslation();
  const canManage = viewer.capabilities.includes("apartmentBinder:manage");

  const [binders, setBinders] = useState<Binder[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const result = await fetchMyBinders();
      if (cancelled) {
        return;
      }
      setFailed(!result.ok);
      if (result.ok) {
        setBinders(result.value);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  /*
   * A change reloads rather than patching the list in place: what an entry is
   * grouped under and where it sorts are the server's own answers, and a list
   * edited in the browser would start to disagree with them.
   */
  const reload = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-2">
        <h1 className="text-display">{t("apartmentBinder.heading")}</h1>
        <p className="max-w-2xl text-body text-ink-muted">
          {t("apartmentBinder.intro")}
        </p>
        <p className="max-w-2xl text-small text-ink-muted">
          {t("apartmentBinder.archive")}{" "}
          <Link
            to="/documents"
            className="text-ink underline decoration-line-strong underline-offset-4"
          >
            {t("apartmentBinder.archiveLink")}
          </Link>
        </p>
      </header>

      {failed ? (
        <Notice tone="danger" live>
          {t("apartmentBinder.errors.loadFailed")}
        </Notice>
      ) : null}

      {binders === null && !failed ? (
        <p role="status" className="text-body text-ink-muted">
          {t("apartmentBinder.loading")}
        </p>
      ) : null}

      {binders !== null && binders.length === 0 ? (
        <p className="max-w-2xl text-body text-ink-muted">
          {t(
            canManage
              ? "apartmentBinder.emptyForBoard"
              : "apartmentBinder.empty",
          )}
        </p>
      ) : null}

      {(binders ?? []).map((binder) => (
        <HouseholdBinder
          key={binder.apartmentId}
          binder={binder}
          onChanged={reload}
        />
      ))}

      {canManage ? <BoardBinders /> : null}
    </div>
  );
}

/** One apartment's binder, as whoever lives there reads it. */
function HouseholdBinder({
  binder,
  onChanged,
}: {
  binder: Binder;
  onChanged: () => void;
}): ReactElement {
  const { t } = useTranslation();

  return (
    <section className="flex flex-col gap-4">
      <h2 className="font-data text-title">{binder.apartment}</h2>

      {binder.isTenantOwner ? (
        <p className="max-w-2xl text-small text-ink-muted">
          {t("apartmentBinder.tenantOwnerNote")}
        </p>
      ) : null}

      {binder.entries.length === 0 ? (
        <p className="text-body text-ink-muted">
          {t("apartmentBinder.noEntries")}
        </p>
      ) : null}

      {groupByKind(binder.entries).map((group) => (
        <section key={group.kind} className="flex flex-col gap-3">
          <h3 className="text-label uppercase">{t(KIND_LABEL[group.kind])}</h3>
          <ul className="flex flex-col gap-2">
            {group.entries.map((entry) => (
              <li key={entry.id}>
                <BinderEntryRow
                  entry={entry}
                  mine={entry.filedByYou}
                  /*
                   * Offered on what this account filed, and on nothing else.
                   * The server allows exactly that, and only while they still
                   * hold the apartment: what is left stays with the home, which
                   * is what the form says when it is filed.
                   */
                  takeOut={
                    entry.filedByYou ? () => takeOutOfMyBinder(entry.id) : null
                  }
                  onTakenOut={onChanged}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}

      {binder.isTenantOwner ? (
        <FileEntryPanel
          apartmentId={binder.apartmentId}
          filer="TENANT_OWNER"
          file={fileInMyBinder}
          onFiled={onChanged}
        />
      ) : null}
    </section>
  );
}

/**
 * Every apartment's binder, for a board seat.
 *
 * The chooser is read on its own and the binder only once an apartment is
 * chosen, because the two are different acts: the chooser answers designations
 * and a count each and reads nobody's papers, while opening one is a disclosure
 * and is written to the audit log by the server that answers it.
 */
function BoardBinders(): ReactElement {
  const { t } = useTranslation();

  const [summaries, setSummaries] = useState<BoardBinderSummary[] | null>(null);
  const [chosen, setChosen] = useState("");
  const [binder, setBinder] = useState<BoardBinder | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const result = await fetchBinders();
      if (cancelled) {
        return;
      }
      setFailed(!result.ok);
      if (result.ok) {
        setSummaries(result.value);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  useEffect(() => {
    let cancelled = false;

    if (chosen === "") {
      return;
    }

    void (async () => {
      const result = await fetchBinder(chosen);
      if (cancelled) {
        return;
      }
      setFailed(!result.ok);
      if (result.ok) {
        setBinder(result.value);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [chosen, reloadToken]);

  /*
   * The binder is put down where the choice is made rather than in the effect
   * that reads the next one: a board member who goes back to "choose an
   * apartment" has stopped reading that household's papers, and leaving the
   * last one on the screen until a new one arrives would leave it there for
   * good.
   */
  const choose = useCallback((apartmentId: string) => {
    setChosen(apartmentId);
    setBinder(null);
  }, []);

  const reload = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  return (
    <section className="flex flex-col gap-4 border-t border-line pt-5">
      <div className="flex flex-col gap-2">
        <h2 className="text-title">{t("apartmentBinder.board.heading")}</h2>
        <p className="max-w-2xl text-small text-ink-muted">
          {t("apartmentBinder.board.description")}
        </p>
      </div>

      {failed ? (
        <Notice tone="danger" live>
          {t("apartmentBinder.errors.loadFailed")}
        </Notice>
      ) : null}

      <BoardApartmentChooser
        binders={summaries ?? []}
        chosen={chosen}
        onChoose={choose}
      />

      {binder === null ? null : (
        <>
          <h3 className="font-data text-title">{binder.apartment}</h3>

          <p className="text-small text-ink-muted">
            {t("apartmentBinder.board.shownToday", {
              owners: t("apartmentBinder.board.tenantOwners", {
                count: binder.tenantOwners,
              }),
              residents: t("apartmentBinder.board.residents", {
                count: binder.otherResidents,
              }),
            })}
          </p>

          {binder.entries.length === 0 ? (
            <p className="text-body text-ink-muted">
              {t("apartmentBinder.noEntries")}
            </p>
          ) : null}

          {groupByKind(binder.entries).map((group) => (
            <section key={group.kind} className="flex flex-col gap-3">
              <h4 className="text-label uppercase">
                {t(KIND_LABEL[group.kind])}
              </h4>
              <ul className="flex flex-col gap-2">
                {group.entries.map((entry) => (
                  <li key={entry.id}>
                    <BinderEntryRow
                      entry={entry}
                      filedBy={entry.filedBy}
                      takeOut={() => takeOutAsBoard(entry.id)}
                      onTakenOut={reload}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))}

          <FileEntryPanel
            apartmentId={binder.apartmentId}
            filer="BOARD"
            file={fileAsBoard}
            onFiled={reload}
          />
        </>
      )}
    </section>
  );
}
