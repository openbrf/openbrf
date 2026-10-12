import { HOUSING_COOPERATIVE_LIMITS } from "@openbrf/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import "../i18n";
import { HousingCooperativePanel } from "./HousingCooperativePanel";

/**
 * The housing cooperative's name and identity.
 *
 * The field's length is the server's, read from the same constant: a name the
 * field accepted and the save refused would be refused with no word on which
 * length was wrong.
 */
describe("the housing cooperative's name", () => {
  it("is held to the length the server accepts", () => {
    render(<HousingCooperativePanel value={null} />);

    expect(screen.getByLabelText("Namn")).toHaveProperty(
      "maxLength",
      HOUSING_COOPERATIVE_LIMITS.name,
    );
  });
});
