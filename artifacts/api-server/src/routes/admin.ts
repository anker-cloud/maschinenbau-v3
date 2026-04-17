import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { CreateUserBody } from "@workspace/api-zod";
import { authenticate, requireAdmin, hashPassword } from "../lib/auth";
import { parseUuidParam } from "../lib/validation";

const router: IRouter = Router();

router.use(authenticate, requireAdmin);

router.get("/admin/users", async (_req, res): Promise<void> => {
  const users = await db
    .select({
      id: usersTable.id,
      email: usersTable.email,
      name: usersTable.name,
      role: usersTable.role,
      createdAt: usersTable.createdAt,
    })
    .from(usersTable)
    .orderBy(desc(usersTable.createdAt));
  res.json(users);
});

router.post("/admin/users", async (req, res): Promise<void> => {
  const parsed = CreateUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { email, name, password, role } = parsed.data;
  const normalizedEmail = email.toLowerCase().trim();
  const [existing] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, normalizedEmail));
  if (existing) {
    res.status(409).json({ error: "A user with this email already exists" });
    return;
  }
  const passwordHash = await hashPassword(password);
  const [user] = await db
    .insert(usersTable)
    .values({
      email: normalizedEmail,
      name,
      passwordHash,
      role,
    })
    .returning();
  res.status(201).json({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    createdAt: user.createdAt,
  });
});

router.delete("/admin/users/:id", async (req, res): Promise<void> => {
  const id = parseUuidParam(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
  if (id === req.user!.id) {
    res.status(400).json({ error: "Cannot delete your own account" });
    return;
  }
  const [deleted] = await db
    .delete(usersTable)
    .where(eq(usersTable.id, id))
    .returning();
  if (!deleted) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  res.status(204).end();
});

export default router;
