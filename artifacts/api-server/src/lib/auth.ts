import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomBytes } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { db, usersTable, sessionsTable } from "@workspace/db";
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

export interface VerifiedAccessToken {
  user: AuthUser;
  /** JWT issued-at time in seconds since epoch (as set by jsonwebtoken). */
  issuedAtSeconds: number | null;
}

export function verifyAccessToken(token: string): VerifiedAccessToken | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as jwt.JwtPayload;
    if (!payload.sub || typeof payload.sub !== "string") return null;
    return {
      user: {
        id: payload.sub,
        email: payload.email as string,
        name: payload.name as string,
        role: payload.role as "admin" | "user",
      },
      issuedAtSeconds: typeof payload.iat === "number" ? payload.iat : null,
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

/**
 * Refresh tokens are formatted "<sessionId>.<secret>" where sessionId is the
 * UUID PK of the sessions row and secret is a 48-byte random hex value. Only
 * the secret is bcrypt-hashed in the DB. This lets refresh/revoke perform an
 * indexed O(1) lookup on the sessions table and a single constant-time
 * bcrypt.compare against one row, rather than scanning all open sessions.
 */
function splitRefreshToken(token: string): { sessionId: string; secret: string } | null {
  const idx = token.indexOf(".");
  if (idx <= 0 || idx === token.length - 1) return null;
  const sessionId = token.slice(0, idx);
  const secret = token.slice(idx + 1);
  // sessionId must look like a UUID; sessionsTable.id is uuid type.
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
  return { sessionId, secret };
}

export async function createSession(user: AuthUser): Promise<IssuedSession> {
  const secret = randomBytes(48).toString("hex");
  const refreshTokenHash = await bcrypt.hash(secret, 10);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
  const [row] = await db
    .insert(sessionsTable)
    .values({ userId: user.id, refreshTokenHash, expiresAt })
    .returning({ id: sessionsTable.id });
  return {
    accessToken: signAccessToken(user),
    refreshToken: `${row.id}.${secret}`,
    refreshExpiresAt: expiresAt,
  };
}

async function findValidSession(refreshToken: string) {
  const parts = splitRefreshToken(refreshToken);
  if (!parts) return null;
  const [row] = await db
    .select()
    .from(sessionsTable)
    .where(eq(sessionsTable.id, parts.sessionId));
  if (!row) return null;
  if (row.expiresAt.getTime() <= Date.now()) {
    // Best-effort cleanup of expired row.
    await db.delete(sessionsTable).where(eq(sessionsTable.id, row.id));
    return null;
  }
  const ok = await bcrypt.compare(parts.secret, row.refreshTokenHash);
  if (!ok) return null;
  return row;
}

export async function rotateSession(refreshToken: string): Promise<{
  user: AuthUser;
  session: IssuedSession;
} | null> {
  if (!refreshToken) return null;
  const matched = await findValidSession(refreshToken);
  if (!matched) return null;
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, matched.userId));
  if (!user) return null;
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
 * Revoke the single session identified by the raw refresh token. Returns true
 * if a matching row was deleted.
 */
export async function revokeRefreshToken(refreshToken: string): Promise<boolean> {
  if (!refreshToken) return false;
  const matched = await findValidSession(refreshToken);
  if (!matched) return false;
  await db.delete(sessionsTable).where(eq(sessionsTable.id, matched.id));
  return true;
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
  const verified = verifyAccessToken(token);
  if (!verified) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const [dbUser] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, verified.user.id));
  if (!dbUser) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  // Reject access tokens issued before the user's most recent password
  // change. JWT iat is in whole seconds, so compare on a 1-second granularity.
  if (dbUser.passwordChangedAt && verified.issuedAtSeconds !== null) {
    const changedAtSeconds = Math.floor(dbUser.passwordChangedAt.getTime() / 1000);
    if (verified.issuedAtSeconds < changedAtSeconds) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
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
  const adminEmail = (envEmail || "admin@sturtz.com").toLowerCase().trim();
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
