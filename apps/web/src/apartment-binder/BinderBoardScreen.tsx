import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import type { Viewer } from "../api/instance";
import { BoardPage } from "../ui/BoardPage";
import { Notice } from "../ui/Notice";
import {
  type BoardBinder,
  type BoardBinderSummary,
  fetchBinder,
  fetchBinders,
  fileAsBoard,
  takeOutAsBoard,
} from "./apartment-binder-api";
import { BinderEntryRow } from "./BinderEntryRow";
import { groupByKind, KIND_LABEL } from "./binder-kinds";
import { BoardApartmentChooser } from "./BoardApartmentChooser";
import { FileEntryPanel } from "./FileEntryPanel";

export interface BinderBoardScreenProps {
  viewer: Viewer;
}

/**
 * "Every apartment's binder", as a page of its own under /board.
 *
 * `apartmentBinder:manage` is the one capability in the product a board seat
 * alone confers: the administrator's grant of every capability does not carry
 * it (ADR 0017). A household's own binder stays on the house's page, which a
 * board member who lives here reads as their neighbours do (ADR 0049).
 *
 * The page says who sees it in the binder's own sentence rather than the
 * standard one: the standard line ("the board and the administrator") would
 * name somebody this page is never offered to, and leave out that every reading
 * is written to the audit log.
 *
 * Hiding the page is courtesy only. The API refuses the calls either way.
 */
export function BinderBoardScreen({
  viewer,
}: BinderBoardScreenProps): ReactElement {
  const { t } = useTranslation();

  return (
    <BoardPage
      title={t("apartmentBinder.boardTitle")}
      description={t("apartmentBinder.board.description")}
      offered={viewer.capabilities.includes("apartmentBinder:manage")}
    >
      <BoardBinders />
    </BoardPage>
  );
}

/**
 * The chooser and the chosen binder, mounted only once the page is offered, so
 * an account the page is not offered to asks the API for nothing.
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
  /*
   * The chooser and the chosen binder fail apart from each other, so they are
   * asked apart from each other. One flag for both would lose a failure the
   * moment the other request succeeded, and would leave a binder's failure
   * standing under a chooser that no longer has anything chosen.
   */
  const [listFailed, setListFailed] = useState(false);
  const [binderFailed, setBinderFailed] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const result = await fetchBinders();
      if (cancelled) {
        return;
      }
      setListFailed(!result.ok);
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
      setBinderFailed(!result.ok);
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
    setBinderFailed(false);
  }, []);

  const reload = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  return (
    <>
      {listFailed ? (
        <Notice tone="danger" live>
          {t("apartmentBinder.errors.listFailed")}
        </Notice>
      ) : null}

      <BoardApartmentChooser
        binders={summaries ?? []}
        chosen={chosen}
        onChoose={choose}
      />

      {/*
       * Under the chooser, where the binder itself would be: a notice above it
       * reads as though the association's apartments could not be listed.
       */}
      {binderFailed ? (
        <Notice tone="danger" live>
          {t("apartmentBinder.errors.loadFailed")}
        </Notice>
      ) : null}

      {binder === null ? null : (
        <>
          <h2 className="font-data text-title">{binder.apartment}</h2>

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
              <h3 className="text-label uppercase">
                {t(KIND_LABEL[group.kind])}
              </h3>
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
    </>
  );
}
