-- The SMS half of a news mailing: the provider an association configures, the
-- second claim on a news item, and the channel the delivery ledger records.

-- AlterEnum
-- ALTER TYPE ... ADD VALUE may not be followed by a use of the new value in the
-- same transaction, and a migration runs as one. Nothing below uses it: the
-- first writer of this action runs long after this has committed.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'NEWS_TEXTED';

-- CreateEnum
CREATE TYPE "NewsDeliveryChannel" AS ENUM ('EMAIL', 'SMS');

-- AlterTable
ALTER TABLE "association" ADD COLUMN     "smsDriver" TEXT,
ADD COLUMN     "smsGatewayTokenCipher" TEXT,
ADD COLUMN     "smsGatewayUrl" TEXT,
ADD COLUMN     "smsSenderName" TEXT;

-- AlterTable
ALTER TABLE "news" ADD COLUMN     "smsQueuedAt" TIMESTAMP(3);

-- AlterTable
-- Defaulted to EMAIL: every mailing written before this migration was an email,
-- so the existing rows keep the meaning they were written with.
ALTER TABLE "news_delivery" ADD COLUMN     "channel" "NewsDeliveryChannel" NOT NULL DEFAULT 'EMAIL';

-- DropIndex
DROP INDEX "news_delivery_newsId_personId_key";

-- DropIndex
DROP INDEX "news_delivery_newsId_status_idx";

-- CreateIndex
-- The channel joins the pair. Without it the SMS snapshot taken at publish
-- would collide with the email one for every member reached both ways.
CREATE UNIQUE INDEX "news_delivery_newsId_personId_channel_key" ON "news_delivery"("newsId", "personId", "channel");

-- CreateIndex
CREATE INDEX "news_delivery_newsId_channel_status_idx" ON "news_delivery"("newsId", "channel", "status");
