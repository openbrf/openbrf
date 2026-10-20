import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vite-plus/test";

import {
  type InstanceBinding,
  judgeEntitlement,
  type LicenceReader,
  type StoredLicence,
} from "./entitlement-judgement";
import type { LicencePayload } from "./licence-file";
import {
  fingerprintOf,
  issueLicence,
  type TestKey,
  testKey,
  testLicenceManifest,
  testPayload,
} from "./testing/licence-fixtures";

const issuer = testKey();
const instanceKey = testKey();
const instance: InstanceBinding = {
  instanceId: "4f1d2a9e-7c3b-4b6e-8f0a-1d2c3b4a5e6f",
  instanceKey: instanceKey.base64url,
};
const reader: LicenceReader = testLicenceManifest({
  keys: { "test-1": issuer },
});

let entered = 0;

/** A licence as entered and checked under `key`, entered after the last. */
function stored(
  payload: Partial<LicencePayload> = {},
  options: { key?: TestKey; file?: Buffer } = {},
): StoredLicence {
  const key = options.key ?? issuer;
  const full = testPayload({
    instanceId: instance.instanceId,
    instanceKey: instance.instanceKey,
    ...payload,
  });
  entered += 1;
  return {
    id: `licence-${String(entered)}`,
    file: options.file ?? issueLicence({ key, payload: full }),
    enteredAt: new Date(Date.UTC(2026, 10, 1, 0, entered)),
    verifiedKeyFingerprint: fingerprintOf(key),
    entitlements: Object.keys(full.entitlements),
  };
}

function judge(
  licences: StoredLicence[],
  today = "2026-12-15",
  forReader: LicenceReader = reader,
) {
  return judgeEntitlement({ licences, reader: forReader, instance, today });
}

