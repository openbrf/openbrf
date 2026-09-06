import { describe, expect, it } from "vitest";

import {
  currentProcessors,
  type OpenAgreementRow,
  type ProcessorFacts,
} from "./processors";

function facts(overrides: Partial<ProcessorFacts> = {}): ProcessorFacts {
  return {
    smtpHost: "smtp.example.test",
    smtpFromAddress: "styrelsen@granngarden.test",
    smsDriver: null,
    smsGatewayUrl: null,
    storageDriver: "local",
    s3Endpoint: null,
    s3Region: null,
    s3Bucket: null,
    installedPlugins: [],
    ...overrides,
  };
}

function row(overrides: Partial<OpenAgreementRow> = {}): OpenAgreementRow {
  return {
    processorKey: "smtp",
    classification: "PROCESSOR",
    status: "IN_PLACE",
    counterparty: "Mailleverantoren AB",
    ...overrides,
  };
}

function keys(descriptors: { processorKey: string }[]): string[] {
  return descriptors.map((descriptor) => descriptor.processorKey);
}

describe("currentProcessors", () => {
  it("lists the mail server when both the host and the sender are configured", () => {
    const descriptors = currentProcessors(facts(), []);

    expect(descriptors[0]).toMatchObject({
      processorKey: "smtp",
      processorKind: "SMTP",
      identity: "smtp.example.test",
      detail: "styrelsen@granngarden.test",
      state: "notRecorded",
    });
  });

  it("lists no mail server when the instance cannot send", () => {
    // A host with no sender address sends nothing, which the settings screen
    // already reports as an instance that cannot send.
    expect(
      keys(currentProcessors(facts({ smtpFromAddress: null }), [])),
    ).not.toContain("smtp");
    expect(
      keys(currentProcessors(facts({ smtpHost: null }), [])),
    ).not.toContain("smtp");
  });

  it("lists no SMS recipient on an instance with no provider", () => {
    /*
     * An instance with no SMS provider hands nobody anything by that channel.
     * A row asking the board to classify a gateway it does not use would be a
     * false entry in a statutory record.
     */
    expect(keys(currentProcessors(facts(), []))).not.toContain("sms");
  });

  it("names the SMS gateway by its host once one is configured", () => {
    const descriptors = currentProcessors(
      facts({
        smsDriver: "http-gateway",
        smsGatewayUrl: "https://sms.example.test/v2/send",
      }),
      [],
    );

    expect(descriptors.find((d) => d.processorKey === "sms")).toMatchObject({
      processorKind: "SMS",
      identity: "sms.example.test",
    });
  });

  it("treats a driver named without its address as no provider at all", () => {
    // The rule selectedDriverKind already applies for the settings screen, so
    // the record and the screen cannot come apart.
    expect(
      keys(
        currentProcessors(
          facts({ smsDriver: "http-gateway", smsGatewayUrl: "  " }),
          [],
        ),
      ),
    ).not.toContain("sms");
  });

  it("suggests that the association's own disk is no processor", () => {
    const storage = currentProcessors(facts(), []).find(
      (descriptor) => descriptor.processorKey === "storage",
    );

    expect(storage).toMatchObject({
      // No name: there is no host to read and no bucket to quote, and a
      // placeholder here would reach a Swedish board as an English word. The
      // screen calls the row by its kind, in the reader's own language.
      identity: null,
      seededClassification: "NOT_A_PROCESSOR",
      state: "notRecorded",
    });
  });

  it("names an object store by endpoint and bucket, with the configured region beside it", () => {
    const storage = currentProcessors(
      facts({
        storageDriver: "s3",
        s3Endpoint: "https://s3.example.test",
        s3Bucket: "granngarden",
        s3Region: "eu-north-1",
      }),
      [],
    ).find((descriptor) => descriptor.processorKey === "storage");

    expect(storage).toMatchObject({
      identity: "https://s3.example.test / granngarden",
      detail: "eu-north-1",
      // No suggestion: where a bucket is, and who runs it, is the board's to
      // answer and not something the endpoint discloses.
      seededClassification: null,
    });
  });

  it("always lists hosting, because somebody runs the machine", () => {
    const descriptors = currentProcessors(facts(), []);

    expect(keys(descriptors)).toContain("hosting");
    // And with no name, for the same reason the local disk has none: the
    // instance cannot see who runs the machine it is running on. That row
    // exists to be answered by the only party who knows.
    expect(
      descriptors.find((descriptor) => descriptor.processorKey === "hosting"),
    ).toMatchObject({ identity: null, seededClassification: null });
  });

  it("lists one recipient per installed plugin, named by its package", () => {
    const descriptors = currentProcessors(
      facts({
        installedPlugins: [
          {
            id: "occupancy",
            packageName: "@openbrf/occupancy",
            version: "1.2.0",
          },
        ],
      }),
      [],
    );

    expect(
      descriptors.find((d) => d.processorKey === "plugin:occupancy"),
    ).toMatchObject({
      processorKind: "PLUGIN",
      identity: "@openbrf/occupancy",
      detail: "1.2.0",
      state: "notRecorded",
    });
  });

  it("lists a board-recorded recipient by its counterparty", () => {
    const descriptors = currentProcessors(facts(), [
      row({
        processorKey: "external:clx1",
        classification: "PROCESSOR",
        status: "PENDING",
        counterparty: "Ekonomisk forvaltning AB",
      }),
    ]);

    expect(
      descriptors.find((d) => d.processorKind === "EXTERNAL"),
    ).toMatchObject({
      processorKey: "external:clx1",
      identity: "Ekonomisk forvaltning AB",
      state: "pending",
    });
  });

  describe("the state a recorded row produces", () => {
    it.each([
      ["an agreement in place", "PROCESSOR", "IN_PLACE", "inPlace"],
      ["an agreement being made", "PROCESSOR", "PENDING", "pending"],
      ["no processor", "NOT_A_PROCESSOR", null, "notAProcessor"],
      [
        "a controller of its own",
        "INDEPENDENT_CONTROLLER",
        null,
        "independentController",
      ],
    ])("reads %s", (_label, classification, status, expected) => {
      const descriptors = currentProcessors(facts(), [
        row({
          processorKey: "smtp",
          classification: classification as OpenAgreementRow["classification"],
          status: status as OpenAgreementRow["status"],
        }),
      ]);

      expect(descriptors[0]?.state).toBe(expected);
    });

    it("is notRecorded when the board has not been asked yet", () => {
      // The absence of a row, never a stored status: a stored "unrecorded"
      // would be a claim, and this is the lack of one.
      expect(currentProcessors(facts(), [])[0]?.state).toBe("notRecorded");
    });
  });
});
