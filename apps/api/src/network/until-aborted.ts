/**
 * What `work` settles with, or a rejection as soon as `signal` aborts.
 *
 * For a deadline that has to cover a step which cannot itself be cancelled,
 * such as a name lookup: the step is left to finish on its own and its answer
 * is dropped. Nothing after the abort runs on it, because the caller gets the
 * rejection before it reaches the next step.
 */
export function untilAborted<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const onAbort = () => {
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (reason: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(reason instanceof Error ? reason : new Error("failed"));
      },
    );
  });
}
