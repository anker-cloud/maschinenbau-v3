import { Readable } from "stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoist so we can control send() return values per-test.
const mockSend = vi.hoisted(() => vi.fn());

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: mockSend })),
  GetObjectCommand: vi.fn().mockImplementation((args) => ({ _args: args })),
  HeadObjectCommand: vi.fn().mockImplementation((args) => ({ _args: args })),
  PutObjectCommand: vi.fn().mockImplementation((args) => ({ _args: args })),
}));
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn().mockResolvedValue("https://presigned.example.com/uploads/test-key?sig=abc"),
}));

import { ObjectNotFoundError, ObjectStorageService } from "./objectStorage";

const service = new ObjectStorageService();

beforeEach(() => { mockSend.mockReset(); });

// ── normalizeObjectEntityPath ─────────────────────────────────────────────────

describe("normalizeObjectEntityPath", () => {
  it("returns an /objects/ path unchanged", () => {
    expect(service.normalizeObjectEntityPath("/objects/uploads/abc")).toBe("/objects/uploads/abc");
  });

  it("converts a virtual-hosted S3 URL without region", () => {
    expect(service.normalizeObjectEntityPath("https://my-bucket.s3.amazonaws.com/uploads/abc"))
      .toBe("/objects/uploads/abc");
  });

  it("converts a virtual-hosted S3 URL with region", () => {
    expect(service.normalizeObjectEntityPath("https://my-bucket.s3.eu-central-1.amazonaws.com/uploads/abc"))
      .toBe("/objects/uploads/abc");
  });

  it("converts a path-style S3 URL without region", () => {
    expect(service.normalizeObjectEntityPath("https://s3.amazonaws.com/my-bucket/uploads/abc"))
      .toBe("/objects/uploads/abc");
  });

  it("converts a path-style S3 URL with region", () => {
    expect(service.normalizeObjectEntityPath("https://s3.eu-central-1.amazonaws.com/my-bucket/uploads/abc"))
      .toBe("/objects/uploads/abc");
  });

  it("returns non-S3 https URLs unchanged", () => {
    const url = "https://example.com/file.pdf";
    expect(service.normalizeObjectEntityPath(url)).toBe(url);
  });

  it("returns relative paths unchanged", () => {
    expect(service.normalizeObjectEntityPath("relative/path")).toBe("relative/path");
  });

  it("returns an empty string unchanged", () => {
    expect(service.normalizeObjectEntityPath("")).toBe("");
  });

  it("returns a virtual-hosted URL with empty key as the original URL", () => {
    const url = "https://my-bucket.s3.amazonaws.com/";
    expect(service.normalizeObjectEntityPath(url)).toBe(url);
  });
});

// ── getObjectEntityUploadURL ──────────────────────────────────────────────────

describe("getObjectEntityUploadURL", () => {
  it("returns a presigned URL string", async () => {
    const url = await service.getObjectEntityUploadURL();
    expect(typeof url).toBe("string");
    expect(url.length).toBeGreaterThan(0);
  });
});

// ── uploadBuffer ──────────────────────────────────────────────────────────────

