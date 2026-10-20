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
 */

const uploadPostImage = vi.fn();
const writePost = vi.fn();

vi.mock("../api/feed", () => ({
  uploadPostImage: (input: unknown) => uploadPostImage(input),
  writePost: (input: unknown) => writePost(input),
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
      audience={{ id: "audience-all", name: "Alla" }}
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
