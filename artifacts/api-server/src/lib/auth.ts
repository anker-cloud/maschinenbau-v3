import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomBytes } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { db, usersTable, sessionsTable } from "@workspace/db";
import { and, eq, gt } from "drizzle-orm";
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
const ACCESS_TOKEN_TTL = "1h";
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const ACCESS_COOKIE = "sturtz_token";
const REFRESH_COOKIE = "sturtz_refresh";

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

export function signAccessToken(user: AuthUser): string {
  return jwt.sign(
    { sub: user.id, email: user.email, name: user.name, role: user.role },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL },
  );
}

export function verifyAccessToken(token: string): AuthUser | null {
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

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
}

export async function createSession(user: AuthUser): Promise<IssuedSession> {
  const refreshToken = randomBytes(48).toString("hex");
  const refreshTokenHash = await bcrypt.hash(refreshToken, 10);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
  await db.insert(sessionsTable).values({
    userId: user.id,
    refreshTokenHash,
    expiresAt,
  });
  return {
    accessToken: signAccessToken(user),
    refreshToken,
    refreshExpiresAt: expiresAt,
  };
}

export async function rotateSession(refreshToken: string): Promise<{
  user: AuthUser;
  session: IssuedSession;
} | null> {
  if (!refreshToken) return null;
  // Look up valid sessions; we have to bcrypt-compare since we only store hashes.
  const candidates = await db
    .select()
    .from(sessionsTable)
    .where(gt(sessionsTable.expiresAt, new Date()));
  let matched = null;
  for (const s of candidates) {
    if (await bcrypt.compare(refreshToken, s.refreshTokenHash)) {
      matched = s;
      break;
    }
  }
  if (!matched) return null;
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, matched.userId));
  if (!user) return null;
  // Rotate: delete old session, create new one.
  await db.delete(sessionsTable).where(eq(sessionsTable.id, matched.id));
  const authUser: AuthUser = {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role as "admin" | "user",
  };
  const session = await createSession(authUser);
  return { user: authUser, session };
}

export async function revokeAllUserSessions(userId: string): Promise<void> {
  await db.delete(sessionsTable).where(eq(sessionsTable.userId, userId));
}

/**
 * Revoke a single session identified by its raw refresh token. Returns true
 * if a matching session row was deleted. Used by /auth/logout to ensure a
 * leaked or retained refresh token cannot mint new access tokens after
 * logout.
 */
export async function revokeRefreshToken(refreshToken: string): Promise<boolean> {
  if (!refreshToken) return false;
  const candidates = await db
    .select()
    .from(sessionsTable)
    .where(gt(sessionsTable.expiresAt, new Date()));
  for (const s of candidates) {
    if (await bcrypt.compare(refreshToken, s.refreshTokenHash)) {
      await db.delete(sessionsTable).where(eq(sessionsTable.id, s.id));
      return true;
    }
  }
  return false;
}

export function setAuthCookies(
  res: Response,
  accessToken: string,
  refreshToken: string,
  refreshExpiresAt: Date,
): void {
  res.cookie(ACCESS_COOKIE, accessToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: IS_PRODUCTION,
    maxAge: 60 * 60 * 1000,
    path: "/",
  });
  res.cookie(REFRESH_COOKIE, refreshToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: IS_PRODUCTION,
    expires: refreshExpiresAt,
    path: "/",
  });
}

export function clearAuthCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE, { path: "/" });
  res.clearCookie(REFRESH_COOKIE, { path: "/" });
}

export function getRefreshTokenFromRequest(req: Request): string | null {
  const cookieToken = req.cookies?.[REFRESH_COOKIE];
  if (cookieToken) return cookieToken;
  const bodyToken = (req.body as { refreshToken?: string } | undefined)?.refreshToken;
  return bodyToken ?? null;
}

function extractAccessToken(req: Request): string | null {
  const cookieToken = req.cookies?.[ACCESS_COOKIE];
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
  const token = extractAccessToken(req);
  if (!token) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const user = verifyAccessToken(token);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
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
