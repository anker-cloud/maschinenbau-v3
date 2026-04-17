import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { ChangePasswordBody, LoginBody, RegisterBody, UpdateProfileBody } from "@workspace/api-zod";
import {
  authenticate,
  clearAuthCookies,
  createSession,
  getRefreshTokenFromRequest,
  hashPassword,
  requireAdmin,
  revokeAllUserSessions,
  revokeRefreshToken,
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

// Admin-only account creation. Per product requirements, all account
// provisioning is gated to admins; there is no public self-signup. The
// /admin/users endpoint is the canonical UI surface; this route exists for
// API parity and matches the OpenAPI contract.
router.post("/auth/register", authenticate, requireAdmin, async (req, res): Promise<void> => {
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
  // Admin-created accounts do not get an active session — the new user must
  // log in themselves. We still return an AuthResponse-shaped payload for
  // contract compatibility, with empty token/refreshToken strings.
  res.status(201).json({
    token: "",
    refreshToken: "",
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
  const [dbUser] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, result.user.id));
  if (!dbUser) {
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
    user: userToResponse(dbUser),
  });
});

router.post("/auth/logout", async (req, res): Promise<void> => {
  const refreshToken = getRefreshTokenFromRequest(req);
  if (refreshToken) {
    await revokeRefreshToken(refreshToken);
  }
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

router.get("/auth/check-email", authenticate, async (req, res): Promise<void> => {
  const raw = String(req.query.email ?? "").toLowerCase().trim();
  if (!raw || !raw.includes("@")) {
    res.status(400).json({ error: "Missing or invalid email query parameter" });
    return;
  }
  // The caller's own email is always "available" to them.
  if (raw === req.user!.email.toLowerCase()) {
    res.json({ available: true });
    return;
  }
  const [existing] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.email, raw));
  res.json({ available: !existing });
});

router.patch("/auth/me", authenticate, async (req, res): Promise<void> => {
  const parsed = UpdateProfileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const { name, email } = parsed.data;
  if (!name && !email) {
    res.status(400).json({ error: "At least one field (name or email) is required" });
    return;
  }
  const updates: Partial<{ name: string; email: string }> = {};
  if (name !== undefined) {
    const trimmedName = name.trim();
    if (!trimmedName) {
      res.status(400).json({ error: "Name cannot be blank" });
      return;
    }
    updates.name = trimmedName;
  }
  if (email !== undefined) {
    const trimmedEmail = email.toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      res.status(400).json({ error: "Invalid email address" });
      return;
    }
    const [existing] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, trimmedEmail));
    if (existing && existing.id !== req.user!.id) {
      res.status(409).json({ error: "Email already in use" });
      return;
    }
    updates.email = trimmedEmail;
  }
  try {
    const [updated] = await db
      .update(usersTable)
      .set(updates)
      .where(eq(usersTable.id, req.user!.id))
      .returning();
    if (!updated) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    res.json(userToResponse(updated));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/unique.*email|duplicate.*email/i.test(msg)) {
      res.status(409).json({ error: "Email already in use" });
    } else {
      throw err;
    }
  }
});

router.post("/auth/change-password", authenticate, async (req, res): Promise<void> => {
  const parsed = ChangePasswordBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const { currentPassword, newPassword } = parsed.data;
  if (newPassword.length < 8) {
    res.status(400).json({ error: "New password must be at least 8 characters" });
    return;
  }
  if (currentPassword === newPassword) {
    res.status(400).json({ error: "New password must differ from current password" });
    return;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.user!.id));
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const ok = await verifyPassword(currentPassword, user.passwordHash);
  if (!ok) {
    res.status(401).json({ error: "Current password is incorrect" });
    return;
  }
  const newHash = await hashPassword(newPassword);
  // Floor to whole seconds: JWT iat is in seconds, so a sub-second
  // passwordChangedAt would falsely reject the brand-new access token we are
  // about to mint for this caller.
  const passwordChangedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
  await db
    .update(usersTable)
    .set({ passwordHash: newHash, passwordChangedAt })
    .where(eq(usersTable.id, user.id));
  // Invalidate every existing refresh-token session so any stolen cookie is
  // dead. Existing access tokens (JWTs) are rejected by `authenticate` via the
  // passwordChangedAt check above.
  await revokeAllUserSessions(user.id);
  // Issue a fresh session for the active caller so they stay signed in.
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

export default router;
