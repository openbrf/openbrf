import type { PluginSettingsSchema } from "@openbrf/plugin-sdk";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
  savePluginSettings: (id: string, values: unknown, secrets: unknown) =>
    savePluginSettings(id, values, secrets),
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
    apiKey: "API-nyckel",
    refreshToken: "Förnyelsetoken",
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
    value: { id: PLUGIN_ID, schema: SCHEMA, values: VALUES, secretsSet: [] },
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

describe("a required field", () => {
  it("is announced as required, and an optional one is not", async () => {
    render(
      <PluginSettingsForm
        pluginId={PLUGIN_ID}
        schema={{
          fields: SCHEMA.fields.map((field) =>
            field.key === "greeting" ||
            field.key === "reminderDays" ||
            field.key === "tone"
              ? { ...field, required: true }
              : field,
          ),
        }}
        values={VALUES}
        editable
      />,
    );
    await waitFor(() => {
      expect(loadPluginTranslations).toHaveBeenCalled();
    });

    expect(
      screen.getByLabelText("Hälsningsfras").getAttribute("aria-required"),
    ).toBe("true");
    expect(
      screen.getByLabelText("Antal dagar").getAttribute("aria-required"),
    ).toBe("true");
    expect(screen.getByLabelText("Tilltal").getAttribute("aria-required")).toBe(
      "true",
    );
    expect(
      screen.getByLabelText("Ta med utflyttade").hasAttribute("aria-required"),
    ).toBe(false);
  });

  it("leaves aria-required off every kind of optional control", async () => {
    render(
      <PluginSettingsForm
        pluginId={PLUGIN_ID}
        schema={SCHEMA}
        values={VALUES}
        editable
      />,
    );
    await waitFor(() => {
      expect(loadPluginTranslations).toHaveBeenCalled();
    });

    for (const label of [
      "Hälsningsfras",
      "Antal dagar",
      "Tilltal",
      "Ta med utflyttade",
    ]) {
      expect(screen.getByLabelText(label).hasAttribute("aria-required")).toBe(
        false,
      );
    }
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
      expect(savePluginSettings).toHaveBeenCalledWith(
        PLUGIN_ID,
        {
          greeting: "God morgon",
          reminderDays: 7,
          includeMovedOut: true,
          tone: "informal",
        },
        // No secret field in this form, so none is sent.
        {},
      );
    });
  });

  it("sends an emptied optional number as absent rather than as zero", async () => {
    /*
     * Number("") is 0, so an emptied box would otherwise be saved as the number
     * zero - and a reminderDays of 0 is a value the plugin acts on, not a field
     * left unset, with nothing on screen to say the board had chosen it. The
     * browser does not catch it either: the input is empty and the field is not
     * required, so a declared minimum above zero never fires.
     */
    const session = userEvent.setup();
    await renderForm();

    await session.clear(screen.getByLabelText("Antal dagar"));
    await session.click(saveButton());

    await waitFor(() => {
      expect(savePluginSettings).toHaveBeenCalled();
    });
    const sent = savePluginSettings.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(sent).not.toHaveProperty("reminderDays");
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

/**
 * A secret field (ADR 0037). The API says whether it holds a value and never
 * what it is, so the form must start it empty, send it only when the board
 * typed one or asked for it to go, and never show a value back.
 */
describe("a secret field", () => {
  const SECRET_SCHEMA: PluginSettingsSchema = {
    fields: [
      ...SCHEMA.fields,
      {
        key: "apiKey",
        type: "secret",
        labelKey: "apiKey",
        required: true,
        maxLength: 200,
      },
      {
        key: "refreshToken",
        type: "secret",
        labelKey: "refreshToken",
        required: false,
      },
    ],
  };

  async function renderSecrets(secretsSet: string[], editable = true) {
    render(
      <PluginSettingsForm
        pluginId={PLUGIN_ID}
        schema={SECRET_SCHEMA}
        values={VALUES}
        secretsSet={secretsSet}
        editable={editable}
      />,
    );
    await waitFor(() => {
      expect(loadPluginTranslations).toHaveBeenCalled();
    });
  }

  const apiKey = () => screen.getByLabelText<HTMLInputElement>("API-nyckel");

  it("is a password box that starts empty and says whether a value is stored", async () => {
    await renderSecrets(["apiKey"]);

    expect(apiKey().type).toBe("password");
    expect(apiKey().value).toBe("");
    expect(apiKey().autocomplete).toBe("new-password");
    expect(
      screen.getByText(
        "Ett värde är sparat. Det visas aldrig; lämna fältet tomt för att behålla det.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Inget värde är sparat.")).toBeTruthy();
  });

  // A stored value satisfies a required secret, so the box may stay empty.
  it("is announced as required only while nothing is stored", async () => {
    await renderSecrets([]);
    expect(apiKey().getAttribute("aria-required")).toBe("true");
  });

  it("is not announced as required once a value is stored", async () => {
    await renderSecrets(["apiKey"]);
    expect(apiKey().getAttribute("aria-required")).toBeNull();
  });

  it("is left out of a save that did not touch it, which keeps it", async () => {
    const session = userEvent.setup();
    await renderSecrets(["apiKey"]);

    await session.click(saveButton());

    await waitFor(() => {
      expect(savePluginSettings).toHaveBeenCalledWith(PLUGIN_ID, VALUES, {});
    });
  });

  it("sends a value typed into it, and empties the box once saved", async () => {
    savePluginSettings.mockResolvedValue({
      ok: true,
      value: {
        id: PLUGIN_ID,
        schema: SECRET_SCHEMA,
        values: VALUES,
        secretsSet: ["apiKey"],
      },
    });
    const session = userEvent.setup();
    await renderSecrets([]);

    await session.type(apiKey(), "sk-ant-123");
    await session.click(saveButton());

    await waitFor(() => {
      expect(savePluginSettings).toHaveBeenCalledWith(PLUGIN_ID, VALUES, {
        apiKey: "sk-ant-123",
      });
    });
    await waitFor(() => {
      expect(apiKey().value).toBe("");
    });
    expect(
      screen.getAllByText(
        "Ett värde är sparat. Det visas aldrig; lämna fältet tomt för att behålla det.",
      ),
    ).toHaveLength(1);
  });

  it("sends a removal as null, offered only for an optional one that holds a value", async () => {
    const session = userEvent.setup();
    await renderSecrets(["apiKey", "refreshToken"]);

    const removals = screen.getAllByRole("checkbox", {
      name: "Ta bort det sparade värdet",
    });
    expect(removals).toHaveLength(1);
    await session.click(removals[0] as HTMLElement);
    expect(
      screen.getByLabelText<HTMLInputElement>("Förnyelsetoken").disabled,
    ).toBe(true);
    await session.click(saveButton());

    await waitFor(() => {
      expect(savePluginSettings).toHaveBeenCalledWith(PLUGIN_ID, VALUES, {
        refreshToken: null,
      });
    });
  });

  it("is disabled, with nothing to remove, for a board member who may only read", async () => {
    await renderSecrets(["apiKey", "refreshToken"], false);

    expect(apiKey().disabled).toBe(true);
    expect(
      screen.queryByRole("checkbox", { name: "Ta bort det sparade värdet" }),
    ).toBeNull();
  });
});
