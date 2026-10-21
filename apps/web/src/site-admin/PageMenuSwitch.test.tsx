import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { AdminPage } from "../api/site";
import { PageMenuSwitch } from "./PageMenuSwitch";

/**
 * The page's "Show in menu" switch: one write to the menu per press, and a
 * box that shows what the server last said.
 */

const setPageInMenu = vi.fn();

vi.mock("../api/site", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/site")>()),
  setPageInMenu: (id: string, inMenu: boolean) => setPageInMenu(id, inMenu),
}));

function page(overrides: Partial<AdminPage> = {}): AdminPage {
  return {
    id: "page-1",
    slug: "om-oss",
    title: "Om oss",
    content: { version: 1, blocks: [] },
    status: "PUBLIC",
    frontPage: false,
    inMenu: false,
    slugFollowsTitle: false,
    builtIn: null,
    publishedAt: "2026-08-01T09:00:00.000Z",
    sortOrder: 1,
    revision: 4,
    updatedAt: "2026-08-01T09:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("Show in menu", () => {
  it("puts the page in the menu and says so", async () => {
    const onChanged = vi.fn();
    setPageInMenu.mockResolvedValue({
      ok: true,
      value: page({ inMenu: true }),
    });
    render(<PageMenuSwitch onChanged={onChanged} page={page()} />);

    const toggle = screen.getByRole("switch", { name: "Visa i menyn" });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    await userEvent.click(toggle);

    await waitFor(() => {
      expect(setPageInMenu).toHaveBeenCalledWith("page-1", true);
    });
    expect(await screen.findByText("Sidan ligger i menyn.")).toBeTruthy();
    expect(onChanged).toHaveBeenCalledWith(page({ inMenu: true }));
    expect((toggle as HTMLInputElement).checked).toBe(true);
  });

  it("takes the page out again", async () => {
    setPageInMenu.mockResolvedValue({ ok: true, value: page() });
    render(
      <PageMenuSwitch onChanged={vi.fn()} page={page({ inMenu: true })} />,
    );

    const toggle = screen.getByRole("switch", { name: "Visa i menyn" });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    await userEvent.click(toggle);

    await waitFor(() => {
      expect(setPageInMenu).toHaveBeenCalledWith("page-1", false);
    });
    expect(await screen.findByText("Sidan är borta ur menyn.")).toBeTruthy();
  });

  it("shows what the server has, and says so, when the change is refused", async () => {
    setPageInMenu.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unknown" },
    });
    render(<PageMenuSwitch onChanged={vi.fn()} page={page()} />);

    const toggle = screen.getByRole("switch", { name: "Visa i menyn" });
    await userEvent.click(toggle);

    expect(
      await screen.findByText("Menyn kunde inte ändras just nu. Försök igen."),
    ).toBeTruthy();
    expect((toggle as HTMLInputElement).checked).toBe(false);
  });

  it("takes one press at a time", async () => {
    let answer: (result: unknown) => void = () => undefined;
    setPageInMenu.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    render(<PageMenuSwitch onChanged={vi.fn()} page={page()} />);

    const toggle = screen.getByRole("switch", { name: "Visa i menyn" });
    await userEvent.click(toggle);
    expect((toggle as HTMLInputElement).disabled).toBe(true);
    await userEvent.click(toggle);
    expect(setPageInMenu).toHaveBeenCalledTimes(1);

    answer({ ok: true, value: page({ inMenu: true }) });
    await waitFor(() => {
      expect((toggle as HTMLInputElement).disabled).toBe(false);
    });
  });
});
