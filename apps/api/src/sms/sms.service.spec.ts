import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { FieldEncryptionService } from "../crypto/field-encryption.service";
import type { PrismaService } from "../database/prisma.service";
import { HttpGatewaySmsDriver } from "./http-gateway.driver";
import { NoSmsProviderDriver } from "./no-provider.driver";
import { SmsNotConfiguredError } from "./sms.driver";
import { createDriver, selectedDriverKind, SmsService } from "./sms.service";
import {
  startSmsGatewayTestServer,
  type SmsGatewayTestServer,
} from "./testing/sms-gateway-test-server";

/**
 * Which driver an instance's settings amount to, and what happens when they
 * amount to none.
 *
 * The selection is the whole of the adapter's promise: a driver is chosen from
 * stored settings and nothing above it learns which. What these cases hold it
 * to is that an instance which cannot send says so - never that it silently
 * drops a message, and never that it guesses at a provider.
 */

const NO_SETTINGS = null;

/**
 * The gateway the service really sends through in the cases below.
 *
 * In-process, so the suite reaches no network and can still assert what a
 * provider would have received. Sending through the real driver rather than a
 * stub of its method is what makes "the service applies the association's
 * sender name" an assertion about the message that went out.
 */
let gateway: SmsGatewayTestServer;

beforeAll(async () => {
  gateway = await startSmsGatewayTestServer();
});

afterAll(async () => {
  await gateway.close();
});

function settings(overrides: Partial<Parameters<typeof createDriver>[0]> = {}) {
  return {
    driver: "http-gateway",
    gatewayUrl: "https://gateway.example/send",
    gatewayToken: "secret",
    senderName: null,
    ...overrides,
  };
}

describe("choosing a driver", () => {
  it("has no provider until an instance configures one", () => {
    expect(createDriver(NO_SETTINGS)).toBeInstanceOf(NoSmsProviderDriver);
  });

  it("builds the gateway driver once a driver and an address are stored", () => {
    expect(createDriver(settings())).toBeInstanceOf(HttpGatewaySmsDriver);
  });

  it("has no provider when the named driver is missing what it needs", () => {
    // Named but unusable is reported as no provider, not as half configured:
    // what a member would experience is that nothing arrived.
    expect(createDriver(settings({ gatewayUrl: null }))).toBeInstanceOf(
      NoSmsProviderDriver,
    );
  });

  it("has no provider when the stored address is blank", () => {
    // The settings screen refuses one, but the row outlives that check: a
    // driver told to post to nowhere is an instance that cannot send.
    expect(createDriver(settings({ gatewayUrl: "   " }))).toBeInstanceOf(
      NoSmsProviderDriver,
    );
  });

  it("has no provider for a driver this build does not carry", () => {
    // The kind is a plain string so a driver can be added without a migration.
    // The cost is a stored name nothing answers to, and the answer is to refuse
    // rather than to guess at the nearest one.
    expect(createDriver(settings({ driver: "some-vendor" }))).toBeInstanceOf(
      NoSmsProviderDriver,
    );
  });

  it("reports the selection the same way the settings screen reads it", () => {
    expect(
      selectedDriverKind({
        driver: "http-gateway",
        gatewayUrl: "https://gateway.example/send",
      }),
    ).toBe("http-gateway");
    expect(selectedDriverKind({ driver: null, gatewayUrl: null })).toBe("none");
  });
});

describe("an instance with no SMS provider", () => {
  it("refuses the send rather than dropping it", async () => {
    await expect(
      new NoSmsProviderDriver().send({ to: "+46700000000", body: "hej" }),
    ).rejects.toBeInstanceOf(SmsNotConfiguredError);
  });
});

function build(row?: Record<string, unknown> | null) {
  const stored =
    row === undefined
      ? {
          smsDriver: "http-gateway",
          smsGatewayUrl: gateway.endpoint,
          smsGatewayTokenCipher: "cipher",
          smsSenderName: "BRF Ekhagen",
        }
      : row;

  const prisma = {
    association: { findUnique: vi.fn().mockResolvedValue(stored) },
  };
  const encryption = { decrypt: vi.fn().mockResolvedValue(gateway.token) };

  return {
    service: new SmsService(
      prisma as unknown as PrismaService,
      encryption as unknown as FieldEncryptionService,
    ),
    prisma,
    encryption,
  };
}

describe("sending through the configured provider", () => {
  it("applies the association's sender name rather than asking the caller for one", async () => {
    const { service } = build();

    await service.send({ to: "+46701234567", body: "Nyhet" });

    // Asserted on what the gateway received, not on what the driver was asked:
    // the sender is a property of the association's provider contract, so it
    // has to reach the wire without every caller remembering it.
    expect(gateway.accepted.at(-1)).toEqual({
      to: "+46701234567",
      message: "Nyhet",
      from: "BRF Ekhagen",
    });
  });

  it("decrypts the gateway credential itself and never reads it from the row", async () => {
    const { service, encryption } = build();

    await service.send({ to: "+46701234567", body: "Nyhet" });

    expect(encryption.decrypt).toHaveBeenCalledWith(
      "association.smsGatewayToken",
      "cipher",
    );
    // The decrypted value, and not the stored ciphertext, is what the gateway
    // was presented with.
    expect(gateway.requests.at(-1)?.authorization).toBe(
      `Bearer ${gateway.token}`,
    );
  });

  it("refuses on an instance that has not been configured", async () => {
    const { service } = build({
      smsDriver: null,
      smsGatewayUrl: null,
      smsGatewayTokenCipher: null,
      smsSenderName: null,
    });

    await expect(
      service.send({ to: "+46701234567", body: "Nyhet" }),
    ).rejects.toBeInstanceOf(SmsNotConfiguredError);
  });

  it("answers the configured question without decrypting the credential", async () => {
    const { service, encryption } = build();

    expect(await service.isConfigured()).toBe(true);
    expect(encryption.decrypt).not.toHaveBeenCalled();
  });

  it("is not configured when there is no housing cooperative yet", async () => {
    const { service } = build(null);

    expect(await service.isConfigured()).toBe(false);
  });
});
