import {
  NESTED_BLOCKS,
  PAGE_BLOCKS,
  PAGE_CONTENT_LIMITS,
  type PageWriteReason,
  type PluginBlockDeclaration,
  slugFromTitle,
} from "@openbrf/shared";
import { useBlocker } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent, ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { ApiFailure } from "../api/client";
import {
  type AdminPage,
  type ColumnsBlock,
  deletePage,
  fetchPages,
  fetchPluginBlocks,
  PAGE_STATUSES,
  type PageBlock,
  type PageStatus,
  savePage,
  setFrontPage,
  setPageStatus,
  type TextRun,
  uploadSiteImage,
} from "../api/site";
import type { TranslationKey } from "../i18n/translation-key";
import { loadPluginTranslations } from "../plugins/plugin-i18n";
import { usePluginsTranslation } from "../plugins/use-plugin-translation";
import { Notice } from "../ui/Notice";
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from "../ui/controls";
import { failureMessageKey, refusedFields } from "../ui/save-state";
import {
  type ArrangementUndo,
  type BlockPlace,
  type DropTarget,
  duplicate as duplicateBlock,
  entryOf,
  mayStandAt,
  moveTo,
  placeOf,
  placesFor,
  putIn,
  resolveDrop,
  takeOut,
  undoArrangement,
  updateBlock,
} from "./block-tree";
import type { InserterChoice } from "./BlockInserter";
import { BlockSettings } from "./BlockSettings";
import {
  type CanvasActions,
  type CanvasState,
  createCanvasStore,
} from "./canvas-context";
import { EditorCanvas } from "./EditorCanvas";
import { EditorIcon } from "./EditorIcon";
import type { BlockFieldsContext, LinkablePage } from "./LayoutBlockFields";
import {
  blockLabel,
  blocksOf,
  type EditorBlock,
  editorBlocks,
  editorRegistry,
  type InsertableBlock,
  INSERTABLE,
  moveBlock,
  moveInColumn,
  needsPhotoConsent,
  newBlockWith,
  newEditorBlock,
  newPluginBlock,
  pluginBlockOf,
  replaceBlockWith,
  replaceInColumnWith,
  scanPage,
  storedAs,
  submittableBlocks,
  unfinishedPluginBlocks,
  unfinishedStoredBlocks,
  unfinishedWork,
  withBlock,
  withUploadedPicture,
} from "./page-blocks";
import { PAGE_STATUS_LABELS, PageSettings } from "./PageSettings";
import type { Caret } from "./RichText";

/**
 * One page, edited as it looks.
 *
 * The page is drawn as the website draws it - its markup, its rules, the
 * active theme - and every block on it is written where it stands. A + between
 * blocks and at the end of the page and of each column adds one; a selected
 * block shows its tools over it and its settings beside the page; blocks are
 * dragged by their handle, or moved through the same places from the keyboard,
 * into and out of columns. The page's own settings - who reads it, whether it
 * is the front page, its address - are beside it too, and one save writes the
 * lot.
 *
 * What is stored is still the block list and nothing else (ADR 0006). The
 * drawing is the editor's; the website renders the page on the server, with
 * no script, from the blocks this screen sends.
 */

/**
 * What a refusal from the write API says on this screen.
 *
 * Every reason the page endpoints can answer with is named here, so a refusal
 * the board can act on never arrives as "something went wrong". The two
 * guardrail refusals additionally say where: the API sends positions, and the
 * screen turns them into the block numbers a person is looking at.
 *
 * Checked against {@link PageWriteReason}, the union the API throws with, so a
 * reason the server gains and this screen has no sentence for fails the web
 * build rather than reaching a board member as the unknown sentence.
 */
const REASONS: Readonly<Record<string, TranslationKey>> = {
  "invalid-slug": "siteAdmin.errors.invalidSlug",
  "slug-taken": "siteAdmin.errors.slugTaken",
  "invalid-body": "siteAdmin.errors.invalidBody",
  "personal-identity-number": "siteAdmin.errors.personalIdentityNumber",
  "photo-consent-required": "siteAdmin.errors.photoConsentRequired",
  "image-not-found": "siteAdmin.errors.imageNotFound",
  "image-not-public": "siteAdmin.errors.imageNotPublic",
  "not-found": "siteAdmin.errors.pageGone",
  "front-page": "siteAdmin.errors.frontPage",
  "front-page-not-public": "siteAdmin.errors.frontPageNotPublic",
  "built-in": "siteAdmin.errors.builtIn",
  /*
   * One sentence for all four acts that take a precondition. What the board has
   * to do is the same in each: read the page again, and decide about the copy
   * that is there rather than the one it was looking at.
   */
  "page-changed": "siteAdmin.errors.pageChanged",
} satisfies Record<PageWriteReason | "invalid-body", TranslationKey>;

/** How many changes to the arrangement can be taken back, newest first. */
const UNDO_DEPTH = 50;

export interface PageEditorProps {
  page: AdminPage;
  /** The association's pages, which a button may lead to. */
  pages: readonly LinkablePage[];
  onChanged: (page: AdminPage) => void;
  onRemoved: (id: string) => void;
}

