import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import {
  normalizeColor,
  PORTTAVLAN,
  primaryColorOverride,
} from "@openbrf/tokens";

import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { DomainError } from "../http/domain-error";
import { MailNotConfiguredError, MailService } from "../mail/mail.service";
import { smtpTestMail } from "../mail/templates";
import { mediaUrl, MediaService } from "../media/media.service";

/**
 * A contrast pair that stopped a colour from being saved, in the shape the
 * settings screen renders. Token names rather than prose, so the client
 * translates them.
 */
export interface ContrastFailure {
  foreground: string;
  background: string;
  /** Measured ratio, or null when the colour could not be read at all. */
  ratio: number | null;
  required: number;
  /** True when the failing pair is one a statutory register is read on. */
  statutory: boolean;
}

export class SettingsError extends DomainError {
  readonly status: number;

  constructor(
    message: string,
    readonly reason:
      | "housing-cooperative-missing"
      | "colour-unreadable"
      | "colour-fails-contrast"
      | "person-not-found"
      | "no-email",
    /** Populated for colour-fails-contrast, so the screen can name the pairs. */
    readonly findings: readonly ContrastFailure[] = [],
  ) {
    super(message);
    this.status =
      reason === "housing-cooperative-missing"
        ? HttpStatus.CONFLICT
        : reason === "person-not-found"
          ? HttpStatus.NOT_FOUND
          : reason === "no-email"
            ? HttpStatus.UNPROCESSABLE_ENTITY
            : HttpStatus.BAD_REQUEST;
  }
}

export interface HousingCooperativeSettings {
  name: string;
  organizationNumber: string | null;
  defaultLocale: string;
  /** Null while the setup wizard has not been finished. */
  setupCompletedAt: string | null;
}

/** One uploaded logo, as the branding screen and the band need it. */
export interface LogoView {
  /**
   * Where to fetch it: a path on this instance's own origin, whichever driver
   * holds the bytes. Never an address at a storage endpoint.
   */
  url: string;
  fileName: string;
  width: number | null;
  height: number | null;
}

/** Which of the two logo slots a request means. */
export type LogoSlot = "light" | "dark";

export interface BrandingSettings {
  primaryColor: string | null;
  /** The housing cooperative's mark. Null until one is uploaded. */
  logo: LogoView | null;
  /**
   * The variant for dark surfaces. Optional: when it is absent the interface
   * renders the mark above on a light plate in the dark band, rather than
   * letting a dark-ink mark disappear into it.
   */
  logoDark: LogoView | null;
}

export interface SmtpSettingsView {
  host: string | null;
  port: number | null;
  secure: boolean;
  user: string | null;
  fromAddress: string | null;
  /**
   * Whether a password is stored. The password itself is never returned: it is
   * a secret held encrypted at rest, and a settings screen that renders it back
   * turns every board member's browser session into a way to read it.
   */
  passwordSet: boolean;
  /**
   * Whether the instance can send mail at all. Invitations, activation links
   * and sign-in links all depend on it, so the screens say so plainly while it
   * is false.
   */
  configured: boolean;
}

export interface InstanceSettings {
  housingCooperative: HousingCooperativeSettings;
  branding: BrandingSettings;
  smtp: SmtpSettingsView;
  retention: { daysAfterMoveOut: number };
  selfSignup: { enabled: boolean };
}

export interface HousingCooperativeInput {
  name: string;
  organizationNumber?: string | null;
  defaultLocale: string;
}

export interface SmtpInput {
  host: string | null;
  port: number | null;
  secure: boolean;
  user: string | null;
  /** Undefined keeps the stored password; null clears it. */
  password?: string | null;
  fromAddress: string | null;
}

