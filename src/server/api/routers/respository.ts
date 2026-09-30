import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, protectedProcedure } from "../trpc";
import {
  fetchGitHubRepos,
  getGitHubAccessToken,
  createRepositoryWebhook,
  deleteRepositoryWebhook,
} from "@/server/services/github";

export const repositoryRouter = createTRPCRouter({
  list: protectedProcedure.query(async ({ ctx }) => {
    const repositories = await ctx.db.repository.findMany({
      where: { userId: ctx.user.id },
      orderBy: { createdAt: "desc" },
    });
    return repositories;
  }),

  fetchFromGithub: protectedProcedure.query(async ({ ctx }) => {
    const accessToken = await getGitHubAccessToken(ctx.user.id);

    if (!accessToken) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "User has not authorized GitHub access",
      });
    }

    const repos = await fetchGitHubRepos(accessToken);
    return repos.map((repo) => ({
      githubId: repo.id,
      name: repo.name,
      fullName: repo.full_name,
      private: repo.private,
      htmlUrl: repo.html_url,
      description: repo.description,
      language: repo.language,
      stars: repo.stargazers_count,
      updatedAt: repo.updated_at,
    }));
  }),

  connect: protectedProcedure
    .input(
      z.object({
        repos: z.array(
          z.object({
            githubId: z.number(),
            name: z.string(),
            fullName: z.string(),
            private: z.boolean(),
            htmlUrl: z.string(),
          }),
        ),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await Promise.all(
        input.repos.map((repo) =>
          ctx.db.repository.upsert({
            where: { githubId: repo.githubId },
            create: {
              userId: ctx.user.id,
              githubId: repo.githubId,
              name: repo.name,
              fullName: repo.fullName,
              private: repo.private,
              htmlUrl: repo.htmlUrl,
            },
            update: {
              name: repo.name,
              fullName: repo.fullName,
              private: repo.private,
              htmlUrl: repo.htmlUrl,
              updatedAt: new Date(),
            },
          }),
        ),
      );
      return { connected: result.length };
    }),
  
  enableAutoReview: protectedProcedure
  .input(
    z.object({
      repositoryId: z.string(),
    }),
  )
  .mutation(async ({ ctx, input }) => {
    const repository = await ctx.db.repository.findFirst({
      where: {
        id: input.repositoryId,
        userId: ctx.user.id,
      },
    });

    if (!repository) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Repository not found",
      });
    }

    if (repository.autoReviewEnabled) {
      return {
        success: true,
        alreadyEnabled: true,
      };
    }

    const accessToken = await getGitHubAccessToken(ctx.user.id);

    if (!accessToken) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "GitHub account is not connected",
      });
    }

    const [owner, repo] = repository.fullName.split("/");

    if (!owner || !repo) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Invalid GitHub repository name",
      });
    }

    const webhookId = await createRepositoryWebhook(
      accessToken,
      owner,
      repo,
    );

    await ctx.db.repository.update({
      where: {
        id: repository.id,
      },
      data: {
        autoReviewEnabled: true,
        webhookId,
      },
    });

    return {
      success: true,
      autoReviewEnabled: true,
      webhookId,
    };
  }),
  disableAutoReview: protectedProcedure
  .input(
    z.object({
      repositoryId: z.string(),
    }),
  )
  .mutation(async ({ ctx, input }) => {
    const repository = await ctx.db.repository.findFirst({
      where: {
        id: input.repositoryId,
        userId: ctx.user.id,
      },
    });

    if (!repository) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Repository not found",
      });
    }

    if (!repository.autoReviewEnabled) {
      return {
        success: true,
        alreadyDisabled: true,
      };
    }

    const accessToken = await getGitHubAccessToken(ctx.user.id);

    if (!accessToken) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "GitHub account is not connected",
      });
    }

    if (repository.webhookId) {
      const [owner, repo] = repository.fullName.split("/");

      if (!owner || !repo) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Invalid GitHub repository name",
        });
      }

      await deleteRepositoryWebhook(
        accessToken,
        owner,
        repo,
        repository.webhookId,
      );
    }

    await ctx.db.repository.update({
      where: {
        id: repository.id,
      },
      data: {
        autoReviewEnabled: false,
        webhookId: null,
      },
    });

    return {
      success: true,
      autoReviewEnabled: false,
    };
  }),

  disconnect: protectedProcedure
  .input(z.object({ id: z.string() }))
  .mutation(async ({ ctx, input }) => {
    const repository = await ctx.db.repository.findFirst({
      where: {
        id: input.id,
        userId: ctx.user.id,
      },
    });

    if (!repository) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Repository not found",
      });
    }

    if (repository.webhookId) {
      const accessToken = await getGitHubAccessToken(ctx.user.id);

      if (accessToken) {
        const [owner, repo] = repository.fullName.split("/");

        if (owner && repo) {
          await deleteRepositoryWebhook(
            accessToken,
            owner,
            repo,
            repository.webhookId,
          );
        }
      }
    }

    await ctx.db.repository.delete({
      where: {
        id: repository.id,
      },
    });

    return {
      success: true,
    };
  }),
});
