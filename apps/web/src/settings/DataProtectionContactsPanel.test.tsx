import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { DataProtectionContacts } from "../api/instance";
import { DataProtectionContactsPanel } from "./DataProtectionContactsPanel";

const saveDataProtectionContacts = vi.fn();

vi.mock("../api/instance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/instance")>()),
  saveDataProtectionContacts: (input: unknown) =>
    saveDataProtectionContacts(input),
}));

const CONTACTS: DataProtectionContacts = {
  controller: {
    contactEmail: "styrelsen@ekhagen.se",
    postalAddress: "Ekvägen 1, 123 45 Ekby",
  },
  officer: { name: null, email: null, phone: null },
  jointController: { name: null, contact: null },
};

beforeEach(() => {
  saveDataProtectionContacts.mockReset();
});

describe("saving the contacts", () => {
  it("says it was saved, and cannot be sent twice while it is saving", async () => {
    let settle: (value: unknown) => void = () => {};
    saveDataProtectionContacts.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    const session = userEvent.setup();
    render(<DataProtectionContactsPanel contacts={CONTACTS} mayManage />);

    await session.click(screen.getByRole("button", { name: /^spara$/i }));
    await session.click(screen.getByRole("button", { name: /^sparar/i }));

    expect(saveDataProtectionContacts).toHaveBeenCalledTimes(1);
    settle({ ok: true, value: CONTACTS });
    await waitFor(() => {
      expect(screen.getByText("Sparat")).toBeTruthy();
    });
  });
});
