import { generateKeyPairSync, randomUUID, sign } from "node:crypto";

import { Injectable } from "@nestjs/common";

import { AuditLogService } from "../audit/audit-log.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import type { InstanceBinding } from "./entitlement-judgement";
import { ed25519PrivateKey } from "./licence-file";

/**
 * This instance's identity (ADR 0042): a random id and an Ed25519 key pair.
 *
 * Created once, by whichever process asks first, and changed only when an
 * operator re-keys the instance from the command-line tool after the key
 * leaked. No method returns the private key. A licence is bound to the id and
 * the public key, so a restore that keeps the database keeps the licence; the
 * private key signs presentations and nothing else.
 *
 * Read from the database on every call rather than held: the command-line
 * tool re-keys from a process of its own, and a server still holding the old
 * key would go on judging the licences issued to it active.
 */
@Injectable()
export class InstanceIdentityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: FieldEncryptionService,
    private readonly audit: AuditLogService,
  ) {}

  /** The instance id and public key, created on the first call. */
  async binding(): Promise<InstanceBinding> {
    const row = await this.row();
    return { instanceId: row.instanceId, instanceKey: row.publicKey };
  }

  /**
   * Signs `message` with the instance key.
   *
   * Throws when the stored key cannot be decrypted, which is a database
   * restored without the encryption key it was written under: such a copy
   * verifies licences as the original does and presents none of them.
   */
  async sign(message: Buffer): Promise<Buffer> {
    const row = await this.row();
    const seed = await this.encryption.decrypt(
      "instanceIdentity.privateKey",
      row.privateKeyCipher,
    );
    return sign(null, message, ed25519PrivateKey(seed, row.publicKey));
  }

  /**
   * Whether the stored private key can be read, so that the instance can
   * present a licence at all. False for a database restored without the
   * encryption key it was written under, which the licence screen says (ADR
   * 0042). Signs nothing, and generates no key in its place: a new key is the
   * operator's act.
   */
  async keyReadable(): Promise<boolean> {
    const row = await this.row();
    try {
      const seed = await this.encryption.decrypt(
        "instanceIdentity.privateKey",
        row.privateKeyCipher,
      );
      ed25519PrivateKey(seed, row.publicKey);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Replaces the key pair after it leaked (ADR 0042, "Re-keying after the
   * instance key leaks"). For the command-line tool only: no screen or route
   * calls it.
   *
   * The new private key is encrypted as the old one was and written over it,
   * so the database keeps no copy of the old one; a backup taken before still
   * does. The instance keeps its id unless `newId` is set. Every licence held
   * names the old key, so each is `wrong-instance` from now on and none is
   * presented; they stay stored until the board removes them.
   *
   * The audit entry carries the new public key and the operator's reason,
   * never a private key.
   */
  async replaceKey(input: {
    newId: boolean;
    reason: string;
  }): Promise<InstanceBinding> {
    const reason = input.reason.trim();
    if (reason === "") {
      throw new RangeError("Replacing the instance key needs a reason.");
    }
    await this.row();
    const { publicKey, privateKeyCipher } = await this.newKeyPair();

    return this.prisma.$transaction(async (tx) => {
      // Locked so that two replacements at once are logged in the order they
      // are written, each naming the id it replaced.
      await tx.$executeRaw`SELECT 1 FROM "instance_identity" WHERE "id" = 1 FOR UPDATE`;
      const previous = await tx.instanceIdentity.findUniqueOrThrow({
        where: { id: 1 },
        select: { instanceId: true },
      });
      const instanceId = input.newId ? randomUUID() : previous.instanceId;
      await tx.instanceIdentity.update({
        where: { id: 1 },
        data: { instanceId, publicKey, privateKeyCipher },
      });
      await this.audit.record(
        {
          action: "INSTANCE_KEY_REPLACED",
          channel: "SYSTEM",
          actorPersonId: null,
          targetKind: "instance",
          targetId: instanceId,
          context: {
            instanceId,
            publicKey,
            reason,
            ...(input.newId ? { previousInstanceId: previous.instanceId } : {}),
          },
        },
        tx,
      );
      return { instanceId, instanceKey: publicKey };
    });
  }

  /**
   * The row, inserted first when there is none. Two processes starting at
   * once both try, one insert wins, and both read the winner's row.
   */
  private async row(): Promise<{
    instanceId: string;
    publicKey: string;
    privateKeyCipher: string;
  }> {
    const existing = await this.prisma.instanceIdentity.findUnique({
      where: { id: 1 },
    });
    if (existing !== null) {
      return existing;
    }
    const { publicKey, privateKeyCipher } = await this.newKeyPair();
    await this.prisma.instanceIdentity.createMany({
      data: [{ id: 1, instanceId: randomUUID(), publicKey, privateKeyCipher }],
      skipDuplicates: true,
    });
    return this.prisma.instanceIdentity.findUniqueOrThrow({ where: { id: 1 } });
  }

  /** A fresh key pair: the public key and the encrypted private key's seed. */
  private async newKeyPair(): Promise<{
    publicKey: string;
    privateKeyCipher: string;
  }> {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicJwk = publicKey.export({ format: "jwk" });
    const privateJwk = privateKey.export({ format: "jwk" });
    if (publicJwk.x === undefined || privateJwk.d === undefined) {
      throw new Error("An Ed25519 key exported without its key material.");
    }
    const { cipher } = await this.encryption.encrypt(
      "instanceIdentity.privateKey",
      privateJwk.d,
    );
    return { publicKey: publicJwk.x, privateKeyCipher: cipher };
  }
}
