import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_CHOICES, displayLink } from "./display-link";

const ORIGIN = "https://brf.example.se";
const TOKEN = "obrf_dt_abc";

describe("displayLink", () => {
  it("writes no query for the defaults, and the token in the fragment", () => {
    expect(displayLink(ORIGIN, TOKEN, DEFAULT_CHOICES)).toBe(
      "https://brf.example.se/app/display#obrf_dt_abc",
    );
  });

  it("writes each choice that differs from its default, in the options' order", () => {
    expect(
      displayLink(ORIGIN, TOKEN, {
        sources: ["availability", "news"],
        resources: ["room-b", "room-a"],
        orientation: 90,
        header: "none",
        theme: "light",
        locale: "en",
      }),
    ).toBe(
      "https://brf.example.se/app/display?sources=news,availability&resources=room-b,room-a&orientation=90&header=none&theme=light&locale=en#obrf_dt_abc",
    );
  });

  it("leaves the resources out while availability is not shown", () => {
    const link = displayLink(ORIGIN, TOKEN, {
      ...DEFAULT_CHOICES,
      sources: ["news"],
      resources: ["room-a"],
    });

    expect(link).toBe(
      "https://brf.example.se/app/display?sources=news#obrf_dt_abc",
    );
  });

  it("never puts the token in the query", () => {
    const link = new URL(
      displayLink(ORIGIN, TOKEN, { ...DEFAULT_CHOICES, theme: "light" }),
    );

    expect(link.search).not.toContain(TOKEN);
    expect(link.hash).toBe(`#${TOKEN}`);
  });
});
