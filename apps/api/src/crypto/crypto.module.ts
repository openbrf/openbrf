import { Global, Module } from "@nestjs/common";

import { FieldEncryptionService } from "./field-encryption.service";

/**
 * Field encryption is needed wherever personal data is read or written, so the
 * module is global rather than imported into every feature module.
 */
@Global()
@Module({
  providers: [FieldEncryptionService],
  exports: [FieldEncryptionService],
})
export class CryptoModule {}
