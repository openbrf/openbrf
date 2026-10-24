import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import type { TranslationKey } from "../i18n/translation-key";
import { Notice } from "../ui/Notice";
import { DocumentRow } from "./DocumentRow";
import { fileSizeOf, shelvesOf } from "./document-shelf";
import { type ArchivedDocument, fetchDocuments } from "./documents-api";

/** The archive as the server answered it for this viewer. */
export interface Archive {
  /** Null until the first answer. */
  documents: ArchivedDocument[] | null;
  failed: boolean;
  /** Reads the archive again, after a change to it. */
  reload: () => void;
}

/**
 * Reads the archive, which is the server's answer for this viewer: the list
 * endpoint filters by audience, so a resident is never sent a shelf they would
 * be refused, and neither screen has to guess.
 *
 * A change reloads rather than patching the list in place. An edit can move a
 * document between binders and an audience change moves it under a filter, so
 * the server's own ordering is the only thing that gets both right.
 */
export function useArchive(): Archive {
  const [documents, setDocuments] = useState<ArchivedDocument[] | null>(null);
  const [failed, setFailed] = useState(false);
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

  const reload = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  return { documents, failed, reload };
}

export interface DocumentShelvesProps {
  archive: Archive;
  /**
   * What of the archive is shown, when a reading aid narrows it; the whole
   * archive otherwise.
   */
  shown?: readonly ArchivedDocument[];
  /** What an archive with nothing in it says to this viewer. */
  emptyKey: TranslationKey;
  /** Whether each row offers the board's edit, in place under its sign. */
  editable: boolean;
  /**
   * Whether the edit control carries the board's sign. Off on the board's own
   * page, where the sign would repeat the one beside each document's audience.
   */
  signControls?: boolean;
}

/**
 * The archive's shelves, one per binder, with what is said while they are read,
 * when they could not be, and when there is nothing on them.
 *
 * The same shelves on the house's archive and on the board's page, so a
 * document reads the same wherever it is found.
 */
export function DocumentShelves({
  archive,
  shown,
  emptyKey,
  editable,
  signControls = true,
}: DocumentShelvesProps): ReactElement {
  const { t } = useTranslation();
  const { documents, failed, reload } = archive;
  const shelves = shelvesOf(shown ?? documents ?? []);

  return (
    <>
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
          {documents.length === 0
            ? t(emptyKey)
            : // The archive holds something; the filter is what is hiding it.
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
                  editable={editable}
                  signControls={signControls}
                  onChanged={reload}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
