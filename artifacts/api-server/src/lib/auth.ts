import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

const IS_PRODUCTION = process.env.NODE_ENV === "production";

function resolveJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (IS_PRODUCTION) {
      throw new Error(
        "JWT_SECRET environment variable is required in production. " +
          "Set it as a secret before starting the server.",
      );
    }
    return "dev-secret-change-me";
  }
  return secret;
}

const JWT_SECRET = resolveJwtSecret();
const JWT_EXPIRES_IN = "7d";
const COOKIE_NAME = "sturtz_token";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: "admin" | "user";
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function signToken(user: AuthUser): string {
  return jwt.sign(
    { sub: user.id, email: user.email, name: user.name, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN },
  );
}

export function verifyToken(token: string): AuthUser | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as jwt.JwtPayload;
    if (!payload.sub || typeof payload.sub !== "string") return null;
    return {
      id: payload.sub,
      email: payload.email as string,
      name: payload.name as string,
      role: payload.role as "admin" | "user",
    };
  } catch {
    return null;
  }
}

export function setAuthCookie(res: Response, token: string): void {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/",
  });
}

export function clearAuthCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, { path: "/" });
}

function extractToken(req: Request): string | null {
  const cookieToken = req.cookies?.[COOKIE_NAME];
  if (cookieToken) return cookieToken;
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice("Bearer ".length);
  return null;
}

export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const user = verifyToken(token);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  // Verify user still exists in DB
  const [dbUser] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, user.id));
  if (!dbUser) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  req.user = {
    id: dbUser.id,
    email: dbUser.email,
    name: dbUser.name,
    role: dbUser.role as "admin" | "user",
  };
  next();
}

export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (req.user.role !== "admin") {
    res.status(403).json({ error: "Forbidden: admin only" });
    return;
  }
  next();
}

export async function ensureAdminUser(): Promise<void> {
  const envEmail = process.env.SEED_ADMIN_EMAIL;
  const envPassword = process.env.SEED_ADMIN_PASSWORD;
  if (IS_PRODUCTION && (!envEmail || !envPassword)) {
    logger.warn(
      "SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD are not set in production; skipping admin seeding.",
    );
    return;
  }
  const adminEmail = envEmail || "admin@sturtz.com";
  const adminPassword = envPassword || "changeme123";
  const adminName = process.env.SEED_ADMIN_NAME || "Admin";

  const [existing] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, adminEmail));

  if (existing) {
    logger.info({ email: adminEmail }, "Admin user already exists");
    return;
  }

  const passwordHash = await hashPassword(adminPassword);
  await db.insert(usersTable).values({
    email: adminEmail,
    name: adminName,
    passwordHash,
    role: "admin",
  });
  logger.info({ email: adminEmail }, "Seeded initial admin user");
}