/**
 * The instance's own settings: the housing cooperative's identity, its
 * branding, how it sends mail, how long service data is kept, and whether it
 * accepts sign-up requests.
 *
 * One row, pinned to id 1, because one instance serves exactly one housing
 * cooperative (decision 28).
 *
 * Two rules are enforced here rather than left to callers. The SMTP password
 * goes out of this service only into a transport, never into a response. And a
 * primary colour is measured before it is stored, because the trust accent
 * carries legal meaning in the register and a board picking a colour by eye
 * must not be able to make a statutory document illegible.
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: FieldEncryptionService,
    private readonly mail: MailService,
    private readonly media: MediaService,
  ) {}

  async read(): Promise<InstanceSettings> {
    const association = await this.prisma.association.findUnique({
      where: { id: 1 },
      include: { logo: true, logoDark: true },
    });

    if (association === null) {
      throw new SettingsError(
        "The housing cooperative has not been created yet.",
        "housing-cooperative-missing",
      );
    }

    return {
      housingCooperative: {
        name: association.name,
        organizationNumber: association.organizationNumber,
        defaultLocale: association.defaultLocale,
        setupCompletedAt: association.setupCompletedAt?.toISOString() ?? null,
      },
      branding: {
        primaryColor: association.primaryColor,
        logo: toLogoView(association.logo),
        logoDark: toLogoView(association.logoDark),
      },
      smtp: {
        host: association.smtpHost,
        port: association.smtpPort,
        secure: association.smtpSecure,
        user: association.smtpUser,
        fromAddress: association.smtpFromAddress,
        passwordSet: association.smtpPasswordCipher !== null,
        configured:
          association.smtpHost !== null && association.smtpFromAddress !== null,
      },
      retention: { daysAfterMoveOut: association.retentionDaysAfterMoveOut },
      selfSignup: { enabled: association.selfSignupEnabled },
    };
  }

  /**
   * Creates or renames the housing cooperative.
   *
   * The only settings write that upserts. Every other step of the wizard is
   * skippable, so this one has to be able to create the row that the rest then
   * update - and the name is the one thing the wizard cannot do without.
   */
  async updateHousingCooperative(
    input: HousingCooperativeInput,
  ): Promise<HousingCooperativeSettings> {
    const association = await this.prisma.association.upsert({
      where: { id: 1 },
      create: {
        id: 1,
        name: input.name,
        organizationNumber: input.organizationNumber ?? null,
        defaultLocale: input.defaultLocale,
      },
      update: {
        name: input.name,
        organizationNumber: input.organizationNumber ?? null,
        defaultLocale: input.defaultLocale,
      },
    });

    return {
      name: association.name,
      organizationNumber: association.organizationNumber,
      defaultLocale: association.defaultLocale,
      setupCompletedAt: association.setupCompletedAt?.toISOString() ?? null,
    };
  }

  /**
   * Stores the primary colour, once it is proven legible.
   *
   * The whole accent family is derived from this one value and measured against
   * the contract's contrast matrix in both the light and the dark mode. A
   * failure is refused rather than warned about: the register pairs are
   * statutory, and "the board chose it" is not a defence for a document the law
   * requires the association to be able to produce and read.
   *
   * Passing null clears the override and returns the instance to the default
   * theme's own accent, which is always legible by construction.
   */
  async updateBranding(input: {
    primaryColor: string | null;
  }): Promise<BrandingSettings> {
    await this.requireAssociation();

    if (input.primaryColor === null) {
      await this.prisma.association.update({
        where: { id: 1 },
        data: { primaryColor: null },
      });
      return this.readBranding();
    }

    const result = primaryColorOverride(input.primaryColor, PORTTAVLAN);
    if (!result.ok) {
      if (result.problem.reason === "unreadable-colour") {
        throw new SettingsError(
          "That value is not a colour.",
          "colour-unreadable",
        );
      }
      throw new SettingsError(
        "That colour cannot be read on the surfaces it has to appear on.",
        "colour-fails-contrast",
        result.problem.findings.map((finding) => ({
          foreground: finding.foreground,
          background: finding.background,
          ratio: finding.ratio,
          required: finding.required,
          statutory: finding.statutory,
        })),
      );
    }

    /*
     * The canonical form of the CHOSEN colour, so the same colour typed three
     * ways is one value.
     *
     * Not the derived accent: primaryColorOverride mixes the chosen colour
     * towards each mode's ink until it reads, so override.light["accent-trust"]
     * can be up to MAX_INK_MIX away from what the board typed. Storing that
     * would show a colour nobody chose on the way back out, and - because both
     * the client and this service re-derive both families from the stored value -
     * would make every later derivation start from the light-adjusted value, so
     * the dark family actually applied would be one this contrast check never
     * measured. The register pairs are the statutory ones, so an unmeasured
     * accent must not be able to reach them.
     */
    const stored = normalizeColor(input.primaryColor) ?? input.primaryColor;
    await this.prisma.association.update({
      where: { id: 1 },
      data: { primaryColor: stored },
    });

    this.logger.log("Updated the primary colour");
    return this.readBranding();
  }

  /**
   * Stores an uploaded logo in one of the two slots.
   *
   * The file goes through the media layer like any other, so it is identified
   * from its own bytes, given a generated key, and served from this instance's
   * own origin - which is what an email client and, later, a public visitor
   * will fetch. It is recorded as PUBLIC for exactly that reason: a mark that
   * needed a session could not appear in the message announcing a general
   * meeting.
   *
   * The identifiable-persons declaration is recorded as false rather than asked
   * for. This slot holds the association's mark, published to everyone who
   * receives its email or opens its website; an image of people is not one, and
   * the screen says so where the file is chosen.
   *
   * Replacing a logo deletes the file it replaces. A logo has exactly one
   * referent, so keeping the previous one would leave personal-data-free but
   * unreachable objects accumulating in the bucket forever.
   */
  async updateLogo(input: {
    slot: LogoSlot;
    bytes: Buffer;
    fileName: string;
    actorPersonId: string | null;
  }): Promise<BrandingSettings> {
    await this.requireAssociation();

    const uploaded = await this.media.upload({
      bytes: input.bytes,
      fileName: input.fileName,
      visibility: "PUBLIC",
      showsIdentifiablePersons: false,
      uploadedByPersonId: input.actorPersonId,
      prefix: "branding",
    });

    const previous = await this.replaceLogoReference(input.slot, uploaded.id);
    if (previous !== null) {
      await this.media.remove(previous, input.actorPersonId);
    }

    this.logger.log(`Updated the ${input.slot} logo`);
    return this.readBranding();
  }

  /** Clears one of the slots and deletes the file it held. */
  async removeLogo(
    slot: LogoSlot,
    actorPersonId: string | null,
  ): Promise<BrandingSettings> {
    await this.requireAssociation();

    const previous = await this.replaceLogoReference(slot, null);
    if (previous !== null) {
      await this.media.remove(previous, actorPersonId);
    }

    this.logger.log(`Cleared the ${slot} logo`);
    return this.readBranding();
  }

  /**
   * Points a slot at a file and reports what it pointed at before.
   *
   * The reference is moved before the old file is deleted, never after: an
   * interrupted delete leaves an unreferenced object, while an interrupted
   * update would leave the branding pointing at bytes that are already gone.
   *
   * Read and write in one transaction, so two administrators saving a logo at
   * the same moment cannot both read the same previous id and both try to
   * delete it - which would leave one of the two new files unreferenced.
   */
  private async replaceLogoReference(
    slot: LogoSlot,
    fileId: string | null,
  ): Promise<string | null> {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.association.findUnique({
        where: { id: 1 },
        select: { logoFileId: true, logoDarkFileId: true },
      });
      const previous =
        (slot === "dark" ? before?.logoDarkFileId : before?.logoFileId) ?? null;

      await tx.association.update({
        where: { id: 1 },
        data:
          slot === "dark" ? { logoDarkFileId: fileId } : { logoFileId: fileId },
      });

      return previous === fileId ? null : previous;
    });
  }

  /** The branding block on its own, for the writes that return only it. */
  private async readBranding(): Promise<BrandingSettings> {
    return (await this.read()).branding;
  }

  async updateSmtp(input: SmtpInput): Promise<SmtpSettingsView> {
    await this.requireAssociation();

    const passwordCipher =
      input.password === undefined
        ? undefined
        : input.password === null || input.password === ""
          ? null
          : (
              await this.encryption.encrypt(
                "association.smtpPassword",
                input.password,
              )
            ).cipher;

    await this.prisma.association.update({
      where: { id: 1 },
      data: {
        smtpHost: input.host,
        smtpPort: input.port,
        smtpSecure: input.secure,
        smtpUser: input.user,
        smtpFromAddress: input.fromAddress,
        // Left out of the update entirely when undefined, so saving the rest of
        // the form does not silently wipe a password the screen never showed.
        ...(passwordCipher === undefined
          ? {}
          : { smtpPasswordCipher: passwordCipher }),
      },
    });

    // Host and sender only. The password is a secret and the user name is close
    // enough to one that it has no business in a log line either.
    this.logger.log(
      `Updated SMTP settings: host=${input.host ?? "none"}, from=${input.fromAddress ?? "none"}`,
    );

    const settings = await this.read();
    return settings.smtp;
  }

  /**
   * Sends a test message to the administrator who asked for it.
   *
   * Their own address from the register rather than one supplied in the
   * request: an endpoint that mails an arbitrary address on demand is a relay,
   * and proving that the configuration works only means anything if the message
   * reaches a mailbox the person asking already controls.
   */
  async sendTestMessage(
    actorPersonId: string,
  ): Promise<{ sentTo: string; host: string }> {
    const settings = await this.read();
    if (!settings.smtp.configured) {
      throw new MailNotConfiguredError();
    }

    const person = await this.prisma.person.findUnique({
      where: { id: actorPersonId },
      select: {
        firstName: true,
        emailCipher: true,
        preferredLocale: true,
      },
    });
    if (person === null) {
      throw new SettingsError("No such person.", "person-not-found");
    }
    if (person.emailCipher === null) {
      throw new SettingsError(
        "Your own record has no email address to send the test to.",
        "no-email",
      );
    }

    const email = await this.encryption.decrypt(
      "person.email",
      person.emailCipher,
    );
    const host = settings.smtp.host ?? "";

    await this.mail.send({
      to: email,
      locale: person.preferredLocale,
      template: smtpTestMail,
      props: { recipientName: person.firstName, smtpHost: host },
    });

    return { sentTo: email, host };
  }

  /**
   * Sets how long service data is kept after a move-out.
   *
   * Purge dates are computed from this rather than stored, so changing it moves
   * every pending purge date at once, which is what decision 1 asks for. It
   * reaches service data only: the member register and the audit log are
   * append-only in the database, so no value here - and no administrator - can
   * shorten the statutory retention the law requires.
   */
  async updateRetention(input: {
    daysAfterMoveOut: number;
  }): Promise<{ daysAfterMoveOut: number }> {
    await this.requireAssociation();

    const association = await this.prisma.association.update({
      where: { id: 1 },
      data: { retentionDaysAfterMoveOut: input.daysAfterMoveOut },
    });

    this.logger.log(
      `Retention set to ${association.retentionDaysAfterMoveOut} days after move-out`,
    );
    return { daysAfterMoveOut: association.retentionDaysAfterMoveOut };
  }

  async updateSelfSignup(input: {
    enabled: boolean;
  }): Promise<{ enabled: boolean }> {
    await this.requireAssociation();

    const association = await this.prisma.association.update({
      where: { id: 1 },
      data: { selfSignupEnabled: input.enabled },
    });

    this.logger.log(
      `Self-signup ${association.selfSignupEnabled ? "enabled" : "disabled"}`,
    );
    return { enabled: association.selfSignupEnabled };
  }

  /** The signed-in person's own preferences. Reached with self:manage. */
  async updateOwnProfile(
    personId: string,
    input: { preferredLocale: string },
  ): Promise<{ preferredLocale: string }> {
    const person = await this.prisma.person
      .update({
        where: { id: personId },
        data: { preferredLocale: input.preferredLocale },
        select: { preferredLocale: true },
      })
      .catch(() => null);

    if (person === null) {
      throw new SettingsError("No such person.", "person-not-found");
    }
    return person;
  }

  /**
   * Fails the write when the housing cooperative does not exist yet.
   *
   * Every setting except the name hangs off that row, and an upsert here would
   * invent a housing cooperative with a placeholder name from a request that
   * was only meant to set an SMTP host.
   */
  private async requireAssociation(): Promise<void> {
    const association = await this.prisma.association.findUnique({
      where: { id: 1 },
      select: { id: true },
    });
    if (association === null) {
      throw new SettingsError(
        "Create the housing cooperative before changing this setting.",
        "housing-cooperative-missing",
      );
    }
  }
}

/** The stored file as the branding screen needs it, or null when unset. */
function toLogoView(
  file: {
    id: string;
    fileName: string;
    width: number | null;
    height: number | null;
  } | null,
): LogoView | null {
  if (file === null) {
    return null;
  }
  return {
    url: mediaUrl(file.id),
    fileName: file.fileName,
    width: file.width,
    height: file.height,
  };
}
