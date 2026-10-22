import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

import "../i18n";
import { WithheldFromDevicesNotice } from "./WithheldFromDevicesNotice";

/**
 * The editors' mark on an item the register check keeps off every device
 * (ADR 0032): what it says and what it never says.
 */

describe("WithheldFromDevicesNotice", () => {
  it("shows nothing for an item the check lets through", () => {
    const { container } = render(
      <WithheldFromDevicesNotice mark={undefined} />,
    );

    expect(container.innerHTML).toBe("");
  });

  it("names the words in the register's face, so the board can rephrase them", () => {
    render(
      <WithheldFromDevicesNotice
        mark={{ words: ["Svensson", "1101"], unshownWords: false }}
      />,
    );

    expect(screen.queryByText(/Visas inte på skärmar/)).not.toBeNull();
    expect(screen.getByText("Svensson").className).toBe("font-data");
    expect(screen.getByText("1101").className).toBe("font-data");
    expect(screen.queryByText(/också någon annan/)).toBeNull();
  });

  it("says only that the text names somebody when no word may be shown", () => {
    render(
      <WithheldFromDevicesNotice mark={{ words: [], unshownWords: true }} />,
    );

    expect(
      screen.queryByText("Texten nämner någon i registret."),
    ).not.toBeNull();
    expect(screen.queryByText(/eller en lägenhet/)).toBeNull();
  });
});
