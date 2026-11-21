import { query } from "./db";

export async function getStock(sku: string): Promise<number> {
  const rows = await query<{ quantity: number }>("SELECT quantity FROM inventory WHERE sku = $1", [sku]);
  return rows[0]?.quantity ?? 0;
}
