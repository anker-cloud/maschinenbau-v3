import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { LoginBody, RegisterBody } from "@workspace/api-zod";
import {
  authenticate,
  clearAuthCookies,
  createSession,
  getRefreshTokenFromRequest,
  hashPassword,
  rotateSession,
  setAuthCookies,
  verifyPassword,
  type AuthUser,
} from "../lib/auth";

const router: IRouter = Router();

function userToResponse(u: { id: string; email: string; name: string; role: string; createdAt: Date }) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    createdAt: u.createdAt,
  };
}

router.post("/auth/register", async (req, res): Promise<void> => {
  const parsed = RegisterBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const email = parsed.data.email.toLowerCase().trim();
  if (!email.includes("@") || parsed.data.password.length < 8) {
    res.status(400).json({ error: "Invalid email or password too short (min 8)" });
    return;
  }
  const [existing] = await db.select().from(usersTable).where(eq(usersTable.email, email));
  if (existing) {
    res.status(409).json({ error: "Email already in use" });
    return;
  }
  const passwordHash = await hashPassword(parsed.data.password);
  const [user] = await db
    .insert(usersTable)
    .values({ email, name: parsed.data.name, passwordHash, role: "user" })
    .returning();
  const authUser: AuthUser = {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role as "admin" | "user",
  };
  const session = await createSession(authUser);
  setAuthCookies(res, session.accessToken, session.refreshToken, session.refreshExpiresAt);
  res.status(201).json({
    token: session.accessToken,
    refreshToken: session.refreshToken,
    user: userToResponse(user),
  });
});

router.post("/auth/login", async (req, res): Promise<void> => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const { email, password } = parsed.data;
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email.toLowerCase().trim()));
  if (!user) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }
  const authUser: AuthUser = {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role as "admin" | "user",
  };
  const session = await createSession(authUser);
  setAuthCookies(res, session.accessToken, session.refreshToken, session.refreshExpiresAt);
  res.json({
    token: session.accessToken,
    refreshToken: session.refreshToken,
    user: userToResponse(user),
  });
});

router.post("/auth/refresh", async (req, res): Promise<void> => {
  const refreshToken = getRefreshTokenFromRequest(req);
  if (!refreshToken) {
    res.status(401).json({ error: "Missing refresh token" });
    return;
  }
  const result = await rotateSession(refreshToken);
  if (!result) {
    clearAuthCookies(res);
    res.status(401).json({ error: "Invalid refresh token" });
    return;
  }
  setAuthCookies(
    res,
    result.session.accessToken,
    result.session.refreshToken,
    result.session.refreshExpiresAt,
  );
  res.json({
    token: result.session.accessToken,
    refreshToken: result.session.refreshToken,
    user: { ...result.user, createdAt: new Date() },
  });
});

router.post("/auth/logout", (_req, res): void => {
  clearAuthCookies(res);
  res.status(204).end();
});

router.get("/auth/me", authenticate, async (req, res): Promise<void> => {
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, req.user!.id));
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  res.json(userToResponse(user));
});

export default router;
