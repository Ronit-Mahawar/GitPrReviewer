import { orderSubtotal, type Order } from "./orders";
import { applyDiscount } from "./pricing";

export interface Coupon {
  code: string;
  percent: number;
}

/** Amount to charge for an order, in cents, after an optional coupon. */
export function amountToCharge(order: Order, coupon?: Coupon): number {
  const subtotal = orderSubtotal(order);
  return coupon ? applyDiscount(subtotal, coupon.percent) : subtotal;
}
