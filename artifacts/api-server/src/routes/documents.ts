import { Router, type IRouter } from "express";
import multer from "multer";
import path from "path";
import { eq, desc } from "drizzle-orm";
import { db, documentsTable, documentChunksTable } from "@workspace/db";
import { RegisterDocumentBody } from "@workspace/api-zod";
import { authenticate, requireAdmin } from "../lib/auth";
import { ObjectStorageService } from "../lib/objectStorage";
import { parseUuidParam } from "../lib/validation";
import { sendIngestionFailureAlert } from "../lib/email";

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100MB
const ALLOWED_EXTS = new Set([".pdf", ".docx", ".doc", ".txt", ".md", ".html", ".htm", ".pptx", ".ppt"]);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

const RAG_SERVICE_URL = process.env.RAG_SERVICE_URL || "http://127.0.0.1:8000";
const RAG_INTERNAL_SECRET = process.env.RAG_INTERNAL_SECRET || "";

function ragHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (RAG_INTERNAL_SECRET) h["X-Internal-Secret"] = RAG_INTERNAL_SECRET;
  return h;
}

async function triggerIngestion(
  documentId: string,
  filePath: string,
  fileType: string,
  filename: string,
  title: string,
  createdAt: Date,
  log: { warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void },
): Promise<void> {
  // Kicked off async by the upload/register handlers. We don't await the
  // ingestion completion (it can take a while), but we do mark the document
  // `failed` if the kick-off itself returns a non-2xx so it doesn't get stuck
  // on `pending` forever.
  const alertOnFailure = () =>
    sendIngestionFailureAlert({ id: documentId, title, filename, createdAt }).catch(() => {});

  try {
    const r = await fetch(`${RAG_SERVICE_URL}/rag/ingest`, {
      method: "POST",
      headers: ragHeaders(),
      body: JSON.stringify({
        document_id: documentId,
        file_path: filePath,
        file_type: fileType,
        filename,
      }),
      signal: AbortSignal.timeout(15 * 60_000),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      log.error({ status: r.status, body, documentId }, "RAG ingest returned non-2xx");
      await db
        .update(documentsTable)
        .set({ status: "failed" })
        .where(eq(documentsTable.id, documentId));
      void alertOnFailure();
    }
  } catch (err) {
    log.warn({ err, documentId }, "RAG ingest call failed");
    await db
      .update(documentsTable)
      .set({ status: "failed" })
      .where(eq(documentsTable.id, documentId))
      .catch(() => {});
    void alertOnFailure();
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

// Admin: multipart upload (up to 100MB). Streams the file to object storage,
// then registers the document and triggers ingestion.
router.post(
  "/admin/documents/upload",
  authenticate,
  requireAdmin,
  (req, res, next): void => {
    upload.single("file")(req, res, (err: unknown) => {
      if (err) {
        const e = err as { code?: string; message?: string };
        if (e.code === "LIMIT_FILE_SIZE") {
          res.status(413).json({ error: "File too large (max 100MB)" });
          return;
        }
        res.status(400).json({ error: e.message || "Upload error" });
        return;
      }
      next();
    });
  },
  async (req, res): Promise<void> => {
    const file = (req as unknown as { file?: Express.Multer.File }).file;
    const title = (req.body as { title?: string } | undefined)?.title?.trim();
    if (!file) {
      res.status(400).json({ error: "Missing file" });
      return;
    }
    if (!title) {
      res.status(400).json({ error: "Missing title" });
      return;
    }
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTS.has(ext)) {
      res.status(400).json({ error: `Unsupported file type: ${ext}` });
      return;
    }
    try {
      const uploadURL = await objectStorageService.getObjectEntityUploadURL();
      const putRes = await fetch(uploadURL, {
        method: "PUT",
        headers: { "Content-Type": file.mimetype || "application/octet-stream" },
        body: file.buffer,
      });
      if (!putRes.ok) {
        req.log.error({ status: putRes.status }, "GCS upload failed");
        res.status(502).json({ error: "Object storage upload failed" });
        return;
      }
      const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);
      const [doc] = await db
        .insert(documentsTable)
        .values({
          title,
          filename: file.originalname,
          filePath: objectPath,
          fileType: file.mimetype || ext.slice(1) || "application/octet-stream",
          size: file.size,
          status: "pending",
          uploadedBy: req.user!.id,
        })
        .returning();
      void triggerIngestion(doc.id, doc.filePath, doc.fileType, doc.filename, doc.title, doc.createdAt, req.log);
      res.status(201).json(doc);
    } catch (error) {
      req.log.error({ err: error }, "Document upload failed");
      res.status(500).json({ error: "Document upload failed" });
    }
  },
);

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
  void triggerIngestion(doc.id, doc.filePath, doc.fileType, doc.filename, doc.title, doc.createdAt, req.log);

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
      headers: ragHeaders(),
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
  void triggerIngestion(doc.id, doc.filePath, doc.fileType, doc.filename, doc.title, doc.createdAt, req.log);
  res.status(202).json(doc);
});

export default router;
