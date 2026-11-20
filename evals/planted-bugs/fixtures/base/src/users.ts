import { query } from "./db";

export interface Profile {
  name: string;
  avatarUrl?: string;
}

export interface User {
  id: string;
  email: string;
  role: "admin" | "member";
  /** null until the user finishes onboarding */
  profile: Profile | null;
}

export async function findUserById(id: string): Promise<User | undefined> {
  const rows = await query<User>("SELECT * FROM users WHERE id = $1", [id]);
  return rows[0];
}

export async function findUserByEmail(email: string): Promise<User | undefined> {
  const rows = await query<User>("SELECT * FROM users WHERE email = $1", [email]);
  return rows[0];
}
