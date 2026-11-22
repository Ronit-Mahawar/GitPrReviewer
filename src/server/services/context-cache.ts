/**
 * Postgres-backed cache for repo context (D11): file contents and extracted signatures by (repo, blobSha, kind).
 * A blob SHA names exact contents, so entries never need invalidating. Cache errors are swallowed:
 * a cache problem should cost a refetch, never a review.
 */
import { db } from "@/server/db";
import { logger } from "@/server/lib/logger";
import type { ContextCache } from "./github-context-provider";

export const prismaContextCache: ContextCache = {
  async get(repo, blobSha, kind) {
    try {
      const row = await db.contextCache.findUnique({ where: { repo_blobSha_kind: { repo, blobSha, kind } }, select: { content: true } });
      return row?.content ?? null;
    } catch (error) {
      logger.warn("context cache read failed", { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  },
  async set(repo, blobSha, kind, content) {
    try {
      await db.contextCache.upsert({
        where: { repo_blobSha_kind: { repo, blobSha, kind } },
        create: { repo, blobSha, kind, content },
        update: {},
      });
    } catch (error) {
      logger.warn("context cache write failed", { error: error instanceof Error ? error.message : String(error) });
    }
  },
};
