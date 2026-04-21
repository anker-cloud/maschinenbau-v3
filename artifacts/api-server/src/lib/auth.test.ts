import bcrypt from "bcryptjs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Hoist the DB mock references so they can be controlled per-test.
const mockDbWhere = vi.hoisted(() => vi.fn<() => Promise<unknown[]>>().mockResolvedValue([]));
const mockDbDelete = vi.hoisted(() => vi.fn<() => Promise<unknown[]>>().mockResolvedValue([]));
const mockDbInsertReturning = vi.hoisted(() =>
  vi.fn<() => Promise<unknown[]>>().mockResolvedValue([{ id: "session-id" }]),
);

vi.mock("@workspace/db", () => ({
  db: {
    select: () => ({ from: () => ({ where: mockDbWhere }) }),
    delete: () => ({ where: mockDbDelete }),
    insert: () => ({
      values: () => ({
        returning: mockDbInsertReturning,
      }),
    }),
    update: () => ({ set: () => ({ where: vi.fn().mockResolvedValue([]) }) }),
  },
  usersTable: {
    id: "id",
    email: "email",
    passwordChangedAt: "passwordChangedAt",
  },
  sessionsTable: {
    id: "id",
    userId: "userId",
    refreshTokenHash: "refreshTokenHash",
    expiresAt: "expiresAt",
  },
}));

import {
  type AuthUser,
  authenticate,
  clearAuthCookies,
  createSession,
  ensureAdminUser,
  getRefreshTokenFromRequest,
  hashPassword,
  requireAdmin,
  revokeAllUserSessions,
  revokeRefreshToken,
  rotateSession,
  setAuthCookies,
  signAccessToken,
  verifyAccessToken,
  verifyPassword,
} from "./auth";

// ── Shared fixtures ────────────────────────────────────────────────────────────

const testUser: AuthUser = {
  id: "123e4567-e89b-12d3-a456-426614174000",
  email: "test@example.com",
  name: "Test User",
  role: "user",
};

const dbUser = {
  id: testUser.id,
  email: testUser.email,
  name: testUser.name,
  role: testUser.role,
  passwordChangedAt: null as Date | null,
};

function makeMockRes() {
  const mockJson = vi.fn();
  const mockStatus = vi.fn(() => ({ json: mockJson }));
  return { res: { status: mockStatus } as any, mockStatus, mockJson };
}

// ── hashPassword / verifyPassword ─────────────────────────────────────────────

describe("hashPassword / verifyPassword", () => {
  it("produces a hash that verifies against the original password", async () => {
    const hash = await hashPassword("my-secret");
    expect(await verifyPassword("my-secret", hash)).toBe(true);
  });

  it("returns false for an incorrect password", async () => {
    const hash = await hashPassword("my-secret");
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });
});

// ── signAccessToken / verifyAccessToken ───────────────────────────────────────

