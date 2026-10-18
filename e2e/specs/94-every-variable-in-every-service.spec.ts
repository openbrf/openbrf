import { randomBytes } from "node:crypto";

import { expect, test } from "@playwright/test";

import { sharedEnvironmentStack } from "../src/shared-environment";
import {
  builtImage,
  databaseImage,
  PROJECT_NAME,
  repositoryRoot,
} from "../src/stack";

/**
 * The production stack on a platform that gives every service every variable.
 *
 * Coolify puts each variable of a stack into the environment of each of its
 * services, whatever the compose file gives each one, and 0.1.0 did not start
 * there: its application's container received the superuser's and the
 * owner's passwords, and refused to run with them. This starts
 * docker-compose.prod.yml the way such a platform does, from empty volumes,
 * with the variables docs/deployment.md has its operator set, and holds the
 * stack to starting anyway - with neither password anywhere in the
 * application's container, because none was ever supplied for a platform to
 * hand out.
 *
 * A stack of its own beside the suite's, under a project of its own, from the
 * image the suite built. It publishes no port: a platform's proxy reaches the
 * application over the stack's network, and the health check that decides
 * here asks from inside the container. Its database logs every statement it
 * is sent, which is how the test tells that no password reached the server,
 * whether the deploy generated it or an operator supplied it.
 */

const HEX_PASSWORD = /^[0-9a-f]{64}$/;

/**
 * A superuser's password that is lost, replaced the way docs/deployment.md has
 * an operator do it: a new one written onto the volume by a one-off container
 * of the superuser-password service, and then set on the superuser's role over
 * the database container's socket, read by the server from the same file.
 */
const WRITE_NEW_SUPERUSER_PASSWORD = `require("node:fs").writeFileSync("/credentials/superuser/password",
  require("node:crypto").randomBytes(32).toString("hex"), { mode: 0o644 })`;
const SET_NEW_SUPERUSER_PASSWORD = `DO $$ BEGIN
  EXECUTE format('ALTER ROLE openbrf PASSWORD %L',
    rtrim(pg_read_file('/credentials/superuser/password'), E'\\n'));
END $$;
`;

/**
 * Signs in to the database as `role` over the stack's network, with the
 * password on standard input, from a container on that network that has psql.
 */
function signInAs(role: string): string[] {
  return [
    "sh",
    "-c",
    `IFS= read -r PGPASSWORD && export PGPASSWORD && psql -h db -U ${role} -d openbrf -tAc "SELECT 1"`,
  ];
}

/**
 * Runs a deploy step's `command` with `variable` set to the password on
 * standard input, as for an operator who supplies that password.
 */
function withSupplied(variable: string, command: string): string[] {
  return [
    "sh",
    "-c",
    `IFS= read -r ${variable} && export ${variable} && exec ${command}`,
  ];
}

