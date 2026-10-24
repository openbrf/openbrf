import type {
  AudienceKind,
  AudienceListView,
  FeedPage,
  FeedUpdate,
  PostView,
} from "@openbrf/shared";

import type { Viewer } from "./instance";

/**
 * The resident preview (ADR 0049): the application as a resident sees it, for
 * somebody who sees more.
 *
 * A board member reads the house's pages the way everybody who lives here does
 * only by asking somebody else what they see, so the client can narrow what it
 * offers to a resident's and a member's grants instead. Presentation only: the
 * server answers every request on the account's own capabilities, the preview
 * is never sent to it, and nothing here may be read as a grant or a denial.
 *
 * The state lives in this module rather than in a component, because the place
 * it bites is {@link fetchViewer}, which every screen calls for itself: each of
 * them then reads the narrowed list without knowing a preview exists. The tab's
 * session storage keeps it across a reload of the page and forgets it with the
 * tab; the server and the device's other storage never see it.
 */

/**
 * What a resident and a member are granted: the client's copy of the server's
 * `RESIDENT_CAPABILITIES` and `MEMBER_CAPABILITIES`
 * (`apps/api/src/authorization/capabilities.ts`).
 *
 * A copy, like every capability string a screen asks about, because the web
 * application reaches the API over HTTP only. `capabilities.spec.ts` in the API
 * reads this list from its source and compares it with what `capabilitiesFor`
 * grants a resident who is a member, so a grant added on one side and not the
 * other fails there; spec 49 compares what the preview offers with what a
 * member is offered.
 */
export const RESIDENT_PREVIEW_CAPABILITIES: readonly string[] = [
  "self:manage",
  "residentDirectory:read",
  "issues:report",
  "news:comment",
  "bookings:book",
  "events:attend",
  "keyOrders:place",
  "chat:participate",
  "motions:submit",
  "sublets:apply",
];

/** Held by every account, so it says nothing about living here. */
const OWN_ACCOUNT = "self:manage";

/**
 * Whether an account with these capabilities is offered the preview.
 *
 * It sees more than a resident, and it holds something a resident holds beyond
 * its own account, so the preview has a resident's application to show. The
 * external property manager holds the issue queue and their own account and
 * nothing a resident does, and is never offered it; a resident has nothing
 * more to take away.
 *
 * The capabilities say nothing about where somebody lives, so this is not
 * "lives here": a board member without a home here is offered it as well, and
 * the administrator, whose grant holds every grantable capability. What either
 * of them sees is still exactly a resident's offer.
 */
export function offersResidentPreview(
  capabilities: readonly string[],
): boolean {
  return (
    capabilities.some(
      (capability) => !RESIDENT_PREVIEW_CAPABILITIES.includes(capability),
    ) &&
    capabilities.some(
      (capability) =>
        capability !== OWN_ACCOUNT &&
        RESIDENT_PREVIEW_CAPABILITIES.includes(capability),
    )
  );
}

/** The viewer with only the capabilities a resident and a member are granted. */
export function previewed(viewer: Viewer): Viewer {
  return {
    ...viewer,
    capabilities: viewer.capabilities.filter((capability) =>
      RESIDENT_PREVIEW_CAPABILITIES.includes(capability),
    ),
  };
}

/** Where the preview stands. A new object on every change, never mutated. */
export interface ResidentPreview {
  /** Whether the application is shown as a resident sees it. */
  on: boolean;
  /**
   * Whether the signed-in account is offered the preview, once its viewer has
   * been read; false until then.
   */
  offered: boolean;
  /**
   * The page that ended the preview by being one of the board's, while the
   * reader is still on it; null otherwise.
   */
  endedOn: string | null;
  /**
   * Counts the times the preview was switched from the band. The screens read
   * the viewer once, when they mount, so the frame mounts them again under a
   * new count and they read it as the preview now has it.
   */
  generation: number;
}

/** The tab's session storage key, and the one value it is ever set to. */
const STORAGE_KEY = "openbrf.preview";
const RESIDENT = "resident";

/**
 * Storage may be refused - a browser in a private mode, a sandboxed frame - and
 * the preview then lasts until the page is reloaded rather than failing.
 */
function stored(): boolean {
  try {
    return globalThis.sessionStorage?.getItem(STORAGE_KEY) === RESIDENT;
  } catch {
    return false;
  }
}