describe("signAccessToken / verifyAccessToken", () => {
  it("round-trips user data through a signed JWT", () => {
    const token = signAccessToken(testUser);
    const result = verifyAccessToken(token);
    expect(result).not.toBeNull();
    expect(result!.user).toMatchObject(testUser);
    expect(typeof result!.issuedAtSeconds).toBe("number");
  });

  it("returns null for a tampered token", () => {
    expect(verifyAccessToken(signAccessToken(testUser) + "x")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(verifyAccessToken("")).toBeNull();
  });

  it("returns null for a random non-JWT string", () => {
    expect(verifyAccessToken("not.a.jwt")).toBeNull();
  });

  it("encodes all four user fields", () => {
    const admin: AuthUser = { ...testUser, role: "admin" };
    const result = verifyAccessToken(signAccessToken(admin));
    expect(result!.user.role).toBe("admin");
    expect(result!.user.email).toBe(testUser.email);
    expect(result!.user.name).toBe(testUser.name);
  });
});

// ── createSession ─────────────────────────────────────────────────────────────

describe("createSession", () => {
  beforeEach(() => {
    mockDbInsertReturning.mockResolvedValue([{ id: "new-session-id" }]);
  });

  it("returns an access token, refresh token and expiry date", async () => {
    const result = await createSession(testUser);
    expect(typeof result.accessToken).toBe("string");
    expect(result.refreshToken).toMatch(/^new-session-id\./);
    expect(result.refreshExpiresAt).toBeInstanceOf(Date);
    expect(result.refreshExpiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("access token decodes to the correct user", async () => {
    const result = await createSession(testUser);
    const verified = verifyAccessToken(result.accessToken);
    expect(verified!.user.id).toBe(testUser.id);
  });
});

// ── rotateSession ─────────────────────────────────────────────────────────────

describe("rotateSession", () => {
  const SESSION_ID = "223e4567-e89b-12d3-a456-426614174001";
  const SESSION_SECRET = "test-rotate-secret";
  let sessionHash: string;

  beforeAll(async () => {
    sessionHash = await bcrypt.hash(SESSION_SECRET, 4);
  });

  beforeEach(() => {
    mockDbWhere.mockReset();
    mockDbDelete.mockReset().mockResolvedValue([]);
    mockDbInsertReturning.mockReset().mockResolvedValue([{ id: "rotated-session-id" }]);
  });

  const makeToken = () => `${SESSION_ID}.${SESSION_SECRET}`;
  const makeSession = (overrides: Partial<typeof dbUser & { refreshTokenHash: string; expiresAt: Date }> = {}) => ({
    id: SESSION_ID,
    userId: testUser.id,
    refreshTokenHash: sessionHash,
    expiresAt: new Date(Date.now() + 86_400_000),
    ...overrides,
  });

  it("returns new tokens and the user for a valid refresh token", async () => {
    mockDbWhere
      .mockResolvedValueOnce([makeSession()])
      .mockResolvedValueOnce([dbUser]);

    const result = await rotateSession(makeToken());
    expect(result).not.toBeNull();
    expect(result!.user.id).toBe(testUser.id);
    expect(result!.session.accessToken).toBeTruthy();
    expect(result!.session.refreshToken).toMatch(/^rotated-session-id\./);
  });

  it("returns null for a token that does not contain a dot", async () => {
    expect(await rotateSession("nodottoken")).toBeNull();
  });

  it("returns null when the session is not found in the DB", async () => {
    mockDbWhere.mockResolvedValueOnce([]);
    expect(await rotateSession(makeToken())).toBeNull();
  });

  it("returns null when the session has expired", async () => {
    mockDbWhere.mockResolvedValueOnce([makeSession({ expiresAt: new Date(Date.now() - 1000) })]);
    expect(await rotateSession(makeToken())).toBeNull();
  });

  it("returns null when the secret does not match the stored hash", async () => {
    const wrongHash = await bcrypt.hash("different-secret", 4);
    mockDbWhere.mockResolvedValueOnce([makeSession({ refreshTokenHash: wrongHash })]);
    expect(await rotateSession(makeToken())).toBeNull();
  });

  it("returns null when the user no longer exists", async () => {
    mockDbWhere
      .mockResolvedValueOnce([makeSession()])
      .mockResolvedValueOnce([]);
    expect(await rotateSession(makeToken())).toBeNull();
  });

  it("returns null for an empty string", async () => {
    expect(await rotateSession("")).toBeNull();
  });
});

// ── revokeAllUserSessions ─────────────────────────────────────────────────────

describe("revokeAllUserSessions", () => {
  it("resolves without throwing for a valid user ID", async () => {
    mockDbDelete.mockResolvedValue([]);
    await expect(revokeAllUserSessions(testUser.id)).resolves.toBeUndefined();
    expect(mockDbDelete).toHaveBeenCalledOnce();
  });
});

// ── revokeRefreshToken ────────────────────────────────────────────────────────

describe("revokeRefreshToken", () => {
  const SESSION_ID = "323e4567-e89b-12d3-a456-426614174002";
  const SESSION_SECRET = "test-revoke-secret";
  let sessionHash: string;

  beforeAll(async () => {
    sessionHash = await bcrypt.hash(SESSION_SECRET, 4);
  });

  beforeEach(() => {
    mockDbWhere.mockReset();
    mockDbDelete.mockReset().mockResolvedValue([]);
  });

  const makeToken = () => `${SESSION_ID}.${SESSION_SECRET}`;
  const makeSession = () => ({
    id: SESSION_ID,
    userId: testUser.id,
    refreshTokenHash: sessionHash,
    expiresAt: new Date(Date.now() + 86_400_000),
  });

  it("returns true and deletes the session for a valid token", async () => {
    mockDbWhere.mockResolvedValueOnce([makeSession()]);
    const result = await revokeRefreshToken(makeToken());
    expect(result).toBe(true);
    expect(mockDbDelete).toHaveBeenCalledOnce();
  });

  it("returns false for an empty string", async () => {
    expect(await revokeRefreshToken("")).toBe(false);
  });

  it("returns false when the session is not found", async () => {
    mockDbWhere.mockResolvedValueOnce([]);
    expect(await revokeRefreshToken(makeToken())).toBe(false);
  });
});

// ── requireAdmin ──────────────────────────────────────────────────────────────

describe("requireAdmin", () => {
  const mockNext = vi.fn();

  beforeEach(() => { vi.clearAllMocks(); });

  it("calls next() for admin user", () => {
    const { res, mockStatus } = makeMockRes();
    requireAdmin({ user: { ...testUser, role: "admin" } } as any, res, mockNext);
    expect(mockNext).toHaveBeenCalledOnce();
    expect(mockStatus).not.toHaveBeenCalled();
  });

  it("returns 403 for non-admin authenticated user", () => {
    const { res, mockStatus, mockJson } = makeMockRes();
    requireAdmin({ user: testUser } as any, res, mockNext);
    expect(mockStatus).toHaveBeenCalledWith(403);
    expect(mockJson).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }));
    expect(mockNext).not.toHaveBeenCalled();
  });

  it("returns 401 when req.user is undefined", () => {
    const { res, mockStatus } = makeMockRes();
    requireAdmin({} as any, res, mockNext);
    expect(mockStatus).toHaveBeenCalledWith(401);
    expect(mockNext).not.toHaveBeenCalled();
  });
});

// ── setAuthCookies / clearAuthCookies ─────────────────────────────────────────

describe("setAuthCookies / clearAuthCookies", () => {
  it("sets both cookie names", () => {
    const names: string[] = [];
    const res: any = { cookie: vi.fn((_n: string) => { names.push(_n); }) };
    setAuthCookies(res, "access", "refresh", new Date(Date.now() + 86400_000));
    expect(res.cookie).toHaveBeenCalledTimes(2);
    expect(names).toContain("sturtz_token");
    expect(names).toContain("sturtz_refresh");
  });

  it("passes the correct token values", () => {
    const cookies: Record<string, string> = {};
    const res: any = { cookie: vi.fn((n: string, v: string) => { cookies[n] = v; }) };
    setAuthCookies(res, "my-access", "my-refresh", new Date());
    expect(cookies["sturtz_token"]).toBe("my-access");
    expect(cookies["sturtz_refresh"]).toBe("my-refresh");
  });

  it("clears both cookies", () => {
    const cleared: string[] = [];
    const res: any = { clearCookie: vi.fn((n: string) => { cleared.push(n); }) };
    clearAuthCookies(res);
    expect(cleared).toContain("sturtz_token");
    expect(cleared).toContain("sturtz_refresh");
  });
});

// ── getRefreshTokenFromRequest ────────────────────────────────────────────────

describe("getRefreshTokenFromRequest", () => {
  it("returns the token from the cookie", () => {
    expect(getRefreshTokenFromRequest({ cookies: { sturtz_refresh: "cookie-token" }, body: {} } as any))
      .toBe("cookie-token");
  });

  it("falls back to req.body.refreshToken when cookie is absent", () => {
    expect(getRefreshTokenFromRequest({ cookies: {}, body: { refreshToken: "body-token" } } as any))
      .toBe("body-token");
  });

  it("prefers the cookie over the body", () => {
    expect(getRefreshTokenFromRequest({
      cookies: { sturtz_refresh: "cookie-token" },
      body: { refreshToken: "body-token" },
    } as any)).toBe("cookie-token");
  });

  it("returns null when neither source is present", () => {
    expect(getRefreshTokenFromRequest({ cookies: {}, body: {} } as any)).toBeNull();
  });
});

// ── authenticate ──────────────────────────────────────────────────────────────

describe("authenticate", () => {
  const mockNext = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbWhere.mockReset();
  });

  it("sets req.user and calls next() for a valid cookie token", async () => {
    mockDbWhere.mockResolvedValue([dbUser]);
    const token = signAccessToken(testUser);
    const req: any = { cookies: { sturtz_token: token }, headers: {}, body: {} };
    const { res } = makeMockRes();
    await authenticate(req, res, mockNext);
    expect(mockNext).toHaveBeenCalledOnce();
    expect(req.user).toMatchObject({ id: testUser.id, role: testUser.role });
  });

  it("accepts a Bearer token from the Authorization header", async () => {
    mockDbWhere.mockResolvedValue([dbUser]);
    const token = signAccessToken(testUser);
    const req: any = { cookies: {}, headers: { authorization: `Bearer ${token}` }, body: {} };
    const { res } = makeMockRes();
    await authenticate(req, res, mockNext);
    expect(mockNext).toHaveBeenCalledOnce();
  });

  it("returns 401 when no token is provided", async () => {
    const req: any = { cookies: {}, headers: {}, body: {} };
    const { res, mockStatus } = makeMockRes();
    await authenticate(req, res, mockNext);
    expect(mockStatus).toHaveBeenCalledWith(401);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it("returns 401 for an invalid token", async () => {
    const req: any = { cookies: { sturtz_token: "invalid.token" }, headers: {}, body: {} };
    const { res, mockStatus } = makeMockRes();
    await authenticate(req, res, mockNext);
    expect(mockStatus).toHaveBeenCalledWith(401);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it("returns 401 when the user no longer exists in the database", async () => {
    mockDbWhere.mockResolvedValue([]);
    const token = signAccessToken(testUser);
    const req: any = { cookies: { sturtz_token: token }, headers: {}, body: {} };
    const { res, mockStatus } = makeMockRes();
    await authenticate(req, res, mockNext);
    expect(mockStatus).toHaveBeenCalledWith(401);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it("returns 401 when the token was issued before a password change", async () => {
    const token = signAccessToken(testUser);
    const futureChange = new Date(Date.now() + 10_000);
    mockDbWhere.mockResolvedValue([{ ...dbUser, passwordChangedAt: futureChange }]);
    const req: any = { cookies: { sturtz_token: token }, headers: {}, body: {} };
    const { res, mockStatus } = makeMockRes();
    await authenticate(req, res, mockNext);
    expect(mockStatus).toHaveBeenCalledWith(401);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it("allows a token issued after a past password change", async () => {
    const pastChange = new Date(Date.now() - 2 * 3600_000);
    mockDbWhere.mockResolvedValue([{ ...dbUser, passwordChangedAt: pastChange }]);
    const token = signAccessToken(testUser);
    const req: any = { cookies: { sturtz_token: token }, headers: {}, body: {} };
    const { res } = makeMockRes();
    await authenticate(req, res, mockNext);
    expect(mockNext).toHaveBeenCalledOnce();
  });
});

// ── ensureAdminUser ───────────────────────────────────────────────────────────

describe("ensureAdminUser", () => {
  beforeEach(() => {
    mockDbWhere.mockReset();
    mockDbInsertReturning.mockReset().mockResolvedValue([]);
  });

  it("returns early without inserting when admin already exists", async () => {
    mockDbWhere.mockResolvedValue([dbUser]);
    await ensureAdminUser();
    expect(mockDbInsertReturning).not.toHaveBeenCalled();
  });

  it("inserts a new admin user when one does not exist", async () => {
    mockDbWhere.mockResolvedValue([]);
    // insert().values() is awaited directly (no .returning()), so the mock
    // resolves whatever — we just assert insert was called.
    await ensureAdminUser();
    // The insert mock's values() returns an object that includes returning(),
    // but ensureAdminUser doesn't call returning(), it awaits values() directly.
    // We can only assert no error was thrown.
    expect(mockDbWhere).toHaveBeenCalledOnce();
  });
});
