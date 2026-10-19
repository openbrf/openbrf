-- Images on a post (ADR 0026). One row per picture, in the order the writer
-- attached them; the file itself is a media file held POST.
CREATE TABLE "post_image" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_image_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "post_image_fileId_key" ON "post_image"("fileId");

CREATE INDEX "post_image_postId_sortOrder_idx" ON "post_image"("postId", "sortOrder");

ALTER TABLE "post_image" ADD CONSTRAINT "post_image_postId_fkey" FOREIGN KEY ("postId") REFERENCES "post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "post_image" ADD CONSTRAINT "post_image_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "media_file"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A file held POST is read by whoever may read its post, and by nobody on any
-- other ground. A capability on it would let its holders reach a group's image
-- without reaching the group (ADR 0012), so the column that would carry one
-- stays empty. An apartment is already refused by
-- media_file_apartment_matches_visibility.
ALTER TABLE "media_file" ADD CONSTRAINT "media_file_post_names_no_capability"
  CHECK ("visibility" <> 'POST' OR "requiredCapability" IS NULL);
