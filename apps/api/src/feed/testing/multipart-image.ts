/**
 * The request body of an image upload to the feed, built by hand.
 *
 * No client is assumed, so the framing is written out here once for every
 * feed suite that uploads an image.
 */

/** A multipart body carrying one PNG file, with the headers that go with it. */
export function multipartImage(
  bytes: Buffer,
  fileName: string,
  appOrigin: string,
) {
  const boundary = "----openbrfFeedBoundary";
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      "Content-Type: image/png\r\n\r\n",
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return {
    payload: Buffer.concat([head, bytes, tail]),
    // A form body names where it came from, or the guard takes it for a
    // sibling site's form.
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      origin: new URL(appOrigin).origin,
    },
  };
}
