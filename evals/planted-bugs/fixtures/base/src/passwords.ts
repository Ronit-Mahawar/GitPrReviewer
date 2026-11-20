import crypto from "node:crypto";
import { query } from "./db";

export async function verifyPassword(userId: string, password: string): Promise<boolean> {
  const rows = await query<{ salt: string; hash: string }>("SELECT salt, hash FROM credentials WHERE user_id = $1", [userId]);
  const cred = rows[0];
  if (!cred) return false;
  const derived = crypto.scryptSync(password, cred.salt, 64);
  return crypto.timingSafeEqual(derived, Buffer.from(cred.hash, "hex"));
}