describe("judgeEntitlement", () => {
  it("is active for a licence bound to this instance, within its dates", () => {
    const licence = stored({
      entitlements: {
        "mcp-connector": {
          validUntil: "2027-11-30",
          updatesUntil: "2027-06-30",
        },
      },
    });
    const judgement = judge([licence]);

    expect(judgement.state).toEqual({
      status: "active",
      licenceId: expect.any(String),
      validUntil: "2027-11-30",
      updatesUntil: "2027-06-30",
    });
    expect(judgement.selected?.licence.id).toBe(licence.id);
  });

  it("is active without an end for a licence that has none", () => {
    expect(
      judge([stored({ entitlements: { "mcp-connector": {} } })]).state,
    ).toMatchObject({ status: "active", validUntil: null, updatesUntil: null });
  });

  it("is absent with no licence entered", () => {
    expect(judge([])).toEqual({ state: { status: "absent" }, selected: null });
  });

  it("is absent for a licence that names only other entitlements", () => {
    expect(
      judge([stored({ entitlements: { "ai-package": {} } })]).state,
    ).toEqual({ status: "absent" });
  });

  it("is expired the day after validUntil, and active through it", () => {
    const licence = stored({
      entitlements: { "mcp-connector": { validUntil: "2026-12-15" } },
    });

    expect(judge([licence], "2026-12-15").state.status).toBe("active");
    const expired = judge([licence], "2026-12-16");
    expect(expired.state).toEqual({
      status: "expired",
      licenceId: expect.any(String),
      validUntil: "2026-12-15",
    });
    expect(expired.selected).toBeNull();
  });

  it("is not yet valid for a licence issued after today", () => {
    expect(judge([stored({ issuedOn: "2026-12-16" })]).state).toEqual({
      status: "not-yet-valid",
      licenceId: expect.any(String),
      issuedOn: "2026-12-16",
    });
  });

  it("covers a release published on or before updatesUntil, and not after", () => {
    const licence = stored({
      entitlements: { "mcp-connector": { updatesUntil: "2026-12-01" } },
    });

    expect(judge([licence]).state.status).toBe("active");
    expect(
      judge([licence], "2026-12-15", { ...reader, released: "2026-12-02" })
        .state,
    ).toEqual({
      status: "version-not-covered",
      licenceId: expect.any(String),
      updatesUntil: "2026-12-01",
      released: "2026-12-02",
    });
  });

  it("is wrong-instance for a licence issued to another instance id", () => {
    expect(judge([stored({ instanceId: randomUUID() })]).state).toEqual({
      status: "wrong-instance",
      licenceId: expect.any(String),
    });
  });

  it("is wrong-instance for a licence naming this id with another key", () => {
    // A copied database without the instance's key, given a licence that
    // names the original's id.
    expect(
      judge([stored({ instanceKey: testKey().base64url })]).state.status,
    ).toBe("wrong-instance");
  });

  it("is tampered when a checked licence's bytes were changed since", () => {
    const genuine = stored({
      entitlements: { "mcp-connector": { validUntil: "2026-12-01" } },
    });
    // The end date moved on by editing the row, which the signature covers.
    const text = Buffer.from(genuine.file).toString("utf8");
    const envelope = JSON.parse(text) as { payload: string };
    const payload = JSON.parse(
      Buffer.from(envelope.payload, "base64url").toString(),
    ) as LicencePayload;
    payload.entitlements["mcp-connector"] = { validUntil: "2099-12-31" };
    const edited = Buffer.from(
      JSON.stringify({
        ...envelope,
        payload: Buffer.from(JSON.stringify(payload)).toString("base64url"),
      }),
    );

    expect(judge([{ ...genuine, file: edited }])).toEqual({
      state: { status: "tampered" },
      selected: null,
    });
  });

  it("reads no licence its own keys did not verify", () => {
    // Checked under another plugin's key, or not yet checked at all.
    const other = testKey();
    expect(judge([stored({}, { key: other })]).state).toEqual({
      status: "absent",
    });
    expect(
      judge([{ ...stored(), verifiedKeyFingerprint: null }]).state,
    ).toEqual({ status: "absent" });
  });

  it("keeps two plugins with one key id and different keys apart", () => {
    const otherIssuer = testKey();
    const connector = testLicenceManifest({ keys: { "test-1": issuer } });
    const lookalike = testLicenceManifest({ keys: { "test-1": otherIssuer } });
    const genuine = stored();

    expect(judge([genuine], "2026-12-15", connector).state.status).toBe(
      "active",
    );
    // The other plugin's key does not verify it, and that is not tampering.
    expect(judge([genuine], "2026-12-15", lookalike).state).toEqual({
      status: "absent",
    });
    const theirs = stored({}, { key: otherIssuer });
    expect(
      judge([genuine, theirs], "2026-12-15", connector).selected?.licence.id,
    ).toBe(genuine.id);
    expect(
      judge([genuine, theirs], "2026-12-15", lookalike).selected?.licence.id,
    ).toBe(theirs.id);
  });

  it("reports a tampered licence only to the entitlement it named", () => {
    const themes = stored({ entitlements: { themes: {} } });
    const spoiled = { ...themes, file: Buffer.from("{}") };
    expect(judge([spoiled]).state).toEqual({ status: "absent" });
  });

  it("lets a licence bought outright stand when a subscription beside it lapses", () => {
    const bought = stored({
      entitlements: { "mcp-connector": { updatesUntil: "2027-11-02" } },
    });
    const subscription = stored({
      entitlements: {
        "ai-package": { validUntil: "2026-12-31" },
        "mcp-connector": { validUntil: "2026-12-31" },
      },
    });

    // A licence with no end counts as ending last, so it is the one selected
    // from the start, and the subscription's lapse changes nothing for it.
    expect(judge([bought, subscription]).selected?.licence.id).toBe(bought.id);
    const after = judge([bought, subscription], "2027-01-01");
    expect(after.state.status).toBe("active");
    expect(after.selected?.licence.id).toBe(bought.id);
    // The subscription alone lapses.
    expect(judge([subscription], "2027-01-01").state.status).toBe("expired");
  });

  it("reports the finding of the licence entered last when none is active", () => {
    const expired = stored({
      entitlements: { "mcp-connector": { validUntil: "2026-01-31" } },
    });
    const foreign = stored({ instanceId: randomUUID() });

    expect(judge([expired, foreign]).state.status).toBe("wrong-instance");
    expect(judge([foreign, expired]).state.status).toBe("wrong-instance");
  });

  describe("the selection among active licences", () => {
    const longest = stored({
      licenceId: "00000000-0000-4000-8000-000000000009",
      entitlements: { "mcp-connector": { validUntil: "2028-01-01" } },
    });
    const openEnded = stored({
      licenceId: "00000000-0000-4000-8000-000000000008",
      entitlements: { "mcp-connector": {} },
    });
    const sameEndMoreUpdates = stored({
      licenceId: "00000000-0000-4000-8000-000000000007",
      entitlements: {
        "mcp-connector": {
          validUntil: "2028-01-01",
          updatesUntil: "2027-06-01",
        },
      },
    });
    const twinLaterIssue = stored({
      licenceId: "00000000-0000-4000-8000-000000000006",
      issuedOn: "2026-12-01",
      entitlements: { "mcp-connector": { validUntil: "2027-01-31" } },
    });
    const twinEarlierIssue = stored({
      licenceId: "00000000-0000-4000-8000-000000000005",
      issuedOn: "2026-11-01",
      entitlements: { "mcp-connector": { validUntil: "2027-01-31" } },
    });
    const twinLowerId = stored({
      licenceId: "00000000-0000-4000-8000-000000000001",
      issuedOn: "2026-11-01",
      entitlements: { "mcp-connector": { validUntil: "2027-01-31" } },
    });
    const all = [
      longest,
      openEnded,
      sameEndMoreUpdates,
      twinLaterIssue,
      twinEarlierIssue,
      twinLowerId,
    ];

    function permutations<T>(items: T[]): T[][] {
      if (items.length <= 1) {
        return [items];
      }
      return items.flatMap((item, index) =>
        permutations([...items.slice(0, index), ...items.slice(index + 1)]).map(
          (rest) => [item, ...rest],
        ),
      );
    }

    it("selects the same licence whatever order they were entered in", () => {
      for (const order of permutations(all)) {
        expect(judge(order).selected?.licence.id).toBe(openEnded.id);
      }
    });

    it("prefers the latest validUntil, then the latest updatesUntil, then the latest issuedOn, then the lowest id", () => {
      const without = (...left: StoredLicence[]) =>
        all.filter((licence) => !left.includes(licence));

      expect(judge(without(openEnded)).selected?.licence.id).toBe(longest.id);
      expect(judge([sameEndMoreUpdates, longest]).selected?.licence.id).toBe(
        longest.id,
      );
      expect(
        judge([twinEarlierIssue, twinLaterIssue]).selected?.licence.id,
      ).toBe(twinLaterIssue.id);
      expect(judge([twinEarlierIssue, twinLowerId]).selected?.licence.id).toBe(
        twinLowerId.id,
      );
    });

    it("hands over to the next one when the selected licence ends", () => {
      const ending = stored({
        entitlements: { "mcp-connector": { validUntil: "2026-12-20" } },
      });
      const next = stored({
        entitlements: { "mcp-connector": { validUntil: "2026-12-10" } },
      });
      const after = stored({
        entitlements: { "mcp-connector": { validUntil: "2027-03-01" } },
        issuedOn: "2026-12-21",
      });

      expect(
        judge([ending, next, after], "2026-12-05").selected?.licence.id,
      ).toBe(ending.id);
      expect(
        judge([ending, next, after], "2026-12-21").selected?.licence.id,
      ).toBe(after.id);
    });
  });
});
