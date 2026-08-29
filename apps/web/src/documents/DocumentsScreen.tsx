import { useCallback, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import type { Viewer } from "../api/instance";
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
 * filter over the audiences. The filter is a reading aid over the list the
 * server already sent; it is not an access control and could not be one.
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
  const canManage = viewer.capabilities.includes("documents:manage");

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

  const shown =
    documents === null
      ? []
      : documents.filter(
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
          <fieldset className="flex flex-wrap items-center gap-3">
            <legend className="sr-only">{t("documents.filter.legend")}</legend>
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

      {canManage ? <FileDocumentPanel onFiled={reload} /> : null}

      {documents === null && !failed ? (
        <p role="status" className="text-body text-ink-muted">
          {t("documents.loading")}
        </p>
      ) : null}

      {documents !== null && shelves.length === 0 ? (
        <p className="text-body text-ink-muted">
          {documents.length === 0
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
                  editable={canManage}
                  onChanged={reload}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