function store(on: boolean): void {
  try {
    if (on) {
      globalThis.sessionStorage?.setItem(STORAGE_KEY, RESIDENT);
    } else {
      globalThis.sessionStorage?.removeItem(STORAGE_KEY);
    }
  } catch {
    // As above: the state in memory is still right for this page.
  }
}

let state: ResidentPreview = {
  on: stored(),
  offered: false,
  endedOn: null,
  generation: 0,
};
const listeners = new Set<() => void>();

function update(next: Partial<ResidentPreview>): void {
  const changed = (Object.keys(next) as (keyof ResidentPreview)[]).some(
    (key) => next[key] !== state[key],
  );
  if (!changed) {
    return;
  }
  if (next.on !== undefined && next.on !== state.on) {
    store(next.on);
  }
  state = { ...state, ...next };
  for (const listener of listeners) {
    listener();
  }
}

/** The preview as it stands, for `useSyncExternalStore`. */
export function residentPreview(): ResidentPreview {
  return state;
}

/** Calls the listener on every change; returns how to stop. */
export function subscribeToResidentPreview(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Switches the preview on or off from the band or the sheet.
 *
 * `remount` false leaves the page as it is, for a switch that navigates
 * anyway: the next page mounts and reads the viewer for itself.
 */
export function setResidentPreview(
  on: boolean,
  { remount = true }: { remount?: boolean } = {},
): void {
  if (on === state.on) {
    return;
  }
  update({
    on,
    endedOn: null,
    generation: remount ? state.generation + 1 : state.generation,
  });
}

/**
 * Ends the preview because the page at this path is one of the board's, and
 * remembers the page so it can say why.
 *
 * Nothing is mounted again: the board's page is mounting anyway, and reads the
 * viewer after this.
 */
export function endResidentPreviewOn(pathname: string): void {
  if (state.on) {
    update({ on: false, endedOn: pathname });
  }
}

/** Forgets why the preview ended, once the reader has left that page. */
export function leftPageAfterResidentPreview(pathname: string): void {
  if (state.endedOn !== null && state.endedOn !== pathname) {
    update({ endedOn: null });
  }
}

/** Ends the preview and forgets the account it was offered to, for a sign-in. */
export function forgetResidentPreview(): void {
  update({ on: false, offered: false, endedOn: null });
}

/**
 * The viewer as the screens are to see it.
 *
 * Records whether this account is offered the preview, and narrows the viewer
 * while the preview is on for an account that is. A preview left on in the tab
 * by an account that is no longer the one signed in, and that this one is not
 * offered, is switched off rather than applied: nobody could see that it was on,
 * and nothing would say why the page had less on it.
 */
export function asPreviewed(viewer: Viewer): Viewer {
  const offered = offersResidentPreview(viewer.capabilities);
  update(offered ? { offered } : { offered, on: false });
  return state.on ? previewed(viewer) : viewer;
}

/**
 * The audiences a resident is in: Alla and the groups they are written into.
 * Styrelsen and Administratörer are the board's, so a preview leaves them out.
 */
const RESIDENT_AUDIENCES: readonly AudienceKind[] = ["ALL", "GROUP"];

/**
 * The audiences a resident reads, and no board identity to write in: the list
 * as the screens are to see it while the preview is on.
 *
 * Presentation only, like the viewer's capabilities: the server still answers
 * for every audience the account is in, and the preview never reaches it.
 */
export function previewedAudienceList(
  list: AudienceListView,
): AudienceListView {
  return {
    ...list,
    audiences: list.audiences.filter((audience) =>
      RESIDENT_AUDIENCES.includes(audience.kind),
    ),
    mayPostAsBoard: false,
  };
}

/** Whether a post is in an audience a resident is in. */
export function inResidentAudience(post: PostView): boolean {
  return RESIDENT_AUDIENCES.includes(post.audience.kind);
}

/**
 * A page of the feed without the board's: the posts of Styrelsen and
 * Administratörer, and the board's posts that wait for their instant, which are
 * written for somebody who may write as Styrelsen.
 *
 * The cursors are the server's and stay as they came: a page with fewer posts
 * than it was asked for still says where the next one starts.
 */
export function previewedPage(page: FeedPage): FeedPage {
  return {
    ...page,
    pinned: page.pinned.filter(inResidentAudience),
    scheduled: [],
    posts: page.posts.filter(inResidentAudience),
  };
}

/** What the poll brought, without the board's posts. */
export function previewedUpdate(update: FeedUpdate): FeedUpdate {
  return { ...update, posts: update.posts.filter(inResidentAudience) };
}
