import { ISSUE_REPORT_LIMITS, type PostView } from "@openbrf/shared";

import { fetchPost } from "../api/feed";

/** What an issue report made from a post opens with. */
export interface PostPrefill {
  /** The post the report is made from, which the server links it to. */
  postId: string;
  /** The post's text, cut to what a report's description holds. */
  description: string;
  /** The post's images, as files the form uploads like any it was given. */
  photos: readonly File[];
  /** How many of the post's images could not be read, and are not among them. */
  photosMissing: number;
}

/** Why a report could not be opened from a post. */
export type PostPrefillFailure = "unreadable";

/**
 * The image types the form names a file after, by the type the browser read.
 * Anything else is left without an extension: the API identifies a file from
 * its own bytes either way.
 */
const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

/**
 * What a post says, as a report's description: its own text, or for a post
 * written as Styrelsen its news item's title and text. Cut, rather than
 * refused, where a report holds less than a post: the reporter reads it in the
 * field and can shorten it themselves.
 */
export function descriptionOf(post: PostView): string {
  const text =
    post.body ??
    (post.news === null
      ? ""
      : [post.news.title, post.news.text]
          .filter((part) => part !== "")
          .join("\n\n"));
  return text.slice(0, ISSUE_REPORT_LIMITS.description);
}

/**
 * Reads a post and its images for the issue report form ("Gör felanmälan").
 *
 * The post is read through the feed, on the feed's own terms: one this account
 * may not read is answered as one that does not exist, and the form opens
 * empty with a sentence saying so. Its images are read from the media route,
 * which asks the same question of every request, and handed to the form as the
 * files a reporter would otherwise have picked: they are uploaded to the report
 * like any other photograph once it is filed, so the report holds its own copy
 * under the issue's rules rather than a pointer into the feed. An image that
 * cannot be read is left out and counted, so the form can say so.
 *
 * @param photoName The name a photograph is given, by its place on the post.
 * @param maxPhotos How many photographs the form takes.
 */
export async function readPostPrefill(
  postId: string,
  photoName: (number: number) => string,
  maxPhotos: number,
): Promise<
  { ok: true; value: PostPrefill } | { ok: false; failure: PostPrefillFailure }
> {
  const read = await fetchPost({ postId });
  if (!read.ok) {
    return { ok: false, failure: "unreadable" };
  }
  const post = read.value;
  const images = post.images.slice(0, maxPhotos);

  const photos: File[] = [];
  let photosMissing = 0;
  for (const [index, image] of images.entries()) {
    const file = await readImage(image.url, photoName(index + 1));
    if (file === null) {
      photosMissing += 1;
    } else {
      photos.push(file);
    }
  }

  return {
    ok: true,
    value: {
      postId: post.id,
      description: descriptionOf(post),
      photos,
      photosMissing,
    },
  };
}

/** One image from this instance's own media route, as a file, or null. */
async function readImage(url: string, name: string): Promise<File | null> {
  try {
    const response = await fetch(url, { credentials: "same-origin" });
    if (!response.ok) {
      return null;
    }
    const blob = await response.blob();
    return new File([blob], `${name}${EXTENSIONS[blob.type] ?? ""}`, {
      type: blob.type,
    });
  } catch {
    return null;
  }
}
