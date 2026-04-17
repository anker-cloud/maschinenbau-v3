import { pgTable, uuid, text, timestamp, integer, jsonb, vector, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const documentsTable = pgTable("documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  filename: text("filename").notNull(),
  filePath: text("file_path").notNull(),
  fileType: text("file_type").notNull(),
  size: integer("size").notNull(),
  status: text("status", { enum: ["pending", "ingesting", "ready", "failed"] })
    .notNull()
    .default("pending"),
  // PageIndex-generated tree-of-contents structure (vectorless RAG).
  // Populated by the RAG service after a successful ingest.
  treeStructure: jsonb("tree_structure"),
  uploadedBy: uuid("uploaded_by")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Embedding dimension matches AWS Bedrock Titan Text Embeddings v2 (1024).
// The Python RAG service writes/reads this column.
export const documentChunksTable = pgTable(
  "document_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documentsTable.id, { onDelete: "cascade" }),
    pageNumber: integer("page_number").notNull(),
    chunkText: text("chunk_text").notNull(),
    embedding: vector("embedding", { dimensions: 1024 }),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    docIdIdx: index("document_chunks_document_id_idx").on(table.documentId),
  }),
);

export type Document = typeof documentsTable.$inferSelect;
export type InsertDocument = typeof documentsTable.$inferInsert;
export type DocumentChunk = typeof documentChunksTable.$inferSelect;
