import { Router, type IRouter } from "express";
import { eq, and, desc, sql, count } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  conversationsTable,
  messagesTable,
  messageFeedbackTable,
  usersTable,
} from "@workspace/db";
import { authenticate, requireAdmin } from "../lib/auth";
import { parseUuidParam } from "../lib/validation";

const router: IRouter = Router();

const FeedbackBody = z.object({
  rating: z.enum(["like", "dislike"]),
  comment: z.string().optional(),
});

router.post(
  "/conversations/:conversationId/messages/:messageId/feedback",
  authenticate,
  async (req, res): Promise<void> => {
    const conversationId = parseUuidParam(req.params.conversationId);
    if (!conversationId) {
      res.status(400).json({ error: "Invalid conversationId" });
      return;
    }
    const messageId = parseUuidParam(req.params.messageId);
    if (!messageId) {
      res.status(400).json({ error: "Invalid messageId" });
      return;
    }

    const parsed = FeedbackBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { rating, comment } = parsed.data;

    const [conv] = await db
      .select()
      .from(conversationsTable)
      .where(
        and(
          eq(conversationsTable.id, conversationId),
          eq(conversationsTable.userId, req.user!.id),
        ),
      );
    if (!conv) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }

    const [message] = await db
      .select()
      .from(messagesTable)
      .where(
        and(
          eq(messagesTable.id, messageId),
          eq(messagesTable.conversationId, conversationId),
        ),
      );
    if (!message || message.role !== "assistant") {
      res.status(404).json({ error: "Message not found" });
      return;
    }

    const [feedback] = await db
      .insert(messageFeedbackTable)
      .values({ messageId, userId: req.user!.id, rating, comment })
      .onConflictDoUpdate({
        target: [messageFeedbackTable.messageId, messageFeedbackTable.userId],
        set: { rating, comment },
      })
      .returning();

    res.status(201).json(feedback);
  },
);

const ListFeedbackQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  rating: z.enum(["like", "dislike"]).optional(),
});

router.get(
  "/admin/feedback/counts",
  authenticate,
  requireAdmin,
  async (_req, res): Promise<void> => {
    const [row] = await db
      .select({
        likes: sql<number>`cast(sum(case when ${messageFeedbackTable.rating} = 'like' then 1 else 0 end) as int)`,
        dislikes: sql<number>`cast(sum(case when ${messageFeedbackTable.rating} = 'dislike' then 1 else 0 end) as int)`,
        total: count(),
      })
      .from(messageFeedbackTable);
    res.json({ likes: row.likes ?? 0, dislikes: row.dislikes ?? 0, total: row.total ?? 0 });
  },
);

router.get(
  "/admin/feedback",
  authenticate,
  requireAdmin,
  async (req, res): Promise<void> => {
    const parsed = ListFeedbackQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const { page, pageSize, rating } = parsed.data;
    const offset = (page - 1) * pageSize;
    const whereCondition = rating ? eq(messageFeedbackTable.rating, rating) : undefined;

    const [countResult, items] = await Promise.all([
      db.select({ total: count() }).from(messageFeedbackTable).where(whereCondition),
      db
        .select({
          id: messageFeedbackTable.id,
          messageId: messageFeedbackTable.messageId,
          userId: messageFeedbackTable.userId,
          userEmail: usersTable.email,
          rating: messageFeedbackTable.rating,
          comment: messageFeedbackTable.comment,
          createdAt: messageFeedbackTable.createdAt,
          messageSnippet: sql<string>`substring(${messagesTable.content}, 1, 120)`,
        })
        .from(messageFeedbackTable)
        .innerJoin(messagesTable, eq(messageFeedbackTable.messageId, messagesTable.id))
        .innerJoin(usersTable, eq(messageFeedbackTable.userId, usersTable.id))
        .where(whereCondition)
        .orderBy(desc(messageFeedbackTable.createdAt))
        .limit(pageSize)
        .offset(offset),
    ]);

    const { total } = countResult[0];
    res.json({ items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) });
  },
);

export default router;
