/**
 * Puts a text on the clipboard, and answers whether it got there.
 *
 * A browser can refuse - an insecure origin, a permission withheld, an old
 * engine without the API - and the reader is then told so rather than left to
 * paste nothing.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator === "undefined" || !("clipboard" in navigator)) {
      return false;
    }
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
