import type { Req, Res } from "../http";
import { getStock } from "../inventory";

/** GET /stock/:sku — stock level for the product page. */
export async function stockHandler(req: Req, res: Res) {
  const sku = req.params.sku;
  const available = await getStock(sku);
  res.json({
    sku,
    available,
    label: `${available.toLocaleString("en-US")} in stock`,
    lowStock: available < 5,
  });
}
