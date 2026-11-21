import type { Req, Res } from "../http";
import { findUserById } from "../users";

/** GET /users/:id — a member can read their own profile; admins can read anyone's. */
export async function getUserHandler(req: Req, res: Res) {
  if (!req.userId) return res.status(401).json({ error: "unauthorized" });

  const requester = await findUserById(req.userId);
  if (!requester) return res.status(401).json({ error: "unauthorized" });
  if (requester.id !== req.params.id && requester.role !== "admin") {
    return res.status(403).json({ error: "forbidden" });
  }

  const user = await findUserById(req.params.id);
  if (!user) return res.status(404).json({ error: "not found" });
  res.json({ id: user.id, email: user.email, role: user.role, profile: user.profile });
}