export function PageEditor({
  page,
  pages,
  onChanged,
  onRemoved,
}: PageEditorProps): ReactElement {
  const { t } = useTranslation();
  const translatePlugin = usePluginsTranslation();
  const instructionsId = useId();

  /**
   * The blocks the serving plugins add, as this instance tells the editor.
   *
   * Empty until the answer arrives, and empty if it never does: the page is
   * then edited with the core's blocks, and a plugin's block already on it is
   * shown as one the editor cannot set up - kept, and sent back as it is.
   *
   * Whether the answer has arrived is kept beside it, because a block the
   * editor has no declaration for means something different before and after:
   * only once the instance has answered is it known that the block's plugin is
   * not serving, and so that the website does not show the block either.
   */
  const [plugins, setPlugins] = useState<readonly PluginBlockDeclaration[]>([]);
  const [pluginsKnown, setPluginsKnown] = useState<
    "loading" | "failed" | "known"
  >("loading");
  /** Bumped when a plugin's words arrive, so its labels render as words. */
  const [pluginWords, setPluginWords] = useState(0);
  useEffect(() => {
    let active = true;
    void (async () => {
      const result = await fetchPluginBlocks();
      if (!active) {
        return;
      }
      if (!result.ok) {
        setPluginsKnown("failed");
        return;
      }
      setPlugins(result.value.blocks);
      setPluginsKnown("known");
      const ids = [
        ...new Set(result.value.blocks.map((block) => block.pluginId)),
      ];
      await Promise.all(ids.map(async (id) => loadPluginTranslations(id)));
      if (active) {
        setPluginWords((count) => count + 1);
      }
    })();
    return () => {
      active = false;
    };
  }, []);
  const registry = useMemo(() => editorRegistry(plugins), [plugins]);

  const [title, setTitle] = useState(page.title);
  /**
   * The address the board typed under Advanced, or null while it has not.
   *
   * Null is what lets the server decide: a page that still follows its title
   * gets the address the new title gives, and any other page keeps its own. A
   * save sends an address only when the board wrote one.
   */
  const [typedSlug, setTypedSlug] = useState<string | null>(null);
  /**
   * The status the board chose on this screen, or null while it has not. One
   * choice of three rather than a publish button and an audience button beside
   * it, because the board means one thing.
   *
   * Null for the same reason as the address: a status nobody chose here is the
   * page's own, read from the copy this editor holds. When somebody else takes
   * the page down or closes it to the members while it is open here, the copy
   * read again after the conflict carries that status, and the next save keeps
   * it. A status copied in when the editor opened would put the page back where
   * it was, in front of the readers the other editor had just closed it to.
   */
  const [chosenStatus, setChosenStatus] = useState<PageStatus | null>(null);
  const status = chosenStatus ?? page.status;
  /** Whether the next save makes this page the front page. */
  const [makeFront, setMakeFront] = useState(false);
  // Only a public page can be the front page, and the page may have stopped
  // being one since the switch was turned on.
  const front = makeFront && status === "PUBLIC";
  const [entries, setEntries] = useState<EditorBlock[]>(() =>
    editorBlocks(page.content.blocks),
  );
  const [identifiable, setIdentifiable] = useState<ReadonlySet<string>>(
    new Set(),
  );
  /**
   * The pictures declared to show identifiable persons, by the identity of
   * the block they are in - or of the block in a column, for one in a column.
   *
   * By identity and not by position, because the answer is given before the
   * file is chosen and read again when it is: anything moved or removed in
   * between renumbers the blocks, and a declaration read off the wrong one
   * would upload a picture of identifiable people as showing nobody. That is
   * recorded on the stored file, and the publication guardrail then never asks
   * for a publiceringssamtycke for it again.
   */
  const [declared, setDeclared] = useState<ReadonlySet<string>>(new Set());
  const [consentConfirmed, setConsentConfirmed] = useState(false);
  const [consentAsked, setConsentAsked] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [saved, setSaved] = useState(false);
  /** Whether a save was just held back over a stored block left unfinished. */
  const [heldBack, setHeldBack] = useState(false);
  const [busy, setBusy] = useState(false);
  /** The paragraph a return has just split off, and where its caret goes. */
  const [splitFocus, setSplitFocus] = useState<{
    id: string;
    offset: number;
  } | null>(null);
  /**
   * The paragraph a return or a paste was held in because the page has no
   * room for another block, so the reason is given where the board is
   * writing rather than only beside the + further down.
   */
  const [heldAt, setHeldAt] = useState<string | null>(null);
  /**
   * The paragraphs typing or a paste was held in because they were full. A
   * paste can cut a paragraph it started, which has no identity until the
   * change that makes it block arrives, so those are kept in `heldLong` until
   * then.
   */
  const [longAt, setLongAt] = useState<readonly string[]>([]);
  const heldLong = useRef<readonly number[]>([]);

  /** The block whose tools and settings are shown. */
  const [selected, setSelected] = useState<string | null>(null);
  /**
   * The block picked up from the keyboard, and the place it was picked up
   * from, which Escape puts it back at.
   */
  const [lifted, setLifted] = useState<{
    id: string;
    from: BlockPlace;
  } | null>(null);
  /** The block a pointer is dragging, and where it would land. */
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<DropTarget | null>(null);
  /**
   * The changes to the arrangement that can be taken back, newest last, each
   * with the words that say what taking it back does.
   */
  const [undos, setUndos] = useState<
    readonly { undo: ArrangementUndo; what: string }[]
  >([]);

  /**
   * The last thing done to the arrangement, by the control the focus goes to.
   *
   * Removing a block takes its tools out of the page, so the focus goes to a
   * neighbour's handle and the removal is announced instead. Moving a block
   * re-inserts the element that holds the pressed control, and the browser
   * drops the focus of an element it moves, so the control is found again by
   * its block's identity and focused once more. The announcement is the
   * change as a sentence, because the focus coming back to the same control
   * does not say where the block went.
   */
  const [moved, setMoved] = useState<{
    key: string | null;
    announcement: string;
  } | null>(null);
  const controls = useRef(new Map<string, HTMLElement>());
  const control = useCallback(
    (key: string) =>
      (element: HTMLElement | null): void => {
        if (element === null) {
          controls.current.delete(key);
        } else {
          controls.current.set(key, element);
        }
      },
    [],
  );
  useEffect(() => {
    const key = moved?.key;
    if (key == null) {
      return;
    }
    /*
     * A block just added is written in at once where it has words to write:
     * the focus goes to its first field, and to its handle where it has none.
     */
    if (key.startsWith("content:")) {
      const id = key.slice("content:".length);
      /*
       * A paragraph's text editor is loaded on demand, and the + the block was
       * added from can take the focus with it as it goes, so the field is
       * focused until it holds the focus, for a moment at most.
       */
      const until = Date.now() + 2000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let focused = false;
      const focusField = (): void => {
        const block = document.querySelector(
          `[data-block-id="${CSS.escape(id)}"]`,
        );
        const field =
          block?.querySelector<HTMLElement>(
            "[data-canvas-content] [data-canvas-focus]",
          ) ??
          block?.querySelector<HTMLElement>("[data-canvas-content] button");
        const active = document.activeElement;
        // Once it has had the focus, only a focus that fell to the page is
        // put back: one the board moved elsewhere is theirs.
        const dropped = active === null || active === document.body;
        if (field != null && (active === field || (focused && !dropped))) {
          return;
        }
        if (Date.now() > until) {
          controls.current.get(`${id}:handle`)?.focus();
          return;
        }
        if (field != null) {
          field.focus();
          focused = true;
        }
        timer = setTimeout(focusField, 30);
      };
      focusField();
      return () => {
        clearTimeout(timer);
      };
    }
    controls.current.get(key)?.focus();
  }, [moved]);

  /*
   * The same function, and the same lists below, until the plugins or their
   * words change: every block on the page reads them, and a new one on every
   * render would have every block drawn again on every key.
   */
  const kindOf = useCallback(
    (block: PageBlock): string => {
      const plugin = pluginBlockOf(block, plugins);
      return plugin === undefined
        ? t(blockLabel(block.type))
        : translatePlugin(plugin.pluginId, plugin.labelKey);
    },
    // The plugins' words arriving is a change of what the labels say.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [plugins, t, translatePlugin, pluginWords],
  );

  /** Where a block stands, as a sentence: what is said after it moves. */
  const whereIs = (all: readonly EditorBlock[], id: string): string => {
    const place = placeOf(all, id);
    const entry = entryOf(all, id);
    if (place === undefined || entry === undefined) {
      return "";
    }
    const kind = kindOf(entry.block);
    if (place.list === "page") {
      return t("siteAdmin.editor.movedTo", {
        kind,
        number: place.at + 1,
        count: all.length,
      });
    }
    const parentAt = all.findIndex((one) => one.id === place.parent);
    const column = (all[parentAt]?.block as ColumnsBlock | undefined)?.columns[
      place.column
    ];
    return t("siteAdmin.editor.movedIntoColumn", {
      kind,
      number: place.at + 1,
      count: column?.blocks.length ?? 0,
      column: place.column + 1,
      parent: parentAt + 1,
    });
  };

  const remember = (undo: ArrangementUndo, what: string): void => {
    setUndos((current) => [...current.slice(1 - UNDO_DEPTH), { undo, what }]);
  };

  /**
   * Uploads a picture for the block, or the block in a column, with this
   * identity, carrying the declaration made for that identity.
   *
   * The answer is applied by identity to the list as it stands when it
   * arrives, so a block moved or described while the bytes were on their way
   * keeps what was done to it.
   */
  const uploadPicture = (id: string, file: File): void => {
    const shows = declared.has(id);
    void (async () => {
      setBusy(true);
      const result = await uploadSiteImage(file, shows);
      setBusy(false);
      if (!result.ok) {
        setFailure(result.failure);
        return;
      }
      if (result.value.showsIdentifiablePersons) {
        setIdentifiable((current) => new Set([...current, result.value.id]));
      }
      setEntries((current) =>
        withUploadedPicture(current, id, result.value.id),
      );
    })();
  };

  const fields: BlockFieldsContext = {
    pages,
    busy,
    declared,
    declare: (id, shows) => {
      setDeclared((current) => {
        const next = new Set(current);
        if (shows) {
          next.add(id);
        } else {
          next.delete(id);
        }
        return next;
      });
    },
    upload: uploadPicture,
  };

  const blocks = blocksOf(entries);
  const room = Math.max(PAGE_CONTENT_LIMITS.blocks - entries.length, 0);
  const hits = scanPage({ title, blocks });

  /**
   * One act against this page, with the refusals it can answer with handled.
   *
   * The success value is optional because removing a page answers with none,
   * and a delete needs everything else this does: it takes the same
   * precondition as a save, so it is refused the same way and the board has to
   * be told the same thing. Answers whether the act went through, which is what
   * a delete needs in order to close the editor behind itself.
   */
  const run = useCallback(
    async (
      action: () => Promise<
        { ok: true; value?: AdminPage } | { ok: false; failure: ApiFailure }
      >,
    ): Promise<boolean> => {
      setBusy(true);
      setSaved(false);
      setHeldBack(false);
      const result = await action();

      if (!result.ok) {
        setFailure(result.failure);
        if (result.failure.reason === "photo-consent-required") {
          setConsentAsked(true);
        }
        /*
         * Somebody else saved this page while it was open here, so the copy the
         * next save would claim against is gone. Read the page again and hand
         * it up, which moves the revision this editor holds while leaving what
         * the board has written where it is - the component is keyed on the
         * page's id, so a fresh page object does not remount it.
         *
         * That makes the next save possible rather than automatic: it will
         * write over the other version, and the message beside this says so.
         * The alternative - refusing until somebody reloads - loses the board's
         * unsaved work to protect a version they have not seen.
         */
        if (result.failure.reason === "page-changed") {
          const pages = await fetchPages();
          const fresh = pages.ok
            ? pages.value.find((one) => one.id === page.id)
            : undefined;
          if (fresh !== undefined) {
            onChanged(fresh);
          }
        }
        /*
         * Last, so every control stays disabled until the page this editor
         * holds is the one a save would claim against. Cleared before the
         * reload, a second press would send the revision that was just refused
         * and be refused again.
         */
        setBusy(false);
        return false;
      }

      setBusy(false);

      setFailure(null);
      setSaved(true);
      if (result.value !== undefined) {
        onChanged(result.value);
      }
      return true;
    },
    [onChanged, page.id],
  );

  const submittable = submittableBlocks(blocks, registry);
  const body = { blocks: submittable.blocks };
  const consent = consentConfirmed ? { photoConsentConfirmed: true } : {};

  /*
   * The address the page will have once saved, as far as this screen can know
   * it: the one typed, the one a new title gives while the page follows its
   * title, or the one it has. The stored one while the title still gives it,
   * because the server may have numbered it - `styrelsen-2` - and the screen
   * must not show the board an address the page does not have. A new title
   * may be numbered too, once saved, if another page holds its address.
   */
  const address =
    typedSlug ??
    (page.slugFollowsTitle && slugFromTitle(title) !== slugFromTitle(page.title)
      ? slugFromTitle(title)
      : page.slug);
  /*
   * Every address the board typed, the stored one included. Typing it is the
   * choice to keep it: left out, a page that follows its title would take the
   * address its new title gives, which is not the one this screen showed.
   */
  const slugEdit = typedSlug === null ? {} : { slug: typedSlug };

  /**
   * What would be lost by leaving: everything on the screen that differs from
   * what the server holds, as of the last save that went through.
   *
   * Beside the blocks a save would send, the work it would leave out: a
   * picture with no file chosen yet and words written beside it are lost by
   * leaving all the same, and a save that leaves them out must not make
   * leaving them a silent act. A save never holds them, so they stay a reason
   * to ask.
   */
  const snapshot = (known: typeof registry): string =>
    JSON.stringify({
      title,
      slug: typedSlug,
      status: chosenStatus,
      front,
      blocks: submittableBlocks(blocks, known).blocks,
      unfinished: unfinishedWork(blocks, known),
    });
  const pending = snapshot(registry);
  const [savedAs, setSavedAs] = useState(pending);
  /*
   * A stored plugin block is ready until its plugin's declaration arrives and
   * may not be after, so the same page reads differently once the answer is
   * in. The baseline follows it when nothing was edited meanwhile; an edit
   * made in the meantime keeps its own difference.
   */
  const [seenRegistry, setSeenRegistry] = useState(registry);
  if (seenRegistry !== registry) {
    setSeenRegistry(registry);
    if (savedAs === snapshot(seenRegistry)) {
      setSavedAs(pending);
    }
  }
  const unsaved = pending !== savedAs;
  /** Set once the page is deleted, so leaving it asks nothing. */
  const leaving = useRef(false);
  useBlocker({
    shouldBlockFn: () =>
      unsaved &&
      !leaving.current &&
      !window.confirm(t("siteAdmin.editor.leaveConfirm")),
    enableBeforeUnload: () => unsaved && !leaving.current,
  });

  /**
   * The blocks a save sends, by identity, so the ones the board added are
   * marked as stored once it has gone through: from then on, leaving one out
   * of a save would delete it as surely as one that was read with the page.
   */
  const sent = new Set(
    submittable.positions.flatMap((at) => {
      const id = entries[at]?.id;
      return id === undefined ? [] : [id];
    }),
  );
  const markSent = (): void => {
    setEntries((current) => storedAs(current, sent));
    // A block removed before this save is gone from the server too, so one
    // put back afterwards is a block the server does not hold.
    setUndos((current) =>
      current.map((item) =>
        item.undo.kind === "putBack"
          ? {
              ...item,
              undo: {
                ...item.undo,
                entry: { ...item.undo.entry, stored: false },
              },
            }
          : item,
      ),
    );
  };

  /**
   * The serving plugins' blocks that are not ready to send, and the refusal
   * to save while there are any.
   *
   * A stored one whose plugin now asks for a setting it does not hold would
   * have the block left out of the body, which carries the whole page, so the
   * server would delete it and everything set on it. One the board has only
   * just added would be left out too, and the board told "Saved." with the
   * block gone from the page. The board is told which block it is and which
   * settings it lacks; nothing is sent, and the block stays here.
   */
  const unfinished = unfinishedStoredBlocks(entries, registry);
  const lacking = unfinishedPluginBlocks(entries, plugins, registry);
  const holdBack = (): boolean => {
    if (lacking.length === 0) {
      return false;
    }
    setSaved(false);
    setFailure(null);
    setHeldBack(true);
    // Its settings are what the board has to answer, so they are put in view.
    setSelected(entries[lacking[0]?.index ?? -1]?.id ?? null);
    return true;
  };

  /**
   * Saves what is on the screen: the body and the status, in the order that
   * keeps the new words inside the audience the board chose, then the front
   * page, each claiming the revision the one before it produced.
   *
   * The order is the one that never shows anybody words not meant for them. A
   * page opening to more readers - a draft going on the website, a members'
   * page going public - has its body saved first, so the status is set on the
   * words the board is looking at and the guardrails run on those. A page
   * closing to fewer - taken down, or from the street to the members - has its
   * status set first, so the edits saved beside it are never read by the
   * audience it is leaving, even for a moment, and a refused status leaves
   * them unsaved rather than saved where the old audience reads them. The
   * front page is chosen last, because only a page that is already public can
   * be one.
   *
   * Each step that succeeds is handed up before the next is tried, so a step
   * refused on its merits - a personal identity number on the page, a picture
   * nobody has confirmed the consents for - leaves the editor holding the
   * revision the server has, and the next save is not refused as though
   * somebody else had written the page.
   */
  const saveAll = async (): Promise<
    { ok: true; value: AdminPage } | { ok: false; failure: ApiFailure }
  > => {
    let latest = page;
    const saveBody = async () => {
      const stored = await savePage(page.id, {
        ...slugEdit,
        title,
        content: body,
        ...consent,
        expectedRevision: latest.revision,
      });
      if (stored.ok) {
        latest = stored.value;
        setTypedSlug(null);
        markSent();
      }
      return stored;
    };
    const saveStatus = async () => {
      const changed = await setPageStatus(page.id, {
        status,
        ...consent,
        expectedRevision: latest.revision,
      });
      if (changed.ok) {
        latest = changed.value;
        setChosenStatus(null);
      }
      return changed;
    };

    // PAGE_STATUSES runs from the fewest readers to the most.
    const closing =
      PAGE_STATUSES.indexOf(status) < PAGE_STATUSES.indexOf(page.status);
    for (const step of closing
      ? [saveStatus, saveBody]
      : [saveBody, saveStatus]) {
      if (step === saveStatus && latest.status === status) {
        continue;
      }
      if (latest !== page) {
        onChanged(latest);
      }
      const result = await step();
      if (!result.ok) {
        return result;
      }
    }

    if (front && !latest.frontPage) {
      onChanged(latest);
      const chosen = await setFrontPage(page.id, {
        expectedRevision: latest.revision,
      });
      if (!chosen.ok) {
        return chosen;
      }
      latest = chosen.value;
      setMakeFront(false);
    }
    // What the server now holds is what was on the screen when this began.
    setSavedAs(
      JSON.stringify({
        title,
        slug: null,
        status: null,
        front: false,
        blocks: body.blocks,
        unfinished: [],
      }),
    );
    return { ok: true, value: latest };
  };

  /**
   * The places a refusal named, as a person reads them.
   *
   * The API answers with positions - the title, or a block's index - because a
   * response body may never carry the value that was refused. One-based here,
   * because the board is looking at a list of blocks and not at an array.
   *
   * Mapped back through the positions that were sent, because the half-written
   * blocks this screen leaves out of a submission are still on the screen: the
   * API's third block can be the board's fourth, and a notice naming the wrong
   * one sends somebody to edit a paragraph that is not the problem. It is also
   * what keeps this notice and the personal-identity-number warning above
   * agreeing about the same page.
   */
  const refusedPlaces =
    failure === null
      ? []
      : locationsOf(failure).map((place) =>
          place === "title"
            ? t("siteAdmin.editor.placeTitle")
            : t("siteAdmin.editor.placeBlock", {
                number: (submittable.positions[place] ?? place) + 1,
              }),
        );

  const askConsent = consentAsked || needsPhotoConsent(blocks, identifiable);

  /*
   * The arrangement: adding, removing, duplicating and moving blocks, each
   * said out loud and each one change that Undo takes back.
   */

  const { pageChoices, columnChoices } = useMemo(() => {
    const choice = (type: string): InserterChoice | undefined => {
      const definition = PAGE_BLOCKS.definition(type);
      if (definition !== undefined) {
        return {
          type,
          label: t(definition.editor.label),
          icon: definition.editor.icon,
          category: definition.editor.category,
        };
      }
      const plugin = plugins.find((declaration) => declaration.type === type);
      return plugin === undefined
        ? undefined
        : {
            type,
            label: translatePlugin(plugin.pluginId, plugin.labelKey),
            icon: plugin.icon,
            category: plugin.category,
          };
    };
    return {
      pageChoices: [
        ...INSERTABLE,
        ...plugins.map((declaration) => declaration.type),
      ].flatMap((type) => choice(type) ?? []),
      columnChoices: NESTED_BLOCKS.flatMap(
        (definition) => choice(definition.type) ?? [],
      ),
    };
    // The plugins' words arriving is a change of what the labels say.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugins, t, translatePlugin, pluginWords]);

  const insert = (place: BlockPlace, type: string): void => {
    const plugin = plugins.find((declaration) => declaration.type === type);
    const entry =
      plugin === undefined
        ? newEditorBlock(type as InsertableBlock)
        : newPluginBlock(plugin);
    if (!mayStandAt(entries, entry.block, place)) {
      return;
    }
    const next = putIn(entries, place, entry);
    setEntries(next);
    const kind = kindOf(entry.block);
    remember(
      { kind: "takeOut", id: entry.id },
      t("siteAdmin.editor.undo.added", { kind }),
    );
    setSelected(entry.id);
    setMoved({
      key: `content:${entry.id}`,
      announcement: t("siteAdmin.editor.added", {
        where: whereIs(next, entry.id),
      }),
    });
  };

  const remove = (id: string): void => {
    const out = takeOut(entries, id);
    if (out === undefined) {
      return;
    }
    const kind = kindOf(out.taken.block);
    setEntries(out.entries);
    remember(
      { kind: "putBack", entry: out.taken, place: out.from },
      t("siteAdmin.editor.undo.removed", { kind }),
    );
    /*
     * The block's tools are gone with it, and the focus with them: it goes to
     * the next block's handle in the same list, else the previous one's, else
     * the + that adds a block where it stood.
     */
    let neighbour: string | undefined;
    let fallback: string;
    let announcement: string;
    if (out.from.list === "page") {
      neighbour = (entries[out.from.at + 1] ?? entries[out.from.at - 1])?.id;
      fallback = "add";
      announcement = t("siteAdmin.editor.blockRemoved", {
        kind,
        number: out.from.at + 1,
        count: out.entries.length,
      });
    } else {
      const from = out.from;
      const parent = entries.find((one) => one.id === from.parent);
      const ids = parent?.nested?.[from.column] ?? [];
      neighbour = ids[from.at + 1] ?? ids[from.at - 1];
      fallback = `${from.parent}:${String(from.column)}:add`;
      announcement = t("siteAdmin.editor.columnBlockRemoved", {
        kind,
        number: from.at + 1,
        column: from.column + 1,
        count: Math.max(ids.length - 1, 0),
      });
    }
    setSelected(neighbour ?? null);
    setMoved({
      key: neighbour === undefined ? fallback : `${neighbour}:handle`,
      announcement: `${announcement} ${t("siteAdmin.editor.undoHint")}`,
    });
  };

  const duplicate = (id: string): void => {
    const original = entryOf(entries, id);
    const result = duplicateBlock(entries, id);
    if (original === undefined) {
      return;
    }
    const kind = kindOf(original.block);
    if (result === undefined) {
      setMoved({
        key: null,
        announcement: t("siteAdmin.editor.noRoom", { kind }),
      });
      return;
    }
    setEntries(result.entries);
    remember(
      { kind: "takeOut", id: result.id },
      t("siteAdmin.editor.undo.duplicated", { kind }),
    );
    setSelected(result.id);
    setMoved({
      key: `${result.id}:handle`,
      announcement: t("siteAdmin.editor.duplicated", {
        kind,
        where: whereIs(result.entries, result.id),
      }),
    });
  };

  /** Moves a block one step within the list it stands in. */
  const step = (id: string, direction: -1 | 1): void => {
    const place = placeOf(entries, id);
    const entry = entryOf(entries, id);
    if (place === undefined || entry === undefined) {
      return;
    }
    let next: EditorBlock[];
    if (place.list === "page") {
      next = moveBlock(entries, place.at, direction);
    } else {
      next = entries.map((entry) =>
        entry.id === place.parent
          ? moveInColumn(entry, place.column, place.at, direction)
          : entry,
      );
    }
    setEntries(next);
    if (placeOf(next, id)?.at !== place.at) {
      remember(
        { kind: "moveBack", id, place },
        t("siteAdmin.editor.undo.moved", { kind: kindOf(entry.block) }),
      );
    }
    setMoved({
      key: `${id}:${String(direction)}`,
      announcement: whereIs(next, id),
    });
  };

  /*
   * Moving a block from the keyboard, from its drag handle: Enter or Space
   * picks it up, the arrow keys move it through every place it could be
   * dropped - the page's gaps and, for a block that may sit in one, each
   * column's - Enter or Space puts it down, and Escape puts it back. Each step
   * is said where it lands, so a person who cannot see the page hears it.
   */
  const putDown = (
    all: readonly EditorBlock[],
    id: string,
    from: BlockPlace,
  ): void => {
    setLifted(null);
    const entry = entryOf(all, id);
    const out = takeOut(all, id);
    if (entry === undefined || out === undefined) {
      return;
    }
    const kind = kindOf(entry.block);
    if (JSON.stringify(out.from) !== JSON.stringify(from)) {
      remember(
        { kind: "moveBack", id, place: from },
        t("siteAdmin.editor.undo.moved", { kind }),
      );
    }
    setMoved({
      key: null,
      announcement: `${t("siteAdmin.editor.putDown", { kind })} ${whereIs(all, id)}`,
    });
  };

  const handleKey = (
    id: string,
    event: KeyboardEvent<HTMLButtonElement>,
  ): void => {
    const pickKey = event.key === "Enter" || event.key === " ";
    const entry = entryOf(entries, id);
    if (entry === undefined) {
      return;
    }
    const kind = kindOf(entry.block);

    if (lifted?.id !== id) {
      if (!pickKey) {
        return;
      }
      event.preventDefault();
      const from = takeOut(entries, id)?.from;
      if (from === undefined) {
        return;
      }
      setLifted({ id, from });
      setSelected(id);
      setMoved({
        key: null,
        announcement: `${t("siteAdmin.editor.pickedUp", { kind })} ${whereIs(entries, id)}`,
      });
      return;
    }

    if (pickKey) {
      event.preventDefault();
      putDown(entries, id, lifted.from);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      const back = moveTo(entries, id, lifted.from);
      setEntries(back);
      setLifted(null);
      setMoved({
        key: `${id}:handle`,
        announcement: `${t("siteAdmin.editor.moveCancelled", { kind })} ${whereIs(back, id)}`,
      });
      return;
    }
    const direction =
      event.key === "ArrowUp" || event.key === "ArrowLeft"
        ? -1
        : event.key === "ArrowDown" || event.key === "ArrowRight"
          ? 1
          : 0;
    if (direction === 0) {
      return;
    }
    event.preventDefault();
    const { places, current } = placesFor(entries, id);
    const target = places[current + direction];
    if (target === undefined) {
      setMoved({
        key: `${id}:handle`,
        announcement: t("siteAdmin.editor.noFurther", { kind }),
      });
      return;
    }
    const next = moveTo(entries, id, target);
    setEntries(next);
    setMoved({ key: `${id}:handle`, announcement: whereIs(next, id) });
  };

  /*
   * A block picked up from the keyboard is put down where it is once the
   * focus goes anywhere but its own handle - a Tab onwards, a click elsewhere
   * - so the page is never left with a block in the air.
   */
  const latest = useRef({ entries, lifted, putDown });
  useEffect(() => {
    latest.current = { entries, lifted, putDown };
  });
  useEffect(() => {
    if (lifted === null) {
      return;
    }
    const onFocus = (event: FocusEvent): void => {
      const target = event.target as Element | null;
      const now = latest.current.lifted;
      if (
        now === null ||
        target?.closest?.(`[data-canvas-handle="${now.id}"]`) != null
      ) {
        return;
      }
      latest.current.putDown(latest.current.entries, now.id, now.from);
    };
    document.addEventListener("focusin", onFocus);
    return () => {
      document.removeEventListener("focusin", onFocus);
    };
  }, [lifted]);

  /** A paragraph's editor reported what it holds, on the page or in a column. */
  const writeParagraph = (
    id: string,
    paragraphs: TextRun[][],
    caret: Caret,
  ): void => {
    const place = placeOf(entries, id);
    if (place === undefined) {
      return;
    }
    const [first = [], ...rest] = paragraphs;

    if (place.list === "column") {
      // A change that was kept ends the notice, unless it is the paste that
      // cut text, which it then follows.
      const held = heldLong.current;
      heldLong.current = [];
      if (rest.length === 0) {
        setLongAt(held.includes(0) ? [id] : []);
        setEntries((current) =>
          updateBlock(current, id, { type: "paragraph", runs: first }),
        );
        return;
      }
      const parent = entries.find((one) => one.id === place.parent);
      if (parent === undefined) {
        return;
      }
      const result = replaceInColumnWith(
        parent,
        place.column,
        place.at,
        paragraphs.map((runs) => ({ type: "paragraph" as const, runs })),
      );
      setEntries((current) =>
        current.map((one) => (one.id === parent.id ? result.entry : one)),
      );
      setLongAt(
        held.flatMap((block) => {
          const one = block === 0 ? id : result.added[block - 1];
          return one === undefined ? [] : [one];
        }),
      );
      const target = result.added[caret.paragraph - 1];
      if (target !== undefined) {
        setSplitFocus({ id: target, offset: caret.offset });
        setSelected(target);
      }
      return;
    }

    /*
     * The block keeps its identity whether this was typing or a return,
     * because a new one remounts the editor being typed into and the keyboard
     * focus falls to the page. On a return the editor cuts its own document
     * back to the first paragraph, the rest become blocks of their own, and
     * the one the caret went to takes the focus as it is created.
     */
    const entry = entries[place.at];
    if (entry === undefined) {
      return;
    }
    const added = rest.map((runs) => newBlockWith({ type: "paragraph", runs }));
    setEntries((current) => {
      const at = current.findIndex((one) => one.id === id);
      const now = current[at];
      return now === undefined
        ? current
        : replaceBlockWith(current, at, [
            withBlock(now, { type: "paragraph", runs: first }),
            ...added,
          ]);
    });
    // A change that was kept ends the notice, unless it is the paste that cut
    // text, which it then follows.
    const cut = heldLong.current.flatMap((block) => {
      const one = block === 0 ? id : added[block - 1]?.id;
      return one === undefined ? [] : [one];
    });
    heldLong.current = [];
    setLongAt(cut);
    const target = added[caret.paragraph - 1];
    if (target !== undefined) {
      setSplitFocus({ id: target.id, offset: caret.offset });
      setSelected(target.id);
    }
  };

  /*
   * What the blocks on the page read, held where each reads only its own part
   * (canvas-context.ts). Set as this render runs, so a block drawn in it reads
   * the state it is drawn with - a paragraph a return has just split off reads
   * where its caret goes - and told to the blocks that were not drawn once it
   * is committed.
   */
  const canvasState: CanvasState = {
    entries,
    registry,
    plugins,
    pluginsKnown,
    selected,
    lifted: lifted?.id ?? null,
    dragging,
    dropAt,
    room,
    pageChoices,
    columnChoices,
    unfinished,
    splitFocus,
    longAt,
    heldAt,
    kindOf,
  };
  const [store] = useState(() => createCanvasStore(canvasState));
  store.set(canvasState);
  useLayoutEffect(() => {
    store.emit();
  });

  /*
   * What the blocks ask for, as functions that never change and call this
   * render's own: a block holding on to one never acts on a page that has
   * since changed.
   */
  const latestActions = useRef<Omit<
    CanvasActions,
    "instructionsId" | "control"
  > | null>(null);
  const thisRender: NonNullable<typeof latestActions.current> = {
    select: setSelected,
    update: (id, block) => {
      setEntries((current) => updateBlock(current, id, block));
    },
    updateEntry: (id, entry) => {
      setEntries((current) =>
        current.map((one) => (one.id === id ? entry : one)),
      );
    },
    entry: (id) => entryOf(entries, id),
    writeParagraph,
    focusSplit: (id, offset) => {
      setSplitFocus({ id, offset });
    },
    heldLong: (id, blocks, refused) => {
      // A refusal is followed by no change to clear it at.
      heldLong.current = refused === true ? [] : blocks;
      setLongAt(blocks.includes(0) ? [id] : []);
    },
    heldFull: setHeldAt,
    insert,
    remove,
    duplicate,
    step,
    handleKey,
  };
  useLayoutEffect(() => {
    latestActions.current = thisRender;
  });
  const actions = useMemo<CanvasActions>(() => {
    const latest = () => {
      const current = latestActions.current;
      if (current === null) {
        throw new Error("The page editor acted before it was drawn");
      }
      return current;
    };
    return {
      instructionsId,
      control,
      select: (id) => {
        latest().select(id);
      },
      update: (id, block) => {
        latest().update(id, block);
      },
      updateEntry: (id, entry) => {
        latest().updateEntry(id, entry);
      },
      entry: (id) => latest().entry(id),
      writeParagraph: (id, paragraphs, caret) => {
        latest().writeParagraph(id, paragraphs, caret);
      },
      focusSplit: (id, offset) => {
        latest().focusSplit(id, offset);
      },
      heldLong: (id, blocks, refused) => {
        latest().heldLong(id, blocks, refused);
      },
      heldFull: (id) => {
        latest().heldFull(id);
      },
      insert: (place, type) => {
        latest().insert(place, type);
      },
      remove: (id) => {
        latest().remove(id);
      },
      duplicate: (id) => {
        latest().duplicate(id);
      },
      step: (id, direction) => {
        latest().step(id, direction);
      },
      handleKey: (id, event) => {
        latest().handleKey(id, event);
      },
    };
  }, [instructionsId, control]);

  const selectedEntry =
    selected === null ? undefined : entryOf(entries, selected);
  const selectedPlace =
    selected === null ? undefined : placeOf(entries, selected);
  const last = undos.at(-1);

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-2">
        <h1 className="text-display">{t("siteAdmin.editor.heading")}</h1>
        <p className="max-w-2xl text-body text-ink-muted">
          {t("siteAdmin.editor.description")}
        </p>
      </header>

      {/*
       * The page's state and the two things done to all of it, kept in sight
       * while the page scrolls under them.
       */}
      <div className="sticky top-0 z-40 -mx-1 flex flex-wrap items-center gap-3 border-b border-line bg-page px-1 py-3">
        <span className="text-small text-ink">
          {t(PAGE_STATUS_LABELS[page.status])}
          {page.frontPage ? ` · ${t("siteAdmin.state.frontPage")}` : ""}
        </span>
        {unsaved ? (
          <span className="text-small text-ink-muted">
            {t("siteAdmin.editor.unsaved")}
          </span>
        ) : null}
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={`${SECONDARY_BUTTON} gap-2`}
            disabled={last === undefined}
            aria-label={
              last === undefined
                ? t("siteAdmin.editor.undo.label")
                : t("siteAdmin.editor.undo.named", { what: last.what })
            }
            title={last?.what}
            onClick={() => {
              if (last === undefined) {
                return;
              }
              const next = undoArrangement(entries, last.undo);
              setEntries(next);
              setUndos((current) => current.slice(0, -1));
              const id =
                last.undo.kind === "putBack"
                  ? last.undo.entry.id
                  : last.undo.id;
              const back = placeOf(next, id) !== undefined;
              setSelected(back ? id : null);
              setMoved({
                key: back ? `${id}:handle` : null,
                announcement: t("siteAdmin.editor.undo.done", {
                  what: last.what,
                }),
              });
            }}
          >
            <EditorIcon name="undo" />
            {t("siteAdmin.editor.undo.label")}
          </button>
          <button
            type="button"
            className={PRIMARY_BUTTON}
            disabled={busy}
            onClick={() => {
              if (holdBack()) {
                return;
              }
              void run(saveAll);
            }}
          >
            {t("siteAdmin.editor.save")}
          </button>
        </span>
      </div>

      <div className="flex flex-col gap-3">
        <Notice tone="info">{t("siteAdmin.editor.freeTextWarning")}</Notice>
        {hits.length === 0 ? null : (
          <Notice tone="warn" live>
            {t("siteAdmin.editor.scanWarning", {
              places: hits
                .map((hit) =>
                  hit.block === null
                    ? t("siteAdmin.editor.placeTitle")
                    : t("siteAdmin.editor.placeBlock", {
                        number: hit.block + 1,
                      }),
                )
                .join(", "),
            })}
          </Notice>
        )}
        {heldBack && lacking.length > 0 ? (
          <Notice tone="danger" live>
            {t("siteAdmin.editor.pluginBlockLacks", {
              places: lacking
                .map(({ index, declaration, missing }) =>
                  t("siteAdmin.editor.pluginBlockLacksAt", {
                    place: t("siteAdmin.editor.placeBlock", {
                      number: index + 1,
                    }),
                    settings: missing
                      .map((field) =>
                        translatePlugin(declaration.pluginId, field.labelKey),
                      )
                      .join(", "),
                  }),
                )
                .join("; "),
            })}
          </Notice>
        ) : null}
        {failure === null ? null : (
          <Notice tone="danger" live>
            {t(pageFailureKey(failure), {
              count: PAGE_CONTENT_LIMITS.runText,
            })}
            {refusedPlaces.length === 0
              ? null
              : ` ${t("siteAdmin.editor.refusedAt", {
                  places: refusedPlaces.join(", "),
                })}`}
          </Notice>
        )}
        {saved ? (
          <Notice tone="ok" live>
            {t("siteAdmin.editor.saved")}
          </Notice>
        ) : null}
        {askConsent ? (
          <label className="flex min-h-11 items-start gap-3 text-small text-ink">
            <input
              type="checkbox"
              checked={consentConfirmed}
              onChange={(event) => {
                setConsentConfirmed(event.target.checked);
              }}
              className="mt-1 size-4 accent-trust"
            />
            {t("siteAdmin.editor.photoConsent")}
          </label>
        ) : null}
      </div>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <EditorCanvas
          state={canvasState}
          store={store}
          actions={actions}
          title={title}
          onTitle={setTitle}
          onDragStart={(id) => {
            setDragging(id);
            setSelected(id);
          }}
          onDragOver={(id, target) => {
            const next =
              target === null ? null : resolveDrop(entries, id, target);
            const shown = next?.target ?? null;
            if (JSON.stringify(shown) !== JSON.stringify(dropAt)) {
              setDropAt(shown);
            }
          }}
          onDrop={(id, target) => {
            setDragging(null);
            setDropAt(null);
            const next =
              target === null ? null : resolveDrop(entries, id, target);
            const from = takeOut(entries, id)?.from;
            const entry = entryOf(entries, id);
            if (next === null || from === undefined || entry === undefined) {
              return;
            }
            const moved = moveTo(entries, id, next.place);
            setEntries(moved);
            const kind = kindOf(entry.block);
            remember(
              { kind: "moveBack", id, place: from },
              t("siteAdmin.editor.undo.moved", { kind }),
            );
            setMoved({
              key: `${id}:handle`,
              announcement: `${t("siteAdmin.editor.putDown", { kind })} ${whereIs(moved, id)}`,
            });
          }}
          onDragCancel={() => {
            setDragging(null);
            setDropAt(null);
          }}
        />

        <aside
          aria-label={t("siteAdmin.editor.settingsLabel")}
          className="flex flex-col gap-5 lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto"
        >
          <BlockSettings
            entry={selectedEntry}
            kind={
              selectedEntry === undefined ? "" : kindOf(selectedEntry.block)
            }
            nested={selectedPlace?.list === "column"}
            registry={registry}
            plugins={plugins}
            pluginsKnown={pluginsKnown}
            unfinished={
              selectedPlace?.list === "page" &&
              unfinished.includes(selectedPlace.at)
            }
            context={fields}
            onBlock={(block) => {
              if (selected !== null) {
                actions.update(selected, block);
              }
            }}
            onEntry={(entry) => {
              actions.updateEntry(entry.id, entry);
            }}
          />
          <PageSettings
            page={page}
            status={status}
            onStatus={(option) => {
              setChosenStatus(option);
              if (option !== "PUBLIC") {
                setMakeFront(false);
              }
            }}
            front={front}
            onFront={setMakeFront}
            address={address}
            onAddress={setTypedSlug}
            busy={busy}
            onDelete={() => {
              /*
               * Confirmed because the page goes with the row: the API deletes
               * it outright, and nothing on this screen puts a deleted page
               * back. The same reason the archive asks before removing a
               * document.
               */
              if (
                !window.confirm(
                  t("siteAdmin.editor.removeConfirm", { title: page.title }),
                )
              ) {
                return;
              }
              void (async () => {
                /*
                 * Through `run` like every other act on this page, so a
                 * refusal is named rather than shown as a bare failure. What
                 * it adds here is the page-changed path: a deletion decided on
                 * a copy somebody else has rewritten is refused, the page is
                 * read again, and the board sees what it would have been
                 * deleting before deciding a second time.
                 */
                const removed = await run(async () => {
                  const result = await deletePage(page.id, {
                    expectedRevision: page.revision,
                  });
                  return result.ok ? { ok: true as const } : result;
                });
                if (removed) {
                  leaving.current = true;
                  onRemoved(page.id);
                }
              })();
            }}
          />
        </aside>
      </div>

      <p className="sr-only" role="status">
        {moved?.announcement}
      </p>
    </div>
  );
}

/**
 * The sentence for a refusal.
 *
 * A body the schema refused is named by the field it refused. The page's own
 * title and address are theirs to correct; a link is about a link; and only a
 * run of text past the length a block holds is about paragraphs. Anything else
 * the schema refuses gets the general sentence, because pointing the board at a
 * field it did not write sends them looking in the wrong place.
 *
 * Exported for the built-in page's panel, whose one field is the title and
 * whose refusals are this screen's.
 */
export function pageFailureKey(failure: ApiFailure): TranslationKey {
  const fields = refusedFields(failure);
  if (fields.includes("title")) {
    return "siteAdmin.errors.invalidTitle";
  }
  if (fields.includes("slug")) {
    return "siteAdmin.errors.invalidSlug";
  }
  // A picture with no description, a banner with no heading and a button
  // with nowhere to go: the refusals a banner, a picture beside text and a
  // button can be given that the board fixes in one field each.
  if (fields.some((field) => /(?:^|\.)alt$/.test(field))) {
    return "siteAdmin.errors.altRequired";
  }
  if (fields.some((field) => /(?:^|\.)blocks\.heading$/.test(field))) {
    return "siteAdmin.errors.bannerHeading";
  }
  if (fields.some((field) => /\.target(?:\.(?:pageId|url))?$/.test(field))) {
    return "siteAdmin.errors.buttonTarget";
  }
  if (
    fields.some((field) => /(?:^|\.)runs\.text$/.test(field)) &&
    !fields.some((field) => field.endsWith(".link"))
  ) {
    return "siteAdmin.errors.tooLong";
  }
  return failureMessageKey(failure, REASONS, "siteAdmin.errors.unknown");
}

/**
 * The positions a refusal named: the page's title, or a block's index.
 *
 * A screening refusal names them as parts; a schema refusal names the path of
 * each field it refused, which for a block starts with its index.
 */
function locationsOf(failure: ApiFailure): ("title" | number)[] {
  const detail = failure.detail;
  if (!Array.isArray(detail)) {
    return [];
  }
  const places = detail.flatMap((entry): ("title" | number)[] => {
    if (typeof entry !== "object" || entry === null) {
      return [];
    }
    const { part, index, path } = entry as {
      part?: unknown;
      index?: unknown;
      path?: unknown;
    };
    if (part === "title") {
      return ["title"];
    }
    if (typeof path === "string") {
      const block = /(?:^|\.)blocks\.(\d+)(?:\.|$)/.exec(path)?.[1];
      return block === undefined ? [] : [Number(block)];
    }
    return typeof index === "number" ? [index] : [];
  });
  return [...new Set(places)];
}
