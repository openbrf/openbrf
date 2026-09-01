import { describe, expect, it } from "vitest";

import type { ApiFailure } from "../api/client";
import { motionFailureKey, scannedParts } from "./motion-failures";

/**
 * The refusals the motion screens read, and the part names they act on.
 *
 * `scannedParts` feeds a sentence that tells a member which field to edit, so
 * what it returns has to be a name the screen can actually render. Everything
 * else in this file is the one refusal that has to be resolved before the shared
 * 403 branch gets to it.
 */

const forbidden = (reason: string, detail?: unknown): ApiFailure => ({
  status: 403,
  reason,
  detail,
});

describe("the part names a scan refusal carries", () => {
  it("names the fields the refusal pointed at, once each", () => {
    expect(
      scannedParts(
        forbidden("personal-identity-number", [
          { part: "body", offset: 12 },
          { part: "title", offset: 3 },
          { part: "body", offset: 80 },
        ]),
      ),
    ).toEqual(["body", "title"]);
  });

  it("drops a part name this client cannot render", () => {
    /*
     * The screen has one sentence for the heading and one for the proposal, and
     * no third. A name it does not know would be folded into the proposal by the
     * only branch there is, so a member would be sent to edit text that holds
     * nothing while the personal identity number stayed where it was - and the
     * motion would be refused again for a reason they had just been told they
     * had fixed.
     */
    expect(
      scannedParts(
        forbidden("personal-identity-number", [
          { part: "attachment", offset: 0 },
          { part: "title", offset: 4 },
        ]),
      ),
    ).toEqual(["title"]);
  });

  it("answers a refusal that carries no locations with nothing", () => {
    expect(scannedParts(forbidden("personal-identity-number"))).toEqual([]);
    expect(scannedParts(forbidden("personal-identity-number", {}))).toEqual([]);
    expect(
      scannedParts(forbidden("personal-identity-number", [null, "body", 7])),
    ).toEqual([]);
  });
});

describe("the sentence a refusal maps to", () => {
  it("gives not-a-member its own sentence rather than the shared 403 one", () => {
    // Both are 403. The shared branch answers every one of them with "your
    // account is not allowed to change this", which is the wrong thing to tell
    // somebody being told what the statute says about who may put an item to a
    // general meeting.
    expect(motionFailureKey(forbidden("not-a-member"))).toBe(
      "motions.errors.notAMember",
    );
    expect(motionFailureKey(forbidden("something-else"))).toBe(
      "settings.errors.forbidden",
    );
  });
});
