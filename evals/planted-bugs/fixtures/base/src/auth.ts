import crypto from "node:crypto";
import { config } from "./config";

export function signSession(userId: string): string {
  const payload = Buffer.from(JSON.stringify({ sub: userId, iat: Date.now() })).toString("base64url");
  const sig = crypto.createHmac("sha256", config.jwtSecret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifySession(token: string): string | null {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = crypto.createHmac("sha256", config.jwtSecret).update(payload).digest("base64url");
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return null;
  }
  return JSON.parse(Buffer.from(payload, "base64url").toString()).sub;
}
