import { Prisma } from "../generated/prisma/client";

/**
 * Whether a write failed on a unique constraint (Prisma's P2002).
 *
 * The answer a caller gives to a race its read could not close: two requests
 * pass the read together and the database lets one of them write.
 */
export function isUniqueViolation(cause: unknown): boolean {
  return (
    cause instanceof Prisma.PrismaClientKnownRequestError &&
    cause.code === "P2002"
  );
}
