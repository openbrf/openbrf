import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import { ok, post, refused } from "./feed-fixtures";
import { PostComposer } from "./PostComposer";

/**
 * Writing a post.
 *
 * **From the writer, to the audience that is open.** Both said in the dialog,
 * so nobody posts to the whole house thinking they wrote to their group.
 *
 * **Text is required and images are the only attachment.** Each image goes up
 * as it is picked, and the post is written once with their identifiers.
 *
 * **A refusal keeps everything in the dialog**, so the writer takes out what
 * was refused rather than writing the post again.
 *
 * **The board's options are offered where the server said they would be
 * taken**: "Från" Styrelsen, with or without "via", which goes to Alla as a
 * news item with a title, and the flags and the schedule that come with one.
 */

const uploadPostImage = vi.fn();
const writePost = vi.fn();
const writeBoardPost = vi.fn();

vi.mock("../api/feed", () => ({
  uploadPostImage: (input: unknown) => uploadPostImage(input),
  writePost: (input: unknown) => writePost(input),
  writeBoardPost: (input: unknown) => writeBoardPost(input),
}));

function photo(name: string): File {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, {
    type: "image/png",
  });
}

function open(
  handlers: { onClose?: () => void; onWritten?: () => void } = {},
): HTMLElement {
  render(
    <PostComposer
      audience={{ id: "audience-all", kind: "ALL", name: "Alla" }}
      authorName="Astrid Lindqvist"
      onClose={handlers.onClose ?? (() => {})}
      onWritten={handlers.onWritten ?? (() => {})}
    />,
  );
  return screen.getByRole("dialog", { name: "Skriv ett inlägg" });
}

const revokeObjectURL = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  URL.createObjectURL = vi.fn((file: Blob) => `blob:${(file as File).name}`);
  URL.revokeObjectURL = revokeObjectURL;
});

describe("the composer", () => {
  it("says who the post is from and who it goes to", () => {
    const dialog = open();

    expect(within(dialog).getByText("Astrid Lindqvist")).toBeTruthy();
    expect(within(dialog).getByText("Alla")).toBeTruthy();
  });

  it("cannot create a post without text", async () => {
    const dialog = open();

    const create = within(dialog).getByRole("button", { name: "Skapa" });
    expect((create as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(within(dialog).getByLabelText("Text"), "   ");
    expect((create as HTMLButtonElement).disabled).toBe(true);
  });

  it("uploads each picked image and writes the post with them", async () => {
    uploadPostImage
      .mockResolvedValueOnce(
        ok({ id: "file-1", url: "/api/media/file-1", width: 1, height: 1 }),
      )
      .mockResolvedValueOnce(
        ok({ id: "file-2", url: "/api/media/file-2", width: 1, height: 1 }),
      );
    const written = post({ id: "post-1" });
    writePost.mockResolvedValue(ok(written));
    const onWritten = vi.fn();
    const dialog = open({ onWritten });

    await userEvent.type(
      within(dialog).getByLabelText("Text"),
      "Cyklar i källaren säljes.",
    );
    await userEvent.upload(within(dialog).getByLabelText("Bifoga bilder"), [
      photo("cykel.png"),
      photo("cykel-2.png"),
    ]);
    await waitFor(() => {
      expect(within(dialog).getAllByText("Klar")).toHaveLength(2);
    });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Skapa" }),
    );

    expect(writePost).toHaveBeenCalledWith({
      audienceId: "audience-all",
      body: "Cyklar i källaren säljes.",
      imageIds: ["file-1", "file-2"],
    });
    await waitFor(() => {
      expect(onWritten).toHaveBeenCalledWith(written);
    });
  });

  it("leaves out an image that was refused, and says why", async () => {
    uploadPostImage.mockResolvedValue(refused(400, "unsupported-type"));
    writePost.mockResolvedValue(ok(post({ id: "post-1" })));
    const dialog = open();

    await userEvent.type(within(dialog).getByLabelText("Text"), "Hej.");
    await userEvent.upload(within(dialog).getByLabelText("Bifoga bilder"), [
      photo("inte-en-bild.png"),
    ]);

    expect(
      await within(dialog).findByText(
        "Filen är inte en bild som kan visas: välj en PNG, JPEG, WebP eller GIF.",
      ),
    ).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Skapa" }),
    );
    expect(writePost).toHaveBeenCalledWith({
      audienceId: "audience-all",
      body: "Hej.",
      imageIds: [],
    });
  });

  it("takes an image off again before the post is written", async () => {
    uploadPostImage.mockResolvedValue(
      ok({ id: "file-1", url: "/api/media/file-1", width: 1, height: 1 }),
    );
    writePost.mockResolvedValue(ok(post({ id: "post-1" })));
    const dialog = open();

    await userEvent.type(within(dialog).getByLabelText("Text"), "Hej.");
    await userEvent.upload(within(dialog).getByLabelText("Bifoga bilder"), [
      photo("fel.png"),
    ]);
    await within(dialog).findByText("Klar");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Ta bort fel.png" }),
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Skapa" }),
    );

    expect(writePost).toHaveBeenCalledWith({
      audienceId: "audience-all",
      body: "Hej.",
      imageIds: [],
    });
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:fel.png");
  });

  it("takes no more images than a post may carry", async () => {
    uploadPostImage.mockResolvedValue(
      ok({ id: "file", url: "/api/media/file", width: 1, height: 1 }),
    );
    const dialog = open();

    await userEvent.upload(
      within(dialog).getByLabelText("Bifoga bilder"),
      ["1", "2", "3", "4", "5"].map((name) => photo(`${name}.png`)),
    );

    expect(uploadPostImage).toHaveBeenCalledTimes(4);
    await waitFor(() => {
      expect(
        (within(dialog).getByLabelText("Bifoga bilder") as HTMLInputElement)
          .disabled,
      ).toBe(true);
    });
  });

  it("shows the post before it is created", async () => {
    const dialog = open();

    await userEvent.type(
      within(dialog).getByLabelText("Text"),
      "Se https://example.se",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Förhandsgranska" }),
    );

    const preview = within(dialog).getByRole("region", {
      name: "Förhandsgranskning",
    });
    expect(
      within(preview).getByRole("link", { name: "https://example.se" }),
    ).toBeTruthy();
  });

  it("puts a refused personal identity number in words, and keeps the draft", async () => {
    writePost.mockResolvedValue(refused(422, "personal-identity-number"));
    const onWritten = vi.fn();
    const dialog = open({ onWritten });

    const field = within(dialog).getByLabelText("Text");
    await userEvent.type(field, "Ring 19811218-9876");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Skapa" }),
    );

    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "personnummer",
    );
    expect((field as HTMLTextAreaElement).value).toBe("Ring 19811218-9876");
    expect(onWritten).not.toHaveBeenCalled();
  });

  it("closes on cancel", async () => {
    const onClose = vi.fn();
    const dialog = open({ onClose });

    await userEvent.click(
      within(dialog).getByRole("button", { name: "Avbryt" }),
    );

    expect(onClose).toHaveBeenCalled();
  });
});

