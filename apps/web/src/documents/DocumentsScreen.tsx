import { useCallback, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import type { Viewer } from "../api/instance";
import { isReadOnly } from "../support/read-only";
import { BoardMark, BoardZone } from "../ui/BoardZone";
import { Notice } from "../ui/Notice";
import { AudienceSign } from "./AudienceField";
import { DocumentRow } from "./DocumentRow";
import { fileSizeOf, shelvesOf } from "./document-shelf";
import {
  type ArchivedDocument,
  type DocumentAudience,
  DOCUMENT_AUDIENCES,
  fetchDocuments,
} from "./documents-api";
import { FileDocumentPanel } from "./FileDocumentPanel";

/**
 * The association's document archive.
 *
 * One screen for everybody, and what it holds is decided by the server. The
 * list endpoint filters by the viewer's audience, so a resident is not shown a
 * shelf they would be refused - and the screen never has to guess, which is
 * what would let the interface and the API disagree about who a document is
 * for.
 *
 * The board gets two things on top: the panel that files a document, and a
 * filter over the audiences. A support session (ADR 0028) gets the filter and
 * the board's shelves, and neither the panel nor a row's edit. The filter is a reading aid over the list the
 * server already sent; it is not an access control and could not be one.
 *
 * The filing panel stands below the shelves, in the board's zone, because the
 * shelves are what everybody comes here to read. The filter stays beside the
 * heading it narrows, carrying the board's sign instead.
 */

type AudienceFilter = DocumentAudience | "all";

const FILTERS: readonly AudienceFilter[] = ["all", ...DOCUMENT_AUDIENCES];

export interface DocumentsScreenProps {
  viewer: Viewer;
}

export function DocumentsScreen({
  viewer,
}: DocumentsScreenProps): ReactElement {
  const { t } = useTranslation();
  const filterName = useId();
  const filterMarkId = useId();
  const filterLegendId = useId();
  // The board's view of the archive, and what of it may be changed: nothing,
  // for a support session, which reads every shelf the board does.
  const canManage = viewer.capabilities.includes("documents:manage");
  const canChange = canManage && !isReadOnly(viewer);

  const [documents, setDocuments] = useState<ArchivedDocument[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<AudienceFilter>("all");
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const result = await fetchDocuments();
      if (cancelled) {
        return;
      }
      setFailed(!result.ok);
      if (result.ok) {
        setDocuments(result.value);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  /*
   * A change reloads rather than patching the list in place. An edit can move
   * a document between binders and an audience change moves it under a filter,
   * so the server's own ordering is the only thing that gets both right.
   */
  const reload = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  /*
   * The server lists the board's shelf for a seat that manages documents, and
   * the resident preview takes that capability off the viewer, so the shelf is
   * left out here as it is for a member.
   */
  const readable =
    documents === null
      ? []
      : documents.filter(
          (document) => document.audience !== "BOARD" || canManage,
        );
  const shown = readable.filter(
    (document) => filter === "all" || document.audience === filter,
  );
  const shelves = shelvesOf(shown);

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-display">{t("documents.heading")}</h1>
          <p className="max-w-2xl text-body text-ink-muted">
            {t("documents.description")}
          </p>
        </div>

        {canManage ? (
          /*
           * Named by the sign and the legend together, so the group reads
           * "Board, Show" and not "Show" alone.
           */
          <fieldset
            aria-labelledby={`${filterMarkId} ${filterLegendId}`}
            className="flex flex-wrap items-center gap-3"
          >
            <legend id={filterLegendId} className="sr-only">
              {t("documents.filter.legend")}
            </legend>
            <BoardMark id={filterMarkId} />
            {FILTERS.map((candidate) => (
              <label
                key={candidate}
                className="flex min-h-11 items-center gap-2 text-small text-ink"
              >
                <input
                  type="radio"
                  name={filterName}
                  value={candidate}
                  checked={filter === candidate}
                  onChange={() => {
                    setFilter(candidate);
                  }}
                  className="size-4 accent-trust"
                />
                {candidate === "all" ? (
                  t("documents.filter.all")
                ) : (
                  <AudienceSign audience={candidate} />
                )}
              </label>
            ))}
          </fieldset>
        ) : null}
      </header>

      {failed ? (
        <Notice tone="danger" live>
          {t("documents.errors.loadFailed")}
        </Notice>
      ) : null}

      {documents === null && !failed ? (
        <p role="status" className="text-body text-ink-muted">
          {t("documents.loading")}
        </p>
      ) : null}

      {documents !== null && shelves.length === 0 ? (
        <p className="text-body text-ink-muted">
          {readable.length === 0
            ? t(canManage ? "documents.empty" : "documents.emptyForYou")
            : // The archive holds something; this filter is what is hiding it.
              t("documents.filter.none")}
        </p>
      ) : null}

      {shelves.map((shelf) => (
        <section key={shelf.category} className="flex flex-col gap-3">
          <h2 className="text-title">{shelf.category}</h2>
          <ul className="flex flex-col gap-2">
            {shelf.documents.map((document) => (
              <li key={document.id}>
                <DocumentRow
                  document={document}
                  size={fileSizeOf(document.byteSize)}
                  editable={canChange}
                  onChanged={reload}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}

      {canChange ? (
        <BoardZone title={t("documents.boardZone")}>
          <FileDocumentPanel onFiled={reload} />
        </BoardZone>
      ) : null}
    </div>
  );
}
