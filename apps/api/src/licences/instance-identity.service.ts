import { generateKeyPairSync, randomUUID, sign } from "node:crypto";

import { Injectable } from "@nestjs/common";

import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import type { InstanceBinding } from "./entitlement-judgement";
import { ed25519PrivateKey } from "./licence-file";

/**
 * This instance's identity (ADR 0042): a random id and an Ed25519 key pair.
 *
 * Created once, by whichever process asks first, and never changed: nothing
 * here writes the row again, and no method returns the private key. A licence
 * is bound to the id and the public key, so a restore that keeps the database
 * keeps the licence; the private key signs presentations and nothing else.
 */
@Injectable()
export class InstanceIdentityService {
  private cached: InstanceBinding | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: FieldEncryptionService,
  ) {}

  /** The instance id and public key, created on the first call. */
  async binding(): Promise<InstanceBinding> {
    if (this.cached !== null) {
      return this.cached;
    }
    const row = await this.row();
    this.cached = { instanceId: row.instanceId, instanceKey: row.publicKey };
    return this.cached;
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
    await this.prisma.instanceIdentity.createMany({
      data: [
        {
          id: 1,
          instanceId: randomUUID(),
          publicKey: publicJwk.x,
          privateKeyCipher: cipher,
        },
      ],
      skipDuplicates: true,
    });
    return this.prisma.instanceIdentity.findUniqueOrThrow({ where: { id: 1 } });
  }
}
