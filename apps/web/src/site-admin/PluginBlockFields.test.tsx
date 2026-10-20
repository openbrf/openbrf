import type { PluginBlockDeclaration } from "@openbrf/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactElement } from "react";
import { describe, expect, it } from "vite-plus/test";

import i18n from "../i18n";
import {
  type EditorBlock,
  editorBlocks,
  editorRegistry,
  pluginSettingsOf,
  unfinishedStoredBlocks,
  withPluginSetting,
} from "./page-blocks";
import { updateBlock } from "./block-tree";
import { PluginBlockFields } from "./PluginBlockFields";

/**
 * A plugin's block, set up in the page editor after an upgrade of its plugin.
 *
 * A plugin can stop offering one of a select's options. A block stored with
 * it is then not ready, and the editor holds back every save of the page
 * until the board answers the field again - so the field has to be one the
 * board can answer, also when a single option is left.
 */

const NOTICE: PluginBlockDeclaration = {
  type: "laundry/notice",
  pluginId: "laundry",
  labelKey: "blocks.notice.label",
  icon: "calendar",
  category: "association",
  fields: [
    {
      key: "heading",
      labelKey: "blocks.notice.heading",
      type: "text",
      required: true,
    },
    {
      key: "tone",
      labelKey: "blocks.notice.tone",
      type: "select",
      required: true,
      // "loud" was offered too before the upgrade.
      options: [{ value: "calm", labelKey: "blocks.notice.calm" }],
    },
  ],
};

const registry = editorRegistry([NOTICE]);

i18n.addResourceBundle(
  "sv",
  "plugin-laundry",
  {
    blocks: { notice: { heading: "Rubrik", tone: "Ton", calm: "Lugn" } },
  },
  true,
  true,
);

/** The editor's handling of one block, as PageEditor does it. */
function Editor({
  stored,
  onEntries,
}: {
  stored: EditorBlock[];
  onEntries: (entries: EditorBlock[]) => void;
}): ReactElement {
  const [entries, setEntries] = useState(stored);
  const entry = entries[0] as EditorBlock;
  return (
    <PluginBlockFields
      declaration={NOTICE}
      settings={pluginSettingsOf(entry.block)}
      unfinished={unfinishedStoredBlocks(entries, registry).includes(0)}
      onChange={(key, value) => {
        const next = updateBlock(
          entries,
          entry.id,
          withPluginSetting(entry.block, key, value),
        );
        setEntries(next);
        onEntries(next);
      }}
    />
  );
}

describe("a select whose stored option the plugin no longer offers", () => {
  it("shows that, and is answered by choosing the one option left", async () => {
    const stored = editorBlocks([
      {
        type: "laundry/notice",
        settings: { heading: "Tvättstugan", tone: "loud" },
      },
    ]);
    expect(unfinishedStoredBlocks(stored, registry)).toEqual([0]);
    let latest = stored;
    const session = userEvent.setup();

    render(
      <Editor
        stored={stored}
        onEntries={(entries) => {
          latest = entries;
        }}
      />,
    );

    // Not the remaining option, which is not what the block holds.
    const tone = screen.getByLabelText("Ton");
    expect(tone).toHaveProperty("value", "");
    expect((tone as HTMLSelectElement).selectedOptions[0]?.textContent).toBe(
      "Erbjuds inte längre. Välj ett annat.",
    );
    expect(
      screen.getByText(/Tillägget frågar nu efter inställningar/),
    ).toBeTruthy();

    await session.selectOptions(tone, "calm");

    expect(tone).toHaveProperty("value", "calm");
    expect(pluginSettingsOf((latest[0] as EditorBlock).block)).toEqual({
      heading: "Tvättstugan",
      tone: "calm",
    });
    expect(unfinishedStoredBlocks(latest, registry)).toEqual([]);
    expect(
      screen.queryByText(/Tillägget frågar nu efter inställningar/),
    ).toBeNull();
    // Answered, the placeholder is gone and cannot be chosen back.
    expect(
      [...(tone as HTMLSelectElement).options].map((option) => option.value),
    ).toEqual(["calm"]);
  });

  it("asks for a choice where nothing is chosen yet", () => {
    render(
      <PluginBlockFields
        declaration={NOTICE}
        settings={{ heading: "Tvättstugan" }}
        onChange={() => undefined}
      />,
    );

    const tone = screen.getByLabelText("Ton") as HTMLSelectElement;
    expect(tone.value).toBe("");
    expect(tone.selectedOptions[0]?.textContent).toBe("Välj...");
    expect(tone.selectedOptions[0]?.disabled).toBe(true);
  });
});
