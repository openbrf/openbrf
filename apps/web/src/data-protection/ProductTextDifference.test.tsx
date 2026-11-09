import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { ProcessingActivityView } from "../api/data-protection";
import { ProductTextDifference } from "./ProductTextDifference";

/**
 * A seeded row the board has edited, whose product text has moved on since.
 *
 * The seed never overwrites the board's wording, so the screen is the only
 * place the board learns that the product now says something else. What this
 * file pins down: the marker is a sentence, the two texts stand side by side,
 * adopting names the field and the revision the screen read and never a value,
 * and a row with nothing to show shows nothing.
 */

const adoptProductText = vi.fn();

vi.mock("../api/data-protection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/data-protection")>()),
  adoptProductText: (activityId: string, input: unknown) =>
    adoptProductText(activityId, input),
}));

const EDITED_ROW: ProcessingActivityView = {
  activityId: "activity-key-orders",
  name: "Nyckelbeställningar",
  purpose: "Hantera beställningar av nycklar och taggar.",
  legalBasis: "CONTRACT",
  legalBasisNote: null,
  dataSubjectCategories: ["member", "resident"],
  personalDataCategories: ["name", "apartment"],
  recipients: null,
  thirdCountryTransfer: false,
  thirdCountrySafeguards: null,
  retention: "Tills nyckeln lämnas tillbaka, enligt styrelsen.",
  securityMeasures: null,
  source: "SERVICE_DATA",
  sourceKey: "keyOrders",
  endedAt: null,
  seeded: false,
  revision: 7,
  productDiffers: true,
  productText: {
    retention: "Två år efter att beställningen avslutats.",
    legalBasis: "LEGITIMATE_INTEREST",
  },
};

beforeEach(() => {
  adoptProductText
    .mockReset()
    .mockResolvedValue({ ok: true, value: EDITED_ROW });
});

describe("a board-edited row whose product text has moved on", () => {
  it("says so in words, with the board's text beside the product's", () => {
    render(<ProductTextDifference activity={EDITED_ROW} onAdopted={vi.fn()} />);

    expect(screen.getByText("Skiljer sig från produktens text")).not.toBeNull();
    expect(
      screen.getByText("Tills nyckeln lämnas tillbaka, enligt styrelsen."),
    ).not.toBeNull();
    expect(
      screen.getByText("Två år efter att beställningen avslutats."),
    ).not.toBeNull();
    // An enum is said in the board's words, not as the stored value.
    expect(screen.getByText("Avtal")).not.toBeNull();
    expect(screen.getByText("Berättigat intresse")).not.toBeNull();
    expect(
      screen.getAllByRole("button", { name: "Använd produktens text" }),
    ).toHaveLength(2);
  });

  it("adopts one field, naming it and the revision read, and reads again", async () => {
    const onAdopted = vi.fn();
    render(
      <ProductTextDifference activity={EDITED_ROW} onAdopted={onAdopted} />,
    );

    const retention = screen.getByRole("button", {
      name: "Använd produktens text",
      description: "Bevarande",
    });
    fireEvent.click(retention);

    await waitFor(() => {
      expect(onAdopted).toHaveBeenCalledTimes(1);
    });
    expect(adoptProductText).toHaveBeenCalledWith("activity-key-orders", {
      fields: ["retention"],
      expectedRevision: 7,
    });
  });

  it("allows one adoption at a time", () => {
    adoptProductText.mockReturnValue(new Promise(() => undefined));
    render(<ProductTextDifference activity={EDITED_ROW} onAdopted={vi.fn()} />);

    const [first] = screen.getAllByRole("button", {
      name: "Använd produktens text",
    });
    if (first === undefined) {
      throw new Error("no adopt button");
    }
    fireEvent.click(first);

    for (const button of screen.getAllByRole("button")) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
    expect(adoptProductText).toHaveBeenCalledTimes(1);
  });

  it("holds the next adoption until the read brings the row the last one wrote", async () => {
    adoptProductText.mockResolvedValue({
      ok: true,
      value: { ...EDITED_ROW, revision: 8 },
    });
    const onAdopted = vi.fn();
    const { rerender } = render(
      <ProductTextDifference activity={EDITED_ROW} onAdopted={onAdopted} />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Använd produktens text",
        description: "Bevarande",
      }),
    );
    await waitFor(() => {
      expect(onAdopted).toHaveBeenCalledTimes(1);
    });

    // The adoption is answered, but the screen still holds revision 7: a
    // second adoption sent with it would be refused.
    const legalBasis = () =>
      screen.getByRole("button", {
        name: "Använd produktens text",
        description: "Rättslig grund",
      }) as HTMLButtonElement;
    expect(legalBasis().disabled).toBe(true);

    rerender(
      <ProductTextDifference
        activity={{
          ...EDITED_ROW,
          revision: 8,
          retention: "Två år efter att beställningen avslutats.",
          productText: { legalBasis: "LEGITIMATE_INTEREST" },
        }}
        onAdopted={onAdopted}
      />,
    );
    expect(legalBasis().disabled).toBe(false);
  });

  it("says the row moved, and reads it again, when the adoption is refused for it", async () => {
    adoptProductText.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "activity-changed" },
    });
    const onAdopted = vi.fn();
    render(
      <ProductTextDifference activity={EDITED_ROW} onAdopted={onAdopted} />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Använd produktens text",
        description: "Bevarande",
      }),
    );

    expect(
      await screen.findByText(/Raden ändrades efter att den lästes/),
    ).not.toBeNull();
    expect(onAdopted).toHaveBeenCalledTimes(1);
  });

  it("shows nothing on a row whose product text says what the row says", () => {
    const { container } = render(
      <ProductTextDifference
        activity={{ ...EDITED_ROW, productDiffers: false, productText: {} }}
        onAdopted={vi.fn()}
      />,
    );
    expect(container.textContent).toBe("");
  });
});
