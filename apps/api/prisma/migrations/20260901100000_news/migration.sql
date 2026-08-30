-- CreateEnum
CREATE TYPE "NewsDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "news" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "visibility" "PageVisibility" NOT NULL DEFAULT 'MEMBER',
    "published" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMP(3),
    "emailQueuedAt" TIMESTAMP(3),
    "authorPersonId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "news_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "news_delivery" (
    "id" TEXT NOT NULL,
    "newsId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "status" "NewsDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "failureReason" TEXT,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "news_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "news_slug_key" ON "news"("slug");

-- CreateIndex
CREATE INDEX "news_published_visibility_publishedAt_idx" ON "news"("published", "visibility", "publishedAt");

-- CreateIndex
CREATE INDEX "news_delivery_newsId_status_idx" ON "news_delivery"("newsId", "status");

-- The pair is what makes one mailing reach one recipient exactly once: the
-- publish transaction snapshots the recipients into this table, and a second
-- attempt at the same mailing cannot add a second row for anybody.
-- CreateIndex
CREATE UNIQUE INDEX "news_delivery_newsId_personId_key" ON "news_delivery"("newsId", "personId");

-- AddForeignKey
ALTER TABLE "news_delivery" ADD CONSTRAINT "news_delivery_newsId_fkey" FOREIGN KEY ("newsId") REFERENCES "news"("id") ON DELETE CASCADE ON UPDATE CASCADE;
