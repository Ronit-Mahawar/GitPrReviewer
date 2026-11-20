import { query } from "./db";

export interface LineItem {
  sku: string;
  unitPrice: number;
  quantity: number;
}

export interface Address {
  line1: string;
  city: string;
  postalCode: string;
}

export interface Order {
  id: string;
  userId: string;
  items: LineItem[];
  /** undefined for digital-only orders */
  shippingAddress?: Address;
  createdAt: string;
  status: "pending" | "paid" | "shipped" | "cancelled";
}

export async function listOrdersForUser(userId: string): Promise<Order[]> {
  return query<Order>("SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC", [userId]);
}

export function orderSubtotal(order: Order): number {
  let total = 0;
  for (let i = 0; i < order.items.length; i++) {
    total += order.items[i].unitPrice * order.items[i].quantity;
  }
  return total;
}
