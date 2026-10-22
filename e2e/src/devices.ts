import { createHash, randomBytes } from "node:crypto";

import pg from "pg";

import { stack } from "./stack";

/**
 * A device token, put straight in the database (ADR 0031).
 *
 * A token is issued only by a plugin, on a board member's request from the
 * plugin's own screen, and the fixture plugin cannot declare a device route:
 * it reads the address book, which a plugin with a device route may not. So
 * the one thing this suite cannot produce over HTTP is the token the devices
 * screen exists to list - and that screen, listing and revoking, is what is
 * worth proving against a deployed instance.
 *
 * The plugin row is switched off and is removed again by `removeDeviceToken`,
 * which takes the token with it, so nothing an install or a restart reads is
 * left behind. The connection is the owner's, like the other seeds.
 */

async function withClient<T>(
  use: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: stack.databaseUrl });
  await client.connect();
  try {
    return await use(client);
  } finally {
    await client.end();
  }
}

export interface SeededDeviceToken {
  readonly pluginId: string;
  readonly tokenId: string;
}

/**
 * Issues a token for a plugin row of its own, as issued by the person with
 * this email address. The token itself is never kept: only its digest is
 * stored, as the instance stores it.
 */
export async function seedDeviceToken(input: {
  pluginId: string;
  label: string;
  issuedByEmail: string;
}): Promise<SeededDeviceToken> {
  const tokenId = `e2e-device-${input.pluginId}`;
  const digest = createHash("sha256")
    .update(`obrf_dt_${randomBytes(32).toString("base64url")}`, "utf8")
    .digest("base64url");
  await withClient(async (client) => {
    // Prisma maps the models to snake case and leaves the column names in
    // camel case, so every one of them has to be quoted.
    await client.query(
      `INSERT INTO public.installed_plugin
         (id, "packageName", version, checksum, enabled, status,
          "consentedPermissions", "declaredPersonalData", "updatedAt")
       VALUES ($1, $2, '1.0.0', 'sha512-unused', false,
               'INSTALLED'::"InstalledPluginStatus", '{}', '{}', now())`,
      [input.pluginId, `openbrf-plugin-${input.pluginId}`],
    );
    await client.query(
      `INSERT INTO public.plugin_device_token
         (id, "pluginId", "routeId", subject, label, "tokenHash",
          "issuedByPersonId")
       SELECT $1, $2, 'screen', 'scr_e2e', $3, $4, u."personId"
         FROM public.auth_user u
        WHERE u.email = $5`,
      [tokenId, input.pluginId, input.label, digest, input.issuedByEmail],
    );
  });
  return { pluginId: input.pluginId, tokenId };
}

/** Whether the token is revoked, as the row says. */
export async function deviceTokenRevoked(tokenId: string): Promise<boolean> {
  return withClient(async (client) => {
    const result = await client.query<{ revokedAt: Date | null }>(
      `SELECT "revokedAt" FROM public.plugin_device_token WHERE id = $1`,
      [tokenId],
    );
    return result.rows[0]?.revokedAt != null;
  });
}

/** Removes the plugin row, and the token with it. */
export async function removeDeviceToken(
  seeded: SeededDeviceToken,
): Promise<void> {
  await withClient(async (client) => {
    await client.query(`DELETE FROM public.installed_plugin WHERE id = $1`, [
      seeded.pluginId,
    ]);
  });
}