describe("uploadBuffer", () => {
  it("returns a /objects/uploads/<uuid> path on success", async () => {
    mockSend.mockResolvedValue({});
    const path = await service.uploadBuffer(Buffer.from("data"), "text/plain");
    expect(path).toMatch(/^\/objects\/uploads\//);
  });

  it("propagates S3 errors", async () => {
    mockSend.mockRejectedValue(new Error("S3 error"));
    await expect(service.uploadBuffer(Buffer.from("x"), "text/plain")).rejects.toThrow("S3 error");
  });
});

// ── getObjectEntityFile ───────────────────────────────────────────────────────

describe("getObjectEntityFile", () => {
  it("returns an S3ObjectRef for a valid /objects/ path", async () => {
    mockSend.mockResolvedValue({});
    const ref = await service.getObjectEntityFile("/objects/uploads/some-key");
    expect(ref.bucket).toBe("test-bucket");
    expect(ref.key).toBe("uploads/some-key");
  });

  it("throws ObjectNotFoundError for a path not starting with /objects/", async () => {
    await expect(service.getObjectEntityFile("uploads/key"))
      .rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it("throws ObjectNotFoundError for /objects/ with no key", async () => {
    await expect(service.getObjectEntityFile("/objects/"))
      .rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it("throws ObjectNotFoundError when S3 returns 404", async () => {
    mockSend.mockRejectedValue({ name: "NotFound", $metadata: { httpStatusCode: 404 } });
    await expect(service.getObjectEntityFile("/objects/uploads/missing"))
      .rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it("throws ObjectNotFoundError when S3 returns httpStatusCode 404", async () => {
    mockSend.mockRejectedValue({ $metadata: { httpStatusCode: 404 } });
    await expect(service.getObjectEntityFile("/objects/uploads/missing"))
      .rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it("re-throws non-404 S3 errors", async () => {
    const err = new Error("Access denied");
    mockSend.mockRejectedValue(err);
    await expect(service.getObjectEntityFile("/objects/uploads/secret"))
      .rejects.toBe(err);
  });
});

// ── downloadObject ────────────────────────────────────────────────────────────

describe("downloadObject", () => {
  function makeBody(content: string) {
    const readable = Readable.from([Buffer.from(content)]);
    return readable as unknown as AsyncIterable<Uint8Array>;
  }

  it("returns a Response with correct Content-Type and Cache-Control", async () => {
    mockSend.mockResolvedValue({
      Body: makeBody("hello"),
      ContentType: "application/pdf",
      ContentLength: 5,
    });
    const response = await service.downloadObject({ bucket: "test-bucket", key: "uploads/key" });
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Cache-Control")).toContain("max-age=3600");
    expect(response.headers.get("Content-Length")).toBe("5");
  });

  it("uses application/octet-stream when ContentType is absent", async () => {
    mockSend.mockResolvedValue({ Body: makeBody("data") });
    const response = await service.downloadObject({ bucket: "test-bucket", key: "uploads/key" });
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
  });

  it("omits Content-Length when ContentLength is absent", async () => {
    mockSend.mockResolvedValue({ Body: makeBody("data"), ContentType: "text/plain" });
    const response = await service.downloadObject({ bucket: "test-bucket", key: "uploads/key" });
    expect(response.headers.get("Content-Length")).toBeNull();
  });

  it("respects a custom cacheTtlSec", async () => {
    mockSend.mockResolvedValue({ Body: makeBody("x"), ContentType: "text/plain" });
    const response = await service.downloadObject({ bucket: "b", key: "k" }, 7200);
    expect(response.headers.get("Cache-Control")).toContain("max-age=7200");
  });

  it("throws ObjectNotFoundError when Body is absent", async () => {
    mockSend.mockResolvedValue({ Body: null });
    await expect(service.downloadObject({ bucket: "test-bucket", key: "uploads/key" }))
      .rejects.toBeInstanceOf(ObjectNotFoundError);
  });
});

// ── searchPublicObject ────────────────────────────────────────────────────────

describe("searchPublicObject", () => {
  it("returns an S3ObjectRef when the object exists", async () => {
    mockSend.mockResolvedValue({});
    const ref = await service.searchPublicObject("logos/logo.png");
    expect(ref).not.toBeNull();
    expect(ref!.key).toBe("public/logos/logo.png");
    expect(ref!.bucket).toBe("test-bucket");
  });

  it("returns null when the object does not exist (NotFound)", async () => {
    mockSend.mockRejectedValue({ name: "NotFound" });
    const ref = await service.searchPublicObject("missing.pdf");
    expect(ref).toBeNull();
  });

  it("returns null when S3 returns httpStatusCode 404", async () => {
    mockSend.mockRejectedValue({ $metadata: { httpStatusCode: 404 } });
    const ref = await service.searchPublicObject("missing.pdf");
    expect(ref).toBeNull();
  });

  it("re-throws non-404 S3 errors", async () => {
    const err = new Error("Network error");
    mockSend.mockRejectedValue(err);
    await expect(service.searchPublicObject("file.pdf")).rejects.toBe(err);
  });
});
