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
 * here asks from inside the container.
 */

const HEX_PASSWORD = /^[0-9a-f]{64}$/;

test("the stack starts with every variable in every service, and the application holds no owner's password", () => {
  // Two first boots' worth of deploy steps, a database initialised from
  // nothing and the application's start period, twice over.
  test.setTimeout(15 * 60_000);

  const stack = sharedEnvironmentStack({
    project: `${PROJECT_NAME}-shared`,
    image: builtImage,
    databaseImage: databaseImage(),
    repositoryRoot,
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
  } finally {
    stack.down();
  }
});
