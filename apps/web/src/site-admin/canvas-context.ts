import type { PluginBlockDeclaration } from "@openbrf/shared";
import { createContext, useContext, useSyncExternalStore } from "react";
import type { KeyboardEvent } from "react";

import type { PageBlock, TextRun } from "../api/site";
import type { BlockPlace, DropTarget } from "./block-tree";
import type { InserterChoice } from "./BlockInserter";
import type { EditorBlock, EditorRegistry } from "./page-blocks";
import type { Caret } from "./RichText";

/**
 * What the blocks drawn on the page share with the editor around them.
 *
 * Two halves. What a block asks the editor to do is a set of functions that
 * never change, so handing them down never makes a block draw itself again.
 * What a block shows of the page's state - whether it is selected, picked up
 * or where a drag would land, whether its paragraph was held at its length -
 * is read from a store, each block reading only its own part of it. A page
 * of two hundred blocks then redraws the one being typed in, and not the two
 * hundred, on every key.
 */

/** The page's state, as the blocks drawn on it read it. */
export interface CanvasState {
  entries: readonly EditorBlock[];
  registry: EditorRegistry;
  plugins: readonly PluginBlockDeclaration[];
  pluginsKnown: "loading" | "failed" | "known";
  /** The block whose tools and settings are shown. */
  selected: string | null;
  /** The block being moved from the keyboard. */
  lifted: string | null;
  /** The block being dragged with a pointer, and where it would land. */
  dragging: string | null;
  dropAt: DropTarget | null;
  /** How many more blocks the page itself has room for. */
  room: number;
  /** The blocks the + offers on the page, and in a column. */
  pageChoices: readonly InserterChoice[];
  columnChoices: readonly InserterChoice[];
  /** The positions of stored plugins' blocks that are no longer ready. */
  unfinished: readonly number[];
  /** The paragraph a return has just split off, and where its caret goes. */
  splitFocus: { id: string; offset: number } | null;
  /** The paragraphs typing or a paste was held in because they were full. */
  longAt: readonly string[];
  /** The paragraph a return or a paste was held in on a full page. */
  heldAt: string | null;
  /** The block's name in the board's language. */
  kindOf: (block: PageBlock) => string;
}

/** What a block asks the editor to do. The same functions for the editor's life. */
export interface CanvasActions {
  /** The element that says how a block is moved from the keyboard. */
  instructionsId: string;
  select: (id: string) => void;
  /** Writes a block's new content, wherever it stands. */
  update: (id: string, block: PageBlock) => void;
  /** Replaces a whole entry, for a block that holds a list of its own. */
  updateEntry: (id: string, entry: EditorBlock) => void;
  /** The entry with this identity as the page holds it now. */
  entry: (id: string) => EditorBlock | undefined;
  /** A paragraph on the page or in a column, as its editor reported it. */
  writeParagraph: (id: string, paragraphs: TextRun[][], caret: Caret) => void;
  /** Puts the caret in the paragraph a return has just split off. */
  focusSplit: (id: string, offset: number) => void;
  /** Typing or a paste was held to a paragraph's length. */
  heldLong: (id: string, blocks: readonly number[], refused?: boolean) => void;
  /** A return or a paste was held on a page with no room for a block. */
  heldFull: (id: string) => void;
  insert: (place: BlockPlace, type: string) => void;
  remove: (id: string) => void;
  duplicate: (id: string) => void;
  /** Moves a block one step within the list it is in. */
  step: (id: string, direction: -1 | 1) => void;
  /** The drag handle's keys: picking a block up and moving it. */
  handleKey: (id: string, event: KeyboardEvent<HTMLButtonElement>) => void;
  /** Hands a control its place, so the focus can be put back on it. */
  control: (key: string) => (element: HTMLElement | null) => void;
}

/**
 * The page's state, held where the blocks can each read their part of it.
 *
 * Set and told apart: the editor sets the state as it renders, so a block
 * drawn in the same render reads the state it is drawn with, and tells the
 * blocks once the render is committed, so those that were not drawn read
 * theirs and are drawn again if it changed.
 */
export interface CanvasStore {
  get: () => CanvasState;
  set: (state: CanvasState) => void;
  emit: () => void;
  subscribe: (listener: () => void) => () => void;
}

export function createCanvasStore(initial: CanvasState): CanvasStore {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set: (next) => {
      state = next;
    },
    emit: () => {
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const CanvasActionsContext = createContext<CanvasActions | null>(null);
export const CanvasStoreContext = createContext<CanvasStore | null>(null);

export function useCanvasActions(): CanvasActions {
  const actions = useContext(CanvasActionsContext);
  if (actions === null) {
    throw new Error("A block on the page is drawn outside the page editor");
  }
  return actions;
}

/**
 * One part of the page's state, read so the block redraws only when that part
 * changes. The part has to be a value or a reference the state already holds,
 * never an object made here: a new one on every read would be a change on
 * every read.
 */
export function useCanvasState<T>(select: (state: CanvasState) => T): T {
  const store = useContext(CanvasStoreContext);
  if (store === null) {
    throw new Error("A block on the page is drawn outside the page editor");
  }
  return useSyncExternalStore(store.subscribe, () => select(store.get()));
}
