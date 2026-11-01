import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { fetchViewer, saveOwnProfile } from "../api/instance";
import { resetAppliedViewerLocale } from "./apply-viewer-locale";
import i18n from "./index";

/**
 * A page opened by its address speaks the language its person saved.
 *
 * The page starts in Swedish and only the settings panel switched it, so a
 * fresh load went back to Swedish for someone who had chosen English.
 */

const fetchMock = vi.fn();

function viewerResponse(personId: string, preferredLocale: string): Response {
  return new Response(
    JSON.stringify({
      personId,
      firstName: "Maja",
      lastName: "Lind",
      preferredLocale,
      capabilities: [],
      housingCooperative: null,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function answer(personId: string, preferredLocale: string): void {
  fetchMock.mockResolvedValueOnce(viewerResponse(personId, preferredLocale));
}

/**
 * Starts a read of the viewer whose answer arrives only when the test says so,
 * for answers that land in another order than their requests went out.
 */
function heldRead(
  personId: string,
  preferredLocale: string,
): { done: Promise<unknown>; land: () => Promise<unknown> } {
  let release: (response: Response) => void = () => undefined;
  fetchMock.mockReturnValueOnce(
    new Promise<Response>((resolve) => {
      release = resolve;
    }),
  );
  const done = fetchViewer();
  return {
    done,
    land: () => {
      release(viewerResponse(personId, preferredLocale));
      return done;
    },
  };
}

/** Saves English in the profile settings, which switch the page themselves. */
async function saveEnglish(): Promise<void> {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ preferredLocale: "en" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  const saved = await saveOwnProfile({ preferredLocale: "en" });
  expect(saved.ok).toBe(true);
  await i18n.changeLanguage("en");
}

beforeEach(async () => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  resetAppliedViewerLocale();
  await i18n.changeLanguage("sv");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await i18n.changeLanguage("sv");
});

describe("applying the saved language on load", () => {
  it("switches to the language the viewer saved once /api/me resolves", async () => {
    answer("person-1", "en");

    expect(i18n.language).toBe("sv");
    await fetchViewer();

    expect(i18n.language).toBe("en");
  });

  it("keeps the default when the request fails, as before sign-in", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 401 }));

    await fetchViewer();

    expect(i18n.language).toBe("sv");
  });

  it("ignores a locale it has no translations for", async () => {
    answer("person-1", "de");

    await fetchViewer();

    expect(i18n.language).toBe("sv");
  });

  it("does not change the language again for the same answer", async () => {
    const change = vi.spyOn(i18n, "changeLanguage");
    answer("person-1", "en");
    answer("person-1", "en");

    await fetchViewer();
    await fetchViewer();

    expect(change).toHaveBeenCalledTimes(1);
    change.mockRestore();
  });

  it("does not undo a language chosen in settings when an older read lands", async () => {
    answer("person-1", "sv");
    await fetchViewer();
    // A read that began before the save and ends after it.
    const before = heldRead("person-1", "sv");
    await saveEnglish();

    await before.land();

    expect(i18n.language).toBe("en");
  });

  it("does not undo a saved language when an older read lands after a newer one", async () => {
    answer("person-1", "sv");
    await fetchViewer();
    const before = heldRead("person-1", "sv");
    await saveEnglish();
    // The next screen reads the viewer afresh and hears the saved English.
    answer("person-1", "en");
    await fetchViewer();

    await before.land();

    expect(i18n.language).toBe("en");
  });

  it("keeps the newest answer when two reads end out of order", async () => {
    const older = heldRead("person-1", "sv");
    const newer = heldRead("person-1", "en");

    await newer.land();
    await older.land();

    expect(i18n.language).toBe("en");
  });

  it("applies a read that starts after a save", async () => {
    answer("person-1", "en");
    await fetchViewer();
    await saveEnglish();
    // Saved again as Swedish in another tab, then read here.
    answer("person-1", "sv");
    await fetchViewer();

    expect(i18n.language).toBe("sv");
  });

  it("follows a different person who signs in on the same page", async () => {
    answer("person-1", "en");
    await fetchViewer();
    answer("person-2", "sv");
    await fetchViewer();

    expect(i18n.language).toBe("sv");
  });
});
