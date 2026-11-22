-- v2 Phase 3: review coverage metadata (files reviewed/skipped, chunks, failed chunks, tokens, latency)
ALTER TABLE "Review" ADD COLUMN "meta" JSONB;
