import { orderSubtotal, type Order } from "./orders";

const SHIPPING_CENTS = 499;

/** Receipt lines for an order; all amounts are integer cents. */
export function receiptTotals(order: Order): { subtotalCents: number; shippingCents: number; totalCents: number } {
  const subtotalCents = orderSubtotal(order);
  const shippingCents = order.shippingAddress ? SHIPPING_CENTS : 0;
  return { subtotalCents, shippingCents, totalCents: subtotalCents + shippingCents };
}
