import { Global, Module } from "@nestjs/common";

import { AuditLogService } from "./audit-log.service";

/**
 * Auditing is cross-cutting: any module that touches protected personal data
 * or produces a register extract has to write to the log.
 */
@Global()
@Module({
  providers: [AuditLogService],
  exports: [AuditLogService],
})
export class AuditModule {}
