import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import { Notice } from "../ui/Notice";
import {
  type Binder,
  fetchMyBinders,
  fileInMyBinder,
  takeOutOfMyBinder,
} from "./apartment-binder-api";
import { BinderEntryRow } from "./BinderEntryRow";
import { groupByKind, KIND_LABEL } from "./binder-kinds";
import { FileEntryPanel } from "./FileEntryPanel";

/**
 * The apartment binder (lagenhetsparm): the papers about one home, as the
 * household reads them.
 *
 * The binder of whoever is reading, which follows their residency and needs no
 * capability at all: the server answers the apartments they live in today and
 * the entries their role allows, and this screen shows exactly that. Every
 * apartment's binder is the board's page (`BinderBoardScreen`, ADR 0049), so a
 * board member reads the same screen here as their neighbours do.
 *
 * The screen never decides who may read what. An entry for the tenant-owners is
 * one the database never hands to a resident, and the file behind it is decided
 * again by the media route. What is decided here is what is offered: a form for
 * somebody who holds the apartment, and "take out" on what this account filed.
 *
 * Nobody is named on a household's half. The answer it reads carries no name to
 * render - one rule for every household, rather than a rule with an exception
 * for people who live together.
 */

export function ApartmentBinderScreen(): ReactElement {
  const { t } = useTranslation();

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
        {/*
         * A tenant-owner's own entry in the apartment register, which BRL
         * 9 kap. entitles them to. Linked from the page about their home
         * because the address book, which linked it before, is the board's
         * page alone now (ADR 0049); the register's route answers them with
         * their own apartment and nothing else.
         */}
        {binders?.some((binder) => binder.isTenantOwner) === true ? (
          <p className="max-w-2xl text-small">
            <Link
              to="/board/registers/apartments"
              className="text-ink underline decoration-line-strong underline-offset-4"
            >
              {t("registers.nav.ownApartmentRegister")}
            </Link>
          </p>
        ) : null}
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
          {t("apartmentBinder.empty")}
        </p>
      ) : null}

      {(binders ?? []).map((binder) => (
        <HouseholdBinder
          key={binder.apartmentId}
          binder={binder}
          onChanged={reload}
        />
      ))}
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