test("the stack starts with every variable in every service, and the application holds no owner's password", () => {
  // A first boot - a database initialised from nothing, the deploy steps and
  // the application's start period - and two later ones.
  test.setTimeout(20 * 60_000);

  const stack = sharedEnvironmentStack({
    project: `${PROJECT_NAME}-shared`,
    image: builtImage,
    databaseImage: databaseImage(),
    repositoryRoot,
    logStatements: true,
  });
  try {
    stack.up();
    expect(stack.healthOf("app"), "the application is healthy").toBe("healthy");

    // Generated, since nothing supplied them, onto the volumes their services
    // mount. Read back in containers of the services that mount them, which
    // the application is not.
    const superuser = stack.readFile(
      "superuser-password",
      "/credentials/superuser/password",
    );
    const owner = stack.readFile("schema-owner", "/credentials/owner/password");
    expect(superuser).toMatch(HEX_PASSWORD);
    expect(owner).toMatch(HEX_PASSWORD);
    expect(owner).not.toBe(superuser);

    // Neither reaches the application, under any name: not in the environment
    // its container was started with, and not in any process running in it.
    const environment = stack.environmentOf("app");
    const processes = stack.processEnvironmentsOf("app");
    for (const [role, password] of [
      ["superuser", superuser],
      ["schema owner", owner],
    ] as const) {
      expect(
        environment.filter((entry) => entry.includes(password)),
        `the ${role}'s password is in no variable of the application's container`,
      ).toEqual([]);
      expect(
        processes.includes(password),
        `no process in the application's container holds the ${role}'s password`,
      ).toBe(false);
    }

    // A later boot: the same passwords, taken from the volumes rather than
    // generated again, and the instance starts as before.
    stack.up();
    expect(stack.healthOf("app")).toBe("healthy");
    expect(
      stack.readFile("superuser-password", "/credentials/superuser/password"),
    ).toBe(superuser);
    expect(stack.readFile("schema-owner", "/credentials/owner/password")).toBe(
      owner,
    );

    // A later boot whose superuser's password is gone - a volume removed, or
    // never mounted - is refused rather than given a new one the database
    // would not take, as the field encryption key is.
    const removed = stack.runOnce("superuser-password", [
      "rm",
      "/credentials/superuser/password",
    ]);
    expect(removed.status, removed.output).toBe(0);
    const refused = stack.runOnce("superuser-password");
    expect(refused.status, refused.output).toBe(1);
    expect(refused.output).toContain(
      "but the database's volume already holds a database",
    );
    expect(refused.output.includes(superuser), "nothing is echoed").toBe(false);

    // The way back docs/deployment.md gives for a password that is lost, and
    // for one a platform has handed every service: a new one, which the stack
    // starts with, while the old one no longer signs in.
    const written = stack.runOnce("superuser-password", [
      "node",
      "-e",
      WRITE_NEW_SUPERUSER_PASSWORD,
    ]);
    expect(written.status, written.output).toBe(0);
    stack.up(["db"]);
    const set = stack.exec(
      "db",
      ["psql", "-U", "openbrf", "-d", "openbrf", "-v", "ON_ERROR_STOP=1"],
      SET_NEW_SUPERUSER_PASSWORD,
    );
    expect(set.status, set.output).toBe(0);
    stack.up();
    expect(stack.healthOf("app")).toBe("healthy");
    const replaced = stack.readFile(
      "superuser-password",
      "/credentials/superuser/password",
    );
    expect(replaced).toMatch(HEX_PASSWORD);
    expect(replaced).not.toBe(superuser);
    const withOld = stack.runOnce(
      "schema-owner",
      signInAs("openbrf"),
      `${superuser}\n`,
    );
    expect(withOld.status, "the old password signs in no more").not.toBe(0);
    expect(withOld.output).toContain("password authentication failed");
    const withNew = stack.runOnce(
      "schema-owner",
      signInAs("openbrf"),
      `${replaced}\n`,
    );
    expect(withNew.status, withNew.output).toBe(0);

    // Passwords an operator supplies, of the kind SASLprep changes before
    // PostgreSQL hashes them: a ligature, full width letters and a
    // non-breaking space. The deploy steps set each as the verifier of what
    // SASLprep makes of it, and psql, whose libpq prepares it the same way,
    // signs in with it. The runtime role's first, while the owner still signs
    // in with the password on its volume, which the migrate step connects
    // with.
    const runtimeSecret = randomBytes(16).toString("hex");
    const ownerSecret = randomBytes(16).toString("hex");
    const suppliedRuntime = `ＡＢＣ\u00a0${runtimeSecret}`;
    const suppliedOwner = `ﬁnance-${ownerSecret}`;
    const hardened = stack.runOnce(
      "migrate",
      withSupplied(
        "RUNTIME_DB_PASSWORD",
        "node /app/docker/with-owner-url.mjs node /app/docker/harden-runtime-role.mjs",
      ),
      `${suppliedRuntime}\n`,
    );
    expect(hardened.status, hardened.output).toBe(0);
    const ownerSet = stack.runOnce(
      "schema-owner",
      withSupplied("OWNER_DB_PASSWORD", "node /app/docker/schema-owner.mjs"),
      `${suppliedOwner}\n`,
    );
    expect(ownerSet.status, ownerSet.output).toBe(0);
    for (const [role, password] of [
      ["openbrf_app", suppliedRuntime],
      ["openbrf_owner", suppliedOwner],
    ] as const) {
      const signedIn = stack.runOnce(
        "schema-owner",
        signInAs(role),
        `${password}\n`,
      );
      expect(signedIn.status, `${role}: ${signedIn.output}`).toBe(0);
    }

    // Every statement the database was sent is in its log, the ones that set
    // the owner's and the runtime role's passwords on every deploy among
    // them. They carry each password's SCRAM verifier, which nobody can sign
    // in with, and no password itself: a statement that fails is logged on
    // any server, with whatever it carries.
    const runtime = stack.readFile(
      "migrate",
      "/data/credentials/runtime-db-password",
    );
    expect(runtime).toMatch(HEX_PASSWORD);
    const log = stack.logsOf("db");
    for (const role of ["openbrf_owner", "openbrf_app"]) {
      expect(
        new RegExp(`ROLE ${role} WITH .* PASSWORD 'SCRAM-SHA-256\\$4096:`).test(
          log,
        ),
        `the database's log has ${role}'s password set as a verifier`,
      ).toBe(true);
    }
    for (const [role, password] of [
      ["superuser", superuser],
      ["new superuser", replaced],
      ["schema owner", owner],
      ["runtime role", runtime],
      // What is the supplied passwords' own, so that neither the password
      // nor what SASLprep makes of it can be there.
      ["supplied schema owner", ownerSecret],
      ["supplied runtime role", runtimeSecret],
    ] as const) {
      expect(
        log.includes(password),
        `the ${role}'s password is nowhere in the database's log`,
      ).toBe(false);
    }
  } finally {
    stack.down();
  }
});
