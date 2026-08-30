import { Injectable, Logger } from "@nestjs/common";

import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { HttpGatewaySmsDriver } from "./http-gateway.driver";
import { NoSmsProviderDriver } from "./no-provider.driver";
import type { SmsDriver, SmsDriverKind, SmsMessage } from "./sms.driver";

/**
 * The one way out of this application by text message.
 *
 * Which driver is behind it is the association's own configuration, and nothing
 * above this line is allowed to care: the service exposes the driver's one
 * operation and no way to ask a provider anything else. Sending is all a
 * cooperative needs SMS for, so sending is all the platform can do with it -
 * there is no method here through which a member's number could be enrolled in
 * a provider's address book or asked after once the message has gone.
 *
 * Unlike file storage, this is configured from the settings row rather than the
 * environment. Storage is a property of the deployment, chosen once by whoever
 * runs the container; an SMS provider is a contract the board signs and pays
 * for, so it is turned on deliberately from the settings screen and can be
 * changed there without a restart.
 */

/** What an instance has stored about its SMS provider. */
export interface SmsSettings {
  driver: string;
  /** Where the HTTP gateway driver posts. */
  gatewayUrl: string | null;
  /** Bearer credential for the gateway, in plaintext. Never logged, never returned. */
  gatewayToken: string | null;
  /** Sender name to present, where the provider supports one. */
  senderName: string | null;
}

/**
 * Whether the stored settings amount to a provider that could actually send.
 *
 * One function, used both to build the driver and to answer the settings
 * screen, so "the screen says it is set up" and "a message would go out" cannot
 * come apart. A driver named without the settings it needs is not a provider
 * half-configured: it is an instance that cannot send, and it is reported as
 * exactly that.
 */
export function selectedDriverKind(settings: {
  driver: string | null;
  gatewayUrl: string | null;
}): SmsDriverKind {
  // A present but empty address counts as absent. The settings screen refuses
  // one, but this row outlives that check - a restore, or a value written
  // before it existed - and a driver told to post to nowhere is an instance
  // that cannot send.
  if (
    settings.driver === "http-gateway" &&
    (settings.gatewayUrl ?? "").trim() !== ""
  ) {
    return "http-gateway";
  }
  return "none";
}

/**
 * Builds the configured driver.
 *
 * The kind is a plain string in the database rather than an enumerated type,
 * because the point of an adapter is that a driver can be added without a
 * migration. A value this function does not recognise is answered with the
 * no-provider driver rather than a guess: an instance whose settings name a
 * driver that is not installed cannot send, and refusing at the send is what
 * puts that on the board's screen.
 */
export function createDriver(settings: SmsSettings | null): SmsDriver {
  if (settings === null) {
    return new NoSmsProviderDriver();
  }

  switch (selectedDriverKind(settings)) {
    case "http-gateway": {
      return new HttpGatewaySmsDriver({
        // Non-null by the selection above: "http-gateway" is only returned once
        // the address is present.
        endpoint: settings.gatewayUrl ?? "",
        ...(settings.gatewayToken === null
          ? {}
          : { token: settings.gatewayToken }),
      });
    }
    default: {
      return new NoSmsProviderDriver();
    }
  }
}

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);
  private driver: SmsDriver = new NoSmsProviderDriver();
  /** Fingerprint of the settings the cached driver was built from. */
  private driverKey: string | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: FieldEncryptionService,
  ) {}

  /**
   * Whether this instance can send a text message at all.
   *
   * Exposed because the news screen offers the mailing only where it could
   * work, and because the settings screen has to be able to say plainly that it
   * cannot - rather than letting a board discover it from a column of failed
   * deliveries.
   *
   * Reads the two plain columns and never the credential: a presence check has
   * no use for the token, and going through the loader would decrypt a stored
   * secret every time a screen asks whether SMS works at all.
   */
  async isConfigured(): Promise<boolean> {
    const association = await this.prisma.association.findUnique({
      where: { id: 1 },
      select: { smsDriver: true, smsGatewayUrl: true },
    });

    return (
      association !== null &&
      selectedDriverKind({
        driver: association.smsDriver,
        gatewayUrl: association.smsGatewayUrl,
      }) !== "none"
    );
  }

  /**
   * Sends one message, through whichever driver the association configured.
   *
   * The sender name is applied here rather than by the caller, because it is a
   * property of the association's provider contract and not of the message: a
   * news notice and a settings test send are both from the cooperative.
   */
  async send(message: Omit<SmsMessage, "sender">): Promise<void> {
    const settings = await this.loadSettings();
    const driver = this.driverFor(settings);

    await driver.send({
      to: message.to,
      body: message.body,
      ...(settings?.senderName == null ? {} : { sender: settings.senderName }),
    });
  }

  private async loadSettings(): Promise<SmsSettings | null> {
    const association = await this.prisma.association.findUnique({
      where: { id: 1 },
      select: {
        smsDriver: true,
        smsGatewayUrl: true,
        smsGatewayTokenCipher: true,
        smsSenderName: true,
      },
    });

    if (association === null || association.smsDriver === null) {
      return null;
    }

    const gatewayToken =
      association.smsGatewayTokenCipher === null
        ? null
        : await this.encryption.decrypt(
            "association.smsGatewayToken",
            association.smsGatewayTokenCipher,
          );

    return {
      driver: association.smsDriver,
      gatewayUrl: association.smsGatewayUrl,
      gatewayToken,
      senderName: association.smsSenderName,
    };
  }

  /**
   * The driver for these settings, rebuilt only when they change.
   *
   * Keyed on the settings rather than built once at boot, because they are
   * edited from the settings screen and a board that fixes a gateway address
   * must not have to restart the instance to be believed.
   */
  private driverFor(settings: SmsSettings | null): SmsDriver {
    const key = JSON.stringify(
      settings === null
        ? null
        : [
            settings.driver,
            settings.gatewayUrl,
            settings.gatewayToken,
            settings.senderName,
          ],
    );

    if (this.driverKey !== key) {
      this.driver = createDriver(settings);
      this.driverKey = key;
      // The kind only. The address is an endpoint an administrator configured
      // and the token is a secret; neither belongs in a log line.
      this.logger.log(`SMS driver: ${this.driver.kind}`);
    }

    return this.driver;
  }
}
