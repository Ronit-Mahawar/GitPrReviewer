FROM node:20-bookworm-slim

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

# Build-time placeholders so Next.js server module loading does not fail.
# Runtime values are provided by docker-compose `.env`.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/codereviewai" \
    BETTER_AUTH_SECRET="build-time-better-auth-secret-change-at-runtime" \
    BETTER_AUTH_URL="https://example.com" \
    NEXT_PUBLIC_APP_URL="https://example.com" \
    GITHUB_CLIENT_ID="build-github-client-id" \
    GITHUB_CLIENT_SECRET="build-github-client-secret" \
    OPENAI_API_KEY="sk-build-placeholder" \
    GITHUB_WEBHOOK_SECRET="build-github-webhook-secret" \
    INNGEST_EVENT_KEY="build-inngest-event-key" \
    INNGEST_SIGNING_KEY="build-inngest-signing-key"

RUN pnpm db:generate
RUN pnpm build

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

EXPOSE 3000

CMD ["pnpm", "start"]
