import type { Req, Res } from "../http";
import { isFeatureEnabled } from "../flags";
import { listOrdersForUser } from "../orders";

/** GET /beta/order-insights — only for accounts in the beta. */
export async function orderInsightsHandler(req: Req, res: Res) {
  if (!req.userId) return res.status(401).json({ error: "unauthorized" });
  if (!isFeatureEnabled("order-insights")) return res.status(404).json({ error: "not found" });

  const orders = await listOrdersForUser(req.userId);
  res.json({ orders: orders.length, lastOrderAt: orders[0]?.createdAt ?? null });
}
