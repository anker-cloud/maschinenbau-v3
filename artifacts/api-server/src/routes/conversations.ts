import { Router, type IRouter } from "express";
import { eq, and, asc, desc } from "drizzle-orm";
import {
  db,
  conversationsTable,
  messagesTable,
} from "@workspace/db";
import {
  CreateConversationBody,
  SendMessageBody,
} from "@workspace/api-zod";
import { authenticate } from "../lib/auth";
import { parseUuidParam } from "../lib/validation";

const router: IRouter = Router();
router.use(authenticate);

const RAG_SERVICE_URL = process.env.RAG_SERVICE_URL || "http://127.0.0.1:8000";
const RAG_INTERNAL_SECRET = process.env.RAG_INTERNAL_SECRET || "";

router.get("/conversations", async (req, res): Promise<void> => {
  const convs = await db
    .select()
    .from(conversationsTable)
    .where(eq(conversationsTable.userId, req.user!.id))
    .orderBy(desc(conversationsTable.createdAt));
  res.json(convs);
});

router.post("/conversations", async (req, res): Promise<void> => {
  const parsed = CreateConversationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [conv] = await db
    .insert(conversationsTable)
    .values({ userId: req.user!.id, title: parsed.data.title })
    .returning();
  res.status(201).json(conv);
});

router.get("/conversations/:id", async (req, res): Promise<void> => {
  const id = parseUuidParam(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
  const [conv] = await db
    .select()
    .from(conversationsTable)
    .where(and(eq(conversationsTable.id, id), eq(conversationsTable.userId, req.user!.id)));
  if (!conv) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  const messages = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.conversationId, id))
    .orderBy(asc(messagesTable.createdAt));
  res.json({
    id: conv.id,
    title: conv.title,
    createdAt: conv.createdAt,
    messages,
  });
});

router.delete("/conversations/:id", async (req, res): Promise<void> => {
  const id = parseUuidParam(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
  await db
    .delete(conversationsTable)
    .where(and(eq(conversationsTable.id, id), eq(conversationsTable.userId, req.user!.id)));
  res.status(204).end();
});

router.post("/conversations/:id/messages", async (req, res): Promise<void> => {
  const id = parseUuidParam(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = SendMessageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [conv] = await db
    .select()
    .from(conversationsTable)
    .where(and(eq(conversationsTable.id, id), eq(conversationsTable.userId, req.user!.id)));
  if (!conv) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }

  // Persist user message
  const [userMessage] = await db
    .insert(messagesTable)
    .values({ conversationId: id, role: "user", content: parsed.data.content, citations: [] })
    .returning();

  // Pull recent history for context
  const history = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.conversationId, id))
    .orderBy(asc(messagesTable.createdAt));

  const ragHeaders: Record<string, string> = { "Content-Type": "application/json" };
  if (RAG_INTERNAL_SECRET) ragHeaders["X-Internal-Secret"] = RAG_INTERNAL_SECRET;

  const wantsStream = req.headers["accept"] === "text/event-stream";

  if (wantsStream) {
    // Stream SSE from RAG service to browser
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    // Emit the persisted user message immediately
    res.write(`data: ${JSON.stringify({ type: "user_message", userMessage })}\n\n`);

    let assistantContent = "";
    let citations: Array<{ documentId: string; documentTitle: string; pageNumber: number; snippet: string }> = [];

    try {
      const ragResp = await fetch(`${RAG_SERVICE_URL}/rag/chat`, {
        method: "POST",
        headers: ragHeaders,
        body: JSON.stringify({
          conversation_id: id,
          message: parsed.data.content,
          history: history.map((m) => ({ role: m.role, content: m.content })),
          stream: true,
        }),
        signal: AbortSignal.timeout(120_000),
      });

      if (!ragResp.ok || !ragResp.body) {
        const fallback = "The knowledge base service is currently unavailable. Please try again shortly.";
        res.write(`data: ${JSON.stringify({ type: "delta", text: fallback })}\n\n`);
        assistantContent = fallback;
      } else {
        const reader = ragResp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // Parse SSE lines from buffer
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const raw = line.slice(6).trim();
            if (!raw) continue;
            try {
              const event = JSON.parse(raw) as { type: string; text?: string; citations?: typeof citations };
              if (event.type === "delta" && event.text) {
                assistantContent += event.text;
                res.write(`data: ${JSON.stringify({ type: "delta", text: event.text })}\n\n`);
              } else if (event.type === "citations" && event.citations) {
                citations = event.citations;
              }
              // Swallow start/done events from RAG — we handle done ourselves below
            } catch {
              // skip malformed lines
            }
          }
        }
      }
    } catch (err) {
      req.log.warn({ err }, "RAG streaming call failed");
      const fallback = "The knowledge base service is not reachable yet. Once an administrator finishes setting up the system, your queries will return technical guidance with citations.";
      res.write(`data: ${JSON.stringify({ type: "delta", text: fallback })}\n\n`);
      assistantContent = fallback;
    }

    // Persist assistant message after stream completes
    const [assistantMessage] = await db
      .insert(messagesTable)
      .values({ conversationId: id, role: "assistant", content: assistantContent, citations })
      .returning();

    res.write(`data: ${JSON.stringify({ type: "done", assistantMessage })}\n\n`);
    res.end();
    return;
  }

  // Non-streaming path (kept for backwards compatibility)
  let assistantContent = "";
  let citations: Array<{ documentId: string; documentTitle: string; pageNumber: number; snippet: string }> = [];
  try {
    const ragResp = await fetch(`${RAG_SERVICE_URL}/rag/chat`, {
      method: "POST",
      headers: ragHeaders,
      body: JSON.stringify({
        conversation_id: id,
        message: parsed.data.content,
        history: history.map((m) => ({ role: m.role, content: m.content })),
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (ragResp.ok) {
      const data = await ragResp.json() as { content: string; citations?: typeof citations };
      assistantContent = data.content;
      citations = data.citations ?? [];
    } else {
      assistantContent =
        "The knowledge base service is currently unavailable. Please try again shortly.";
    }
  } catch (err) {
    req.log.warn({ err }, "RAG service call failed");
    assistantContent =
      "The knowledge base service is not reachable yet. Once an administrator finishes setting up the system, your queries will return technical guidance with citations.";
  }

  const [assistantMessage] = await db
    .insert(messagesTable)
    .values({
      conversationId: id,
      role: "assistant",
      content: assistantContent,
      citations,
    })
    .returning();

  res.json({ userMessage, assistantMessage });
});

export default router;
