import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import type { PrismaService } from "../database/prisma.service";
import { I18nService } from "../i18n/i18n.service";
import { ThemeService } from "../themes/theme.service";
import type { MenuService } from "./menu.service";
import type { PagesService } from "./pages.service";
import { REFUSAL_PAGE_TTL_MS, SiteRenderer } from "./site-renderer.service";

/*
 * The rate-limit page answers requests the limit already turned away, so
 * drawing it must not read the database per request. These pin that one read
 * serves every refusal for a TTL, that a burst shares the read in flight, and
 * that a failed read is not kept.
 */

const i18n = new I18nService();
beforeAll(() => i18n.init());

const findUnique = vi.fn();
const activeRendering = vi.fn();
const privacyNoticePath = vi.fn();
const siteMenu = vi.fn();

function renderer(): SiteRenderer {
  const unused = {} as never;
  return new SiteRenderer(
    { association: { findUnique } } as unknown as PrismaService,
    { activeRendering } as unknown as ThemeService,
    i18n,
    { privacyNoticePath } as unknown as PagesService,
    { siteMenu } as unknown as MenuService,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-05T10:00:00Z"));
  findUnique.mockReset().mockResolvedValue({
    name: "Brf Exempel",
    defaultLocale: "sv",
    logoFileId: null,
    primaryColor: null,
    selfSignupEnabled: false,
  });
  activeRendering
    .mockReset()
    .mockResolvedValue(ThemeService.builtInRendering());
  privacyNoticePath.mockReset().mockResolvedValue(null);
  siteMenu.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SiteRenderer.tooManyRequests", () => {
  it("answers in the visitor's language, falling back to the association's", async () => {
    const site = renderer();

    expect(await site.tooManyRequests("en-GB,en;q=0.9")).toContain(
      "Too many attempts",
    );
    expect(await site.tooManyRequests("sv")).toContain("För många försök");
    expect(await site.tooManyRequests(undefined)).toContain("För många försök");
    expect(await site.tooManyRequests("de")).toContain("För många försök");
  });

  it("reads the chrome once for every refusal until the page expires", async () => {
    const site = renderer();

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        site.tooManyRequests(index % 2 === 0 ? "en" : "sv"),
      ),
    );
    await site.tooManyRequests("en");

    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(activeRendering).toHaveBeenCalledTimes(1);
    expect(privacyNoticePath).toHaveBeenCalledTimes(1);
    expect(siteMenu).toHaveBeenCalledTimes(1);
    // The anonymous menu, as on the not-found page.
    expect(siteMenu).toHaveBeenCalledWith(
      expect.objectContaining({ hasSession: false }),
    );

    vi.setSystemTime(Date.now() + REFUSAL_PAGE_TTL_MS - 1);
    await site.tooManyRequests("en");
    expect(findUnique).toHaveBeenCalledTimes(1);

    findUnique.mockResolvedValue({
      name: "Brf Omdöpt",
      defaultLocale: "sv",
      logoFileId: null,
      primaryColor: null,
      selfSignupEnabled: false,
    });
    vi.setSystemTime(Date.now() + 1);
    expect(await site.tooManyRequests("en")).toContain("Brf Omdöpt");
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it("does not keep a failed read, so the next refusal asks again", async () => {
    const site = renderer();
    findUnique.mockRejectedValueOnce(new Error("database is down"));

    await expect(
      Promise.all([site.tooManyRequests("en"), site.tooManyRequests("sv")]),
    ).rejects.toThrow("database is down");
    expect(findUnique).toHaveBeenCalledTimes(1);

    expect(await site.tooManyRequests("en")).toContain("Too many attempts");
    expect(findUnique).toHaveBeenCalledTimes(2);
  });
});
