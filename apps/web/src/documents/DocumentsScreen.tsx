import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import type { Viewer } from "../api/instance";
import { isReadOnly } from "../support/read-only";
import { DocumentShelves, useArchive } from "./DocumentShelves";

/**
 * The association's document archive, as the house reads it.
 *
 * One screen for everybody, and what it holds is decided by the server. The
 * list endpoint filters by the viewer's audience, so a resident is not shown a
 * shelf they would be refused - and the screen never has to guess, which is
 * what would let the interface and the API disagree about who a document is
 * for.
 *
 * Filing a document, and reading every shelf by its audience, is the board's
 * page (`DocumentBoardScreen`). What stays here is the one act done in place:
 * a board member editing a document on the shelf they are reading, under the
 * board's sign on the row (ADR 0049). A support session (ADR 0028) reads the
 * shelves and is offered no edit.
 */

export interface DocumentsScreenProps {
  viewer: Viewer;
}

export function DocumentsScreen({
  viewer,
}: DocumentsScreenProps): ReactElement {
  const { t } = useTranslation();
  // documents:manage reads every shelf there is, so an archive empty for it is
  // empty; for anybody else it is empty of what is theirs to read.
  const canManage = viewer.capabilities.includes("documents:manage");
  const loaded = useArchive();
  /*
   * The server lists the board's shelf for a seat that manages documents, and
   * the resident preview takes that capability off the viewer, so the shelf is
   * left out here as it is for a member. The filtered list is the archive the
   * shelves read, so an archive holding only the board's shelf says it holds
   * nothing for this viewer.
   */
  const archive = {
    ...loaded,
    documents:
      loaded.documents === null
        ? null
        : loaded.documents.filter(
            (document) => document.audience !== "BOARD" || canManage,
          ),
  };

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-2">
        <h1 className="text-display">{t("documents.heading")}</h1>
        <p className="max-w-2xl text-body text-ink-muted">
          {t("documents.description")}
        </p>
      </header>

      <DocumentShelves
        archive={archive}
        emptyKey={canManage ? "documents.empty" : "documents.emptyForYou"}
        editable={canManage && !isReadOnly(viewer)}
      />
    </div>
  );
}