/** The composer as a board seat holder opens it from the whole feed. */
function openAsBoard(handlers: { onWritten?: () => void } = {}): HTMLElement {
  render(
    <PostComposer
      audience={{ id: "audience-all", kind: "ALL", name: "Alla" }}
      choices={[
        { id: "audience-all", kind: "ALL", name: "Alla" },
        { id: "audience-board", kind: "BOARD", name: "Styrelsen" },
        { id: "audience-admin", kind: "ADMIN", name: "Administratörer" },
        { id: "audience-group", kind: "GROUP", name: "Trädgården" },
      ]}
      authorName="Astrid Lindqvist"
      mayPostAsBoard
      onClose={() => {}}
      onWritten={handlers.onWritten ?? (() => {})}
    />,
  );
  return screen.getByRole("dialog", { name: "Skriv ett inlägg" });
}

describe("the board's composer", () => {
  it("is offered to nobody the server did not say may write as Styrelsen", () => {
    const dialog = open();

    expect(within(dialog).queryByLabelText("Från")).toBeNull();
    expect(within(dialog).queryByText("Viktigt meddelande")).toBeNull();
  });

  it("writes as the writer to the audience chosen", async () => {
    writePost.mockResolvedValue(ok(post({ id: "post-1" })));
    const dialog = openAsBoard();

    await userEvent.selectOptions(
      within(dialog).getByLabelText("Till"),
      "audience-board",
    );
    await userEvent.type(
      within(dialog).getByLabelText("Text"),
      "Mötet flyttas.",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Skapa" }),
    );

    expect(writePost).toHaveBeenCalledWith({
      audienceId: "audience-board",
      body: "Mötet flyttas.",
      imageIds: [],
    });
    expect(writeBoardPost).not.toHaveBeenCalled();
  });

  it("writes as Styrelsen to Alla, with a title and the board's options", async () => {
    const written = post({ id: "post-1", byBoard: true, author: null });
    writeBoardPost.mockResolvedValue(ok(written));
    const onWritten = vi.fn();
    const dialog = openAsBoard({ onWritten });

    await userEvent.selectOptions(
      within(dialog).getByLabelText("Från"),
      "Styrelsen via Astrid Lindqvist",
    );
    // Written as Styrelsen it goes to Alla, Styrelsen or Administratörer, and
    // "Till" offers no group, which the server would refuse.
    const to = within(dialog).getByLabelText("Till");
    expect(
      within(to)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Alla", "Styrelsen", "Administratörer"]);

    const create = within(dialog).getByRole("button", { name: "Skapa" });
    await userEvent.type(within(dialog).getByLabelText("Text"), "Tisdag 9-12.");
    // A news item needs its title.
    expect((create as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(
      within(dialog).getByLabelText(/^Rubrik/u),
      "Vattnet stängs av",
    );
    await userEvent.click(
      within(dialog).getByLabelText(/^Viktigt meddelande/u),
    );
    await userEvent.click(within(dialog).getByLabelText("Fäst överst"));
    await userEvent.click(within(dialog).getByLabelText("Tillåt kommentarer"));
    await userEvent.click(create);

    expect(writeBoardPost).toHaveBeenCalledWith({
      audienceId: "audience-all",
      title: "Vattnet stängs av",
      body: "Tisdag 9-12.",
      imageIds: [],
      namesAuthor: true,
      important: true,
      pinned: true,
      commentsAllowed: false,
      scheduledAt: null,
      onWebsite: false,
    });
    expect(writePost).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(onWritten).toHaveBeenCalledWith(written);
    });
  });

  it("writes as Styrelsen to Styrelsen alone, mailed to it and on no website", async () => {
    writeBoardPost.mockResolvedValue(ok(post({ id: "post-1" })));
    const dialog = openAsBoard();

    await userEvent.selectOptions(
      within(dialog).getByLabelText("Från"),
      "Styrelsen",
    );
    expect(
      within(dialog).getByLabelText(/^Visa på föreningens webbplats/u),
    ).toBeTruthy();
    await userEvent.click(
      within(dialog).getByLabelText(/^Visa på föreningens webbplats/u),
    );
    await userEvent.selectOptions(
      within(dialog).getByLabelText("Till"),
      "audience-board",
    );
    // Only a post to Alla is on the website, so the choice is not offered.
    expect(
      within(dialog).queryByLabelText(/^Visa på föreningens webbplats/u),
    ).toBeNull();
    expect(
      within(dialog).getByText(
        "Skickar ett e-postmeddelande till alla i Styrelsen när inlägget publiceras.",
      ),
    ).toBeTruthy();
    await userEvent.type(within(dialog).getByLabelText(/^Rubrik/u), "Budget");
    await userEvent.type(within(dialog).getByLabelText("Text"), "Utkast.");
    await userEvent.click(
      within(dialog).getByLabelText(/^Viktigt meddelande/u),
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Skapa" }),
    );

    expect(writeBoardPost).toHaveBeenCalledWith(
      expect.objectContaining({
        audienceId: "audience-board",
        important: true,
        onWebsite: false,
      }),
    );
  });

  it("keeps a group among the choices for the writer, and not for Styrelsen", async () => {
    const dialog = openAsBoard();
    const to = (): string[] =>
      within(within(dialog).getByLabelText("Till"))
        .getAllByRole("option")
        .map((option) => option.textContent ?? "");

    expect(to()).toContain("Trädgården");
    await userEvent.selectOptions(
      within(dialog).getByLabelText("Till"),
      "audience-group",
    );
    await userEvent.selectOptions(
      within(dialog).getByLabelText("Från"),
      "Styrelsen",
    );
    expect(to()).not.toContain("Trädgården");
    // The group was not among them, so Alla is chosen instead.
    expect(
      (within(dialog).getByLabelText("Till") as HTMLSelectElement).value,
    ).toBe("audience-all");
  });

  it("schedules a post for the instant chosen on the writer's own clock", async () => {
    writeBoardPost.mockResolvedValue(ok(post({ id: "post-1" })));
    const dialog = openAsBoard();

    await userEvent.selectOptions(
      within(dialog).getByLabelText("Från"),
      "Styrelsen",
    );
    await userEvent.type(within(dialog).getByLabelText(/^Rubrik/u), "Städdag");
    await userEvent.type(within(dialog).getByLabelText("Text"), "Lördag.");
    await userEvent.type(
      within(dialog).getByLabelText(/^Schemalägg publicering/u),
      "2030-05-04T10:00",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Schemalägg" }),
    );

    expect(writeBoardPost).toHaveBeenCalledWith(
      expect.objectContaining({
        namesAuthor: false,
        scheduledAt: new Date("2030-05-04T10:00").toISOString(),
      }),
    );
  });

  it("previews the post as it will read, from Styrelsen", async () => {
    const dialog = openAsBoard();

    await userEvent.selectOptions(
      within(dialog).getByLabelText("Från"),
      "Styrelsen",
    );
    await userEvent.type(within(dialog).getByLabelText(/^Rubrik/u), "Städdag");
    await userEvent.type(within(dialog).getByLabelText("Text"), "Lördag.");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Förhandsgranska" }),
    );

    const preview = within(dialog).getByRole("region", {
      name: "Förhandsgranskning",
    });
    expect(within(preview).getByText("Styrelsen")).toBeTruthy();
    expect(
      within(preview).getByRole("heading", { name: "Städdag" }),
    ).toBeTruthy();
  });

  it("says what the server refused, and keeps the draft", async () => {
    writeBoardPost.mockResolvedValue(refused(422, "not-board"));
    const dialog = openAsBoard();

    await userEvent.selectOptions(
      within(dialog).getByLabelText("Från"),
      "Styrelsen",
    );
    await userEvent.type(within(dialog).getByLabelText(/^Rubrik/u), "Städdag");
    await userEvent.type(within(dialog).getByLabelText("Text"), "Lördag.");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Skapa" }),
    );

    expect(
      await within(dialog).findByText(
        "Bara den som sitter i styrelsen kan skriva som Styrelsen eller fästa inlägg.",
      ),
    ).toBeTruthy();
    expect(
      (within(dialog).getByLabelText("Text") as HTMLTextAreaElement).value,
    ).toBe("Lördag.");
  });
});
