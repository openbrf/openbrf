import { describe, expect, it } from "vite-plus/test";

import {
  DisplayOptionsInvalidError,
  readDisplayOptions,
} from "./display-options";

function refusal(query: Record<string, unknown>): unknown {
  try {
    readDisplayOptions(query);
  } catch (error) {
    return error;
  }
  throw new Error("The options were not refused.");
}

describe("readDisplayOptions", () => {
  it("takes the display mode's defaults from an empty query", () => {
    expect(readDisplayOptions({})).toEqual({
      sources: ["news", "events", "meeting", "availability"],
      resources: null,
      orientation: 0,
      header: "clock",
      theme: "dark",
      locale: null,
    });
  });

  it("reads every option a display link carries", () => {
    expect(
      readDisplayOptions({
        sources: "availability,news",
        resources: "room-b,room-a,room-b",
        orientation: "270",
        header: "none",
        theme: "light",
        locale: "en",
      }),
    ).toEqual({
      // In the rotation's own order, whatever order the link names them in.
      sources: ["news", "availability"],
      resources: ["room-b", "room-a"],
      orientation: 270,
      header: "none",
      theme: "light",
      locale: "en",
    });
  });

  it("leaves a parameter it does not know alone", () => {
    expect(readDisplayOptions({ utm_source: "poster" }).theme).toBe("dark");
  });

  it.each([
    [{ sources: "news,weather" }, "sources"],
    [{ sources: "" }, "sources"],
    [{ sources: " , " }, "sources"],
    [{ resources: "" }, "resources"],
    [{ resources: "a/b" }, "resources"],
    [
      {
        resources: Array.from(
          { length: 13 },
          (_, index) => `r${String(index)}`,
        ).join(","),
      },
      "resources",
    ],
    [{ orientation: "45" }, "orientation"],
    [{ orientation: "constructor" }, "orientation"],
    [{ header: "logo" }, "header"],
    [{ theme: "sepia" }, "theme"],
    [{ locale: "de" }, "locale"],
    [{ theme: ["light", "dark"] }, "theme"],
  ])("refuses %j as display-options-invalid naming %s", (query, option) => {
    const error = refusal(query);

    expect(error).toBeInstanceOf(DisplayOptionsInvalidError);
    expect((error as DisplayOptionsInvalidError).reason).toBe(
      "display-options-invalid",
    );
    expect((error as DisplayOptionsInvalidError).details()).toEqual({
      options: [option],
    });
  });
});
