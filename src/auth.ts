import crypto from "node:crypto";
import { promisify } from "node:util";
import type { FastifyRequest } from "fastify";
import { pool } from "./db.js";
import { AppError } from "./money.js";

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, keylen: number) => Promise<Buffer>;

export type Role = "admin" | "holder" | "auditor";
export interface AuthUser {
  id: number;
  email: string;
  role: Role;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
    tokenHash?: string;
  }
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `scrypt:${salt.toString("hex")}:${key.toString("hex")}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, saltHex, keyHex] = stored.split(":");
  if (alg !== "scrypt" || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, "hex");
  const actual = await scrypt(pw, Buffer.from(saltHex, "hex"), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// Used so a login for an unknown email takes as long as one for a real email.
export const dummyHash = hashPassword("not-a-real-password");

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export async function createSession(userId: number): Promise<string> {
  const token = crypto.randomBytes(32).toString("base64url");
  await pool.query(
    `INSERT INTO sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + interval '8 hours')`,
    [userId, sha256(token)]
  );
  return token;
}

// Looks the token up in the database on EVERY request, so logout and expiry
// take effect immediately and the role is always the current one.
export async function authenticate(req: FastifyRequest): Promise<void> {
  const h = req.headers.authorization;
  if (!h || !h.startsWith("Bearer ")) throw new AppError(401, "unauthenticated");
  const tokenHash = sha256(h.slice(7).trim());
  const r = await pool.query(
    `SELECT u.id, u.email, u.role
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND s.revoked_at IS NULL`,
    [tokenHash]
  );
  if (r.rowCount === 0) throw new AppError(401, "unauthenticated");
  req.user = { id: Number(r.rows[0].id), email: r.rows[0].email, role: r.rows[0].role };
  req.tokenHash = tokenHash;
}

export function requireRole(...roles: Role[]) {
  return async (req: FastifyRequest) => {
    await authenticate(req);
    if (!roles.includes(req.user!.role)) throw new AppError(403, "forbidden");
  };
}