-- CreateTable
CREATE TABLE "association_facts" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "propertyDesignation" TEXT,
    "buildYear" INTEGER,
    "landLeasehold" BOOLEAN,
    "landLeaseholdNote" TEXT,
    "feePolicy" TEXT,
    "feeIncludes" TEXT,
    "transferFeePolicy" TEXT,
    "pledgeFeePolicy" TEXT,
    "legalPersonOwners" BOOLEAN,
    "legalPersonOwnersNote" TEXT,
    "parking" TEXT,
    "storage" TEXT,
    "renovations" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "association_facts_pkey" PRIMARY KEY ("id")
);
