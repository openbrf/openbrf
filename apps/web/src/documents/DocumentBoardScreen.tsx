import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import type { Viewer } from "../api/instance";
import { isReadOnly } from "../support/read-only";
import { BoardPage } from "../ui/BoardPage";
import { AudienceSign } from "./AudienceField";
import { DocumentShelves, useArchive } from "./DocumentShelves";
import { type DocumentAudience, DOCUMENT_AUDIENCES } from "./documents-api";
import { FileDocumentPanel } from "./FileDocumentPanel";

type AudienceFilter = DocumentAudience | "all";

const FILTERS: readonly AudienceFilter[] = ["all", ...DOCUMENT_AUDIENCES];

export interface DocumentBoardScreenProps {
  viewer: Viewer;
}

/**
 * "Manage the archive": filing a document, and every shelf the board may read
 * sorted by who each document is for, as a page of its own under /board.
 *
 * `documents:manage` is the board's. A support session (ADR 0028) holds it
 * read only, and gets the filter and the shelves with nothing on them that
 * changes the archive. Editing a document on the house's shelf stays where a
 * board member reads it, under the board's sign (ADR 0049); here the same row
 * is offered beside the filter that finds it.
 *
 * The filter is a reading aid over the list the server already sent; it is not
 * an access control and could not be one. Hiding the page is courtesy only: the
 * API refuses the calls either way.
 */
export function DocumentBoardScreen({
  viewer,
}: DocumentBoardScreenProps): ReactElement {
  const { t } = useTranslation();
  const canManage = viewer.capabilities.includes("documents:manage");
  const canChange = canManage && !isReadOnly(viewer);

  return (
    <BoardPage title={t("documents.boardTitle")} offered={canManage}>
      <DocumentBoard canChange={canChange} />
    </BoardPage>
  );
}

/**
 * What the page holds, mounted only once it is offered, so an account the page
 * is not offered to asks the API for nothing.
 */
function DocumentBoard({ canChange }: { canChange: boolean }): ReactElement {
  const { t } = useTranslation();
  const filterName = useId();
  const archive = useArchive();
  const [filter, setFilter] = useState<AudienceFilter>("all");

  const shown = (archive.documents ?? []).filter(
    (document) => filter === "all" || document.audience === filter,
  );

  return (
    <>
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

      <DocumentShelves
        archive={archive}
        shown={shown}
        emptyKey="documents.empty"
        editable={canChange}
      />

      {canChange ? <FileDocumentPanel onFiled={archive.reload} /> : null}
    </>
  );
}
