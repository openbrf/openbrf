import type { PluginSettingsSchema } from "@openbrf/plugin-sdk";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "../i18n";
import { PluginSettingsForm } from "./PluginSettingsForm";

/**
 * A plugin's settings form, drawn by the host from the plugin's declaration.
 *
 * Two things are being protected. Each declared type has to resolve to a
 * control the rest of the product already uses, because that is what stops a
 * plugin introducing a widget nobody else has and what keeps the values
 * validated on the server against the same declaration. And the labels have to
 * come out of the plugin's own namespace, merged into i18next at runtime: a
 * form that fell back to raw keys would leave a Swedish board reading
 * "fields.reminderDays" and guessing.
 */

const PLUGIN_ID = "grannsamverkan";

const savePluginSettings = vi.fn();
const loadPluginTranslations = vi.fn();

vi.mock("./plugin-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./plugin-api")>()),
  savePluginSettings: (id: string, values: unknown) =>
    savePluginSettings(id, values),
}));

// The real one fetches the bundle from the API. The tests seed the namespace
// directly instead, so the labels are in the store before the first render.
vi.mock("./plugin-i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./plugin-i18n")>()),
  loadPluginTranslations: () => loadPluginTranslations(),
}));

const SCHEMA: PluginSettingsSchema = {
  fields: [
    {
      key: "greeting",
      type: "text",
      labelKey: "fields.greeting",
      required: false,
    },
    {
      key: "reminderDays",
      type: "number",
      labelKey: "fields.reminderDays",
      required: false,
      integer: true,
    },
    {
      key: "includeMovedOut",
      type: "boolean",
      labelKey: "fields.includeMovedOut",
      required: false,
    },
    {
      key: "tone",
      type: "select",
      labelKey: "fields.tone",
      required: false,
      options: [
        { value: "formal", labelKey: "tone.formal" },
        { value: "informal", labelKey: "tone.informal" },
      ],
    },
  ],
};

const VALUES = {
  greeting: "Hej",
  reminderDays: 7,
  includeMovedOut: false,
  tone: "formal",
};

i18n.addResourceBundle(
  "sv",
  `plugin-${PLUGIN_ID}`,
  {
    fields: {
      greeting: "Hälsningsfras",
      reminderDays: "Antal dagar",
      includeMovedOut: "Ta med utflyttade",
      tone: "Tilltal",
    },
    tone: { formal: "Ni", informal: "Du" },
  },
  true,
  true,
);

/**
 * Renders the form and waits for the plugin's translations to land.
 *
 * The form remounts at that point so every label is re-read at once, which
 * replaces each control with a new node. A control captured before the remount
 * is detached from the document, and typing into it then fails for a reason
 * that has nothing to do with the form.
 */
async function renderForm(editable = true) {
  const rendered = render(
    <PluginSettingsForm
      pluginId={PLUGIN_ID}
      schema={SCHEMA}
      values={VALUES}
      editable={editable}
    />,
  );

  await waitFor(() => {
    expect(loadPluginTranslations).toHaveBeenCalled();
  });

  return rendered;
}

const saveButton = () => screen.getByRole("button", { name: /^spara$/i });

beforeEach(() => {
  savePluginSettings.mockReset().mockResolvedValue({
    ok: true,
    value: { id: PLUGIN_ID, schema: SCHEMA, values: VALUES },
  });
  loadPluginTranslations.mockReset().mockResolvedValue(undefined);
});

describe("the declared fields", () => {
  it("each get the control their type asks for", async () => {
    await renderForm();

    expect(screen.getByLabelText("Hälsningsfras")).toHaveProperty(
      "type",
      "text",
    );
    expect(screen.getByLabelText("Antal dagar")).toHaveProperty(
      "type",
      "number",
    );
    expect(screen.getByLabelText("Ta med utflyttade")).toHaveProperty(
      "type",
      "checkbox",
    );
    expect(screen.getByLabelText("Tilltal").tagName).toBe("SELECT");
  });

  it("start from the stored values", async () => {
    await renderForm();

    expect(screen.getByLabelText("Hälsningsfras")).toHaveProperty(
      "value",
      "Hej",
    );
    expect(screen.getByLabelText("Antal dagar")).toHaveProperty("value", "7");
    expect(screen.getByLabelText("Ta med utflyttade")).toHaveProperty(
      "checked",
      false,
    );
  });
});

describe("a select", () => {
  it("offers the declared options and nothing else", async () => {
    // The server validates the stored value against the same declaration, so an
    // option the form invented would be refused on save rather than stored.
    await renderForm();

    const options = within(screen.getByLabelText("Tilltal")).getAllByRole(
      "option",
    );

    expect(
      options.map((option) => (option as HTMLOptionElement).value),
    ).toEqual(["formal", "informal"]);
    expect(options.map((option) => option.textContent)).toEqual(["Ni", "Du"]);
  });
});

describe("the labels", () => {
  it("are read from the plugin's own namespace", async () => {
    /*
     * A plugin's strings cannot be bundled with the application: they arrive on
     * the data volume long after this build. The namespace merged at runtime is
     * therefore the only source for them, and a form that missed it would
     * render the declaration's keys to a board member.
     */
    const { container } = await renderForm();

    expect(screen.getByText("Hälsningsfras")).toBeTruthy();
    expect(container.textContent).not.toContain("fields.greeting");
    expect(container.textContent).not.toContain("tone.formal");
  });
});

describe("saving", () => {
  it("sends the edited values under the plugin's id", async () => {
    const session = userEvent.setup();
    await renderForm();

    await session.clear(screen.getByLabelText("Hälsningsfras"));
    await session.type(screen.getByLabelText("Hälsningsfras"), "God morgon");
    await session.click(screen.getByLabelText("Ta med utflyttade"));
    await session.selectOptions(screen.getByLabelText("Tilltal"), "informal");
    await session.click(saveButton());

    await waitFor(() => {
      expect(savePluginSettings).toHaveBeenCalledWith(PLUGIN_ID, {
        greeting: "God morgon",
        reminderDays: 7,
        includeMovedOut: true,
        tone: "informal",
      });
    });
  });

  it("confirms a save that went through", async () => {
    const session = userEvent.setup();
    await renderForm();

    await session.click(saveButton());

    await waitFor(() => {
      expect(screen.getByText("Sparat")).toBeTruthy();
    });
  });

  it("names a refusal rather than looking as though nothing happened", async () => {
    savePluginSettings.mockResolvedValue({
      ok: false,
      failure: { status: 400, reason: "invalid-body" },
    });
    const session = userEvent.setup();
    await renderForm();

    await session.click(saveButton());

    await waitFor(() => {
      expect(
        screen.getByText(
          "Något av värdena godtas inte. Kontrollera fälten och försök igen.",
        ),
      ).toBeTruthy();
    });
  });
});

describe("a board member who may only read", () => {
  it("gets the controls disabled and no save button", async () => {
    await renderForm(false);

    expect(screen.getByLabelText("Hälsningsfras")).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByLabelText("Antal dagar")).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByLabelText("Ta med utflyttade")).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByLabelText("Tilltal")).toHaveProperty("disabled", true);
    expect(screen.queryByRole("button", { name: /^spara$/i })).toBeNull();
  });
});
