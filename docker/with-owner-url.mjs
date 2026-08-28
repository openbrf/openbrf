// Runs one command with the schema owner's connection in its environment.
//
//   node docker/with-owner-url.mjs node docker/first-boot.mjs
//   node docker/with-owner-url.mjs ./node_modules/.bin/prisma migrate deploy
//   node docker/with-owner-url.mjs node scripts/install-job-schema.mjs
//   node docker/with-owner-url.mjs node docker/harden-runtime-role.mjs
//
// Every deploy step needs the owner's URL and none of them may leave it
// anywhere it can be read afterwards. The three places it would otherwise end
// up are all worse than this one:
//
//   - a shell variable, set from a command substitution, which means the value
//     was printed to a pipe first and is one `set -x` or one stray echo away
//     from the container log, which is shipped off the host and pasted into bug
//     reports;
//   - an argument, which is in /proc/<pid>/cmdline and readable by every
//     process in the container;
//   - a file, which outlives the boot.
//
// An environment is none of those: a child inherits it, and /proc/<pid>/environ
// is readable only by the same uid. So the URL is assembled in this process,
// handed to one child, and goes when this process does.
//
// The exit status is the child's, so `set -e` in the entrypoint still stops the
// boot on a failed step.
//
// Node built-ins only, like the rest of docker/, so it stays readable and
// runnable inside the image an operator is debugging.

import { spawnSync } from "node:child_process";

import { ownerUrl } from "./database-url.mjs";

function fail(message) {
  console.error(`openbrf: ${message}`);
  process.exit(1);
}

const [command, ...args] = process.argv.slice(2);
if (command === undefined) {
  fail("with-owner-url.mjs takes a command to run with the owner connection.");
}

const result = spawnSync(command, args, {
  stdio: "inherit",
  // The child gets DATABASE_URL whether or not this process was given one:
  // ownerUrl() passes a supplied value through and assembles one otherwise.
  env: { ...process.env, DATABASE_URL: ownerUrl() },
});

if (result.error !== undefined) {
  // The command itself could not be started - a missing binary rather than a
  // failed step. Named, because "exit 1" with no line is what sends an operator
  // reading the whole entrypoint.
  fail(`${command} could not be run: ${result.error.message}`);
}

if (result.signal !== null) {
  fail(`${command} was killed by ${result.signal}.`);
}

process.exit(result.status ?? 1);
