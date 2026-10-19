import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

import { PostText, textSegments } from "./PostText";

/**
 * What in a post becomes a link, which is what decides where a neighbour can be
 * sent by pressing: a web address, and nothing else.
 */
describe("a post's text", () => {
  it("links a web address and leaves the words around it as words", () => {
    expect(
      textSegments(
        "Protokollet finns på https://brf.example.se/protokoll i dag",
      ),
    ).toEqual([
      { kind: "text", text: "Protokollet finns på " },
      { kind: "link", href: "https://brf.example.se/protokoll" },
      { kind: "text", text: " i dag" },
    ]);
  });

  it("leaves the full stop that ends the sentence out of the address", () => {
    expect(textSegments("Läs mer på http://example.se.")).toEqual([
      { kind: "text", text: "Läs mer på " },
      { kind: "link", href: "http://example.se" },
      { kind: "text", text: "." },
    ]);
  });

  it("links no address that is not a web address", () => {
    expect(textSegments("javascript:alert(1) och data:text/html,x")).toEqual([
      { kind: "text", text: "javascript:alert(1) och data:text/html,x" },
    ]);
  });

  it("keeps the writer's line breaks and opens a link in a new tab with no referrer", () => {
    render(<PostText text={"Första raden\nhttps://example.se"} />);

    const link = screen.getByRole("link", { name: "https://example.se" });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noreferrer");
    expect(link.closest("p")?.className).toContain("whitespace-pre-line");
    expect(link.closest("p")?.textContent).toBe(
      "Första raden\nhttps://example.se",
    );
  });
});
