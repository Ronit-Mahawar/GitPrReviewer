-- v2 Phase 4: repo context cache keyed by (repo, blobSha, kind)
-- CreateTable
CREATE TABLE "ContextCache" (
    "repo" TEXT NOT NULL,
    "blobSha" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContextCache_pkey" PRIMARY KEY ("repo","blobSha","kind")
);

-- CreateIndex
CREATE INDEX "ContextCache_createdAt_idx" ON "ContextCache"("createdAt");

