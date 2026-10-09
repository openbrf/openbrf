import { DriverAdapterError } from "@prisma/driver-adapter-utils";

import { Prisma } from "../../generated/prisma/client";

/*
 * The errors are built the way Prisma builds them rather than written out by
 * hand: the pg adapter's DriverAdapterError, carrying what the adapter makes of
 * a PostgreSQL error, inside the PrismaClientKnownRequestError the client
 * throws. An upgrade that moves the SQLSTATE fails the specs that use them.
 */

/** A PostgreSQL error Prisma has no code of its own for, as the adapter reports it. */
export function postgres(code: string, prismaCode = "P2039"): Error {
  return known(prismaCode, {
    kind: "postgres",
    code,
    severity: "ERROR",
    message: `error ${code}`,
    detail: undefined,
    column: undefined,
    hint: undefined,
    originalCode: code,
    originalMessage: `error ${code}`,
  });
}

/** A PostgreSQL error Prisma maps to one of its own codes. */
export function mapped(
  prismaCode: string,
  cause: ConstructorParameters<typeof DriverAdapterError>[0],
): Error {
  return known(prismaCode, cause);
}

function known(
  code: string,
  cause: ConstructorParameters<typeof DriverAdapterError>[0],
): Error {
  return new Prisma.PrismaClientKnownRequestError(`failed with ${code}`, {
    code,
    clientVersion: Prisma.prismaVersion.client,
    meta: { driverAdapterError: new DriverAdapterError(cause) },
  });
}
