import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { db, documentsTable, documentChunksTable } from "@workspace/db";
import { RegisterDocumentBody } from "@workspace/api-zod";
import { authenticate, requireAdmin } from "../lib/auth";
import { ObjectStorageService } from "../lib/objectStorage";
import { parseUuidParam } from "../lib/validation";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

const RAG_SERVICE_URL = process.env.RAG_SERVICE_URL || "http://127.0.0.1:8001";

async function triggerIngestion(documentId: string, filePath: string, fileType: string): Promise<void> {
  // Fire-and-forget; the RAG service will update document status when done.
  // The Python service is built in Task #2; until then this is a no-op that
  // gracefully handles connection failures.
  try {
    await fetch(`${RAG_SERVICE_URL}/rag/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ document_id: documentId, file_path: filePath, file_type: fileType }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // RAG service may not yet be running; ignore.
  }
}

// Public list (any authenticated user)
router.get("/documents", authenticate, async (_req, res): Promise<void> => {
  const docs = await db
    .select()
    .from(documentsTable)
    .orderBy(desc(documentsTable.createdAt));
  res.json(docs);
});

// Document view: redirect to the underlying file in object storage with optional page anchor
router.get("/documents/:id/view", authenticate, async (req, res): Promise<void> => {
  const id = parseUuidParam(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
  const [doc] = await db.select().from(documentsTable).where(eq(documentsTable.id, id));
  if (!doc) {
    res.status(404).json({ error: "Document not found" });
    return;
  }
  // The objectPath stored is like "/objects/uploads/..." — serve via the storage route
  const page = req.query.page;
  const anchor = page ? `#page=${encodeURIComponent(String(page))}` : "";
  res.redirect(`/api/storage${doc.filePath}${anchor}`);
});

// Admin: register an uploaded document
router.post("/admin/documents", authenticate, requireAdmin, async (req, res): Promise<void> => {
  const parsed = RegisterDocumentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { title, filename, objectPath, fileType, size } = parsed.data;
  // Normalize the object path in case the client sent the raw GCS URL
  const normalized = objectStorageService.normalizeObjectEntityPath(objectPath);

  const [doc] = await db
    .insert(documentsTable)
    .values({
      title,
      filename,
      filePath: normalized,
      fileType,
      size,
      status: "pending",
      uploadedBy: req.user!.id,
    })
    .returning();

  // Kick off ingestion (non-blocking)
  triggerIngestion(doc.id, doc.filePath, doc.fileType).catch(() => {});

  res.status(201).json(doc);
});

// Admin: delete a document and all its chunks
router.delete("/admin/documents/:id", authenticate, requireAdmin, async (req, res): Promise<void> => {
  const id = parseUuidParam(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
  // Delete chunks first (also cascade, but be explicit so RAG service can't race)
  await db.delete(documentChunksTable).where(eq(documentChunksTable.documentId, id));
  const [deleted] = await db
    .delete(documentsTable)
    .where(eq(documentsTable.id, id))
    .returning();
  if (!deleted) {
    res.status(404).json({ error: "Document not found" });
    return;
  }
  // Best-effort: also tell RAG service to drop its index
  try {
    await fetch(`${RAG_SERVICE_URL}/rag/documents/${id}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // ignore
  }
  res.status(204).end();
});

// Admin: re-trigger ingestion
router.post("/admin/documents/:id/reingest", authenticate, requireAdmin, async (req, res): Promise<void> => {
  const id = parseUuidParam(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
  const [doc] = await db
    .update(documentsTable)
    .set({ status: "pending" })
    .where(eq(documentsTable.id, id))
    .returning();
  if (!doc) {
    res.status(404).json({ error: "Document not found" });
    return;
  }
  triggerIngestion(doc.id, doc.filePath, doc.fileType).catch(() => {});
  res.status(202).json(doc);
});

export default router;
