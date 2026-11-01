import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { fetchViewer } from "../api/instance";
import { resetAppliedViewerLocale } from "./apply-viewer-locale";
import i18n from "./index";

/**
 * A page opened by its address speaks the language its person saved.
 *
 * The page starts in Swedish and only the settings panel switched it, so a
 * fresh load went back to Swedish for someone who had chosen English.
 */

const fetchMock = vi.fn();

function answer(personId: string, preferredLocale: string): void {
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        personId,
        firstName: "Maja",
        lastName: "Lind",
        preferredLocale,
        capabilities: [],
        housingCooperative: null,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
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
    // Saved as English in the profile panel, which switches the page itself.
    await i18n.changeLanguage("en");
    // A read that began before the save and ended after it.
    answer("person-1", "sv");
    await fetchViewer();

    expect(i18n.language).toBe("en");
  });

  it("follows a different person who signs in on the same page", async () => {
    answer("person-1", "en");
    await fetchViewer();
    answer("person-2", "sv");
    await fetchViewer();

    expect(i18n.language).toBe("sv");
  });
});
