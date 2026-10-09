/**
 * The retry the container process probe puts around reading a process's
 * environment, kept apart from the spec so a test can drive it with a fake
 * /proc.
 *
 * The probe runs as a script inside the application's container, so what it
 * runs is source text, not an import. This module holds that text and the spec
 * that uses it embeds it unchanged; process-probe-retry.spec.ts evaluates the
 * same text against injected reads. Plain JavaScript, no types: it is never
 * compiled.
 *
 * A process that is still being set up is refused to the application user for
 * a moment: the image's healthcheck starts one through docker exec every few
 * seconds, and until the runtime has finished with it, it belongs to root. A
 * refused read is therefore tried again. The outcome is one of
 *
 *  - { held, gone: false }: the environment was read;
 *  - { gone: true }: the process exited, before or during the retries, so it
 *    has no environment left to hold anything;
 *  - { held: undefined, gone: false }: it is still there and still refused,
 *    which the probe reports rather than skips.
 */
export const ENVIRONMENT_READER_SOURCE = `
function makeEnvironmentReader(io) {
  const attempts = 20;
  return function readEnvironment(pid) {
    for (let attempt = 0; ; attempt++) {
      try {
        return { held: io.read(pid), gone: false };
      } catch (failure) {
        if (failure.code === "ENOENT" || failure.code === "ESRCH") return { gone: true };
        const transient = failure.code === "EACCES" || failure.code === "EPERM";
        if (!transient || attempt >= attempts) return { gone: !io.exists(pid), held: undefined };
        io.sleep(50);
      }
    }
  };
}
`;
