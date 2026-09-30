import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/server/db";
import { inngest } from "@/server/inngest";

interface PullRequestPayload {
  action: string;
  number: number;
  pull_request: {
    id: number;
    number: number;
    title: string;
    html_url: string;
    state: string;
    draft: boolean;
    head: {
      sha: string;
    };
  };
  repository: {
    id: number;
    full_name: string;
  };
}

function verifySignature(
  payload: string,
  signature: string | null,
): boolean {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;

  // Fail closed in production.
  if (!secret) {
    console.error(
      "GITHUB_WEBHOOK_SECRET is not configured",
    );
    return false;
  }

  if (!signature) {
    return false;
  }

  const hmac = crypto.createHmac("sha256", secret);

  const expectedSignature =
    "sha256=" +
    hmac.update(payload).digest("hex");

  const expected = Buffer.from(expectedSignature);
  const actual = Buffer.from(signature);

  // timingSafeEqual requires buffers of equal length.
  if (expected.length !== actual.length) {
    return false;
  }

  return crypto.timingSafeEqual(expected, actual);
}

export async function POST(request: NextRequest) {
  // IMPORTANT:
  // Read the raw body because GitHub signs the raw payload.
  const payload = await request.text();

  const signature = request.headers.get(
    "x-hub-signature-256",
  );

  const event = request.headers.get(
    "x-github-event",
  );

  const deliveryId = request.headers.get(
    "x-github-delivery",
  );

  // --------------------------------------------------
  // 1. Verify GitHub signature
  // --------------------------------------------------

  if (!verifySignature(payload, signature)) {
    return NextResponse.json(
      { error: "Invalid signature" },
      { status: 401 },
    );
  }

  // --------------------------------------------------
  // 2. Delivery ID is required for idempotency
  // --------------------------------------------------

  if (!deliveryId) {
    return NextResponse.json(
      { error: "Missing GitHub delivery ID" },
      { status: 400 },
    );
  }

  // --------------------------------------------------
  // 3. Only process pull_request events
  // --------------------------------------------------

  if (event !== "pull_request") {
    return NextResponse.json(
      { message: "Event ignored" },
      { status: 200 },
    );
  }

  let data: PullRequestPayload;

  try {
    data = JSON.parse(payload) as PullRequestPayload;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON payload" },
      { status: 400 },
    );
  }

  // --------------------------------------------------
  // 4. Only process relevant PR actions
  // --------------------------------------------------

  if (
    !["opened", "synchronize", "reopened"].includes(
      data.action,
    )
  ) {
    return NextResponse.json(
      {
        message: `Action '${data.action}' ignored`,
      },
      { status: 200 },
    );
  }

  // --------------------------------------------------
  // 5. Skip draft PRs
  // --------------------------------------------------

  if (data.pull_request.draft) {
    return NextResponse.json(
      { message: "Draft PR ignored" },
      { status: 200 },
    );
  }

  // --------------------------------------------------
  // 6. Find repository
  // --------------------------------------------------

  const repository = await db.repository.findUnique({
    where: {
      githubId: data.repository.id,
    },
  });

  if (!repository) {
    return NextResponse.json(
      { message: "Repository not connected" },
      { status: 200 },
    );
  }

  // --------------------------------------------------
  // 7. Check automatic review setting
  // --------------------------------------------------

  if (!repository.autoReviewEnabled) {
    return NextResponse.json(
      {
        message:
          "Automatic review is disabled for this repository",
      },
      { status: 200 },
    );
  }

  // --------------------------------------------------
  // 8. Prevent duplicate webhook deliveries
  // --------------------------------------------------

  try {
    await db.webhookDelivery.create({
      data: {
        deliveryId,
        repositoryId: repository.id,
        event,
        action: data.action,
      },
    });
  } catch (error) {
    // Unique constraint means this delivery was already processed.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return NextResponse.json(
        {
          message: "Webhook delivery already processed",
        },
        { status: 200 },
      );
    }

    throw error;
  }

  // --------------------------------------------------
  // 9. Check if a review is already running
  // --------------------------------------------------

  const existingReview = await db.review.findFirst({
    where: {
      repositoryId: repository.id,
      prNumber: data.pull_request.number,
      status: {
        in: ["PENDING", "PROCESSING"],
      },
    },
  });

  if (existingReview) {
    return NextResponse.json(
      {
        message: "Review already in progress",
      },
      { status: 200 },
    );
  }

  // --------------------------------------------------
  // 10. Create review
  // --------------------------------------------------

  const review = await db.review.create({
    data: {
      repositoryId: repository.id,
      userId: repository.userId,
      prNumber: data.pull_request.number,
      prTitle: data.pull_request.title,
      prUrl: data.pull_request.html_url,
      status: "PENDING",
    },
  });

  // --------------------------------------------------
  // 11. Trigger background review
  // --------------------------------------------------

  await inngest.send({
    name: "review/pr.requested",
    data: {
      reviewId: review.id,
      repositoryId: repository.id,
      prNumber: data.pull_request.number,
      userId: repository.userId,
    },
  });

  return NextResponse.json(
    {
      message: "Review triggered",
      reviewId: review.id,
      deliveryId,
    },
    { status: 200 },
  );
}