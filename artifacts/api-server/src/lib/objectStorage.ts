import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "stream";
import { randomUUID } from "crypto";

function getS3Bucket(): string {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) {
    throw new Error("S3_BUCKET environment variable is not set");
  }
  return bucket;
}

const s3Client = new S3Client({
  region: process.env.AWS_REGION ?? "us-east-1",
});

export interface S3ObjectRef {
  bucket: string;
  key: string;
}

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

export class ObjectStorageService {
  async getObjectEntityUploadURL(): Promise<string> {
    const bucket = getS3Bucket();
    const key = `uploads/${randomUUID()}`;
    return getSignedUrl(
      s3Client,
      new PutObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn: 900 },
    );
  }

  normalizeObjectEntityPath(rawPath: string): string {
    if (rawPath.startsWith("/objects/")) {
      return rawPath;
    }

    // Convert S3 URL formats to /objects/<key>:
    //   Virtual-hosted: https://bucket.s3[.region].amazonaws.com/key
    //   Path-style:     https://s3[.region].amazonaws.com/bucket/key
    try {
      const url = new URL(rawPath);
      if (!url.hostname.endsWith(".amazonaws.com")) {
        return rawPath;
      }

      let key: string;

      if (/\.s3(\.[a-z0-9-]+)?\.amazonaws\.com$/.test(url.hostname)) {
        key = url.pathname.replace(/^\//, "");
      } else if (/^s3(\.[a-z0-9-]+)?\.amazonaws\.com$/.test(url.hostname)) {
        const parts = url.pathname.replace(/^\//, "").split("/");
        key = parts.slice(1).join("/");
      } else {
        return rawPath;
      }

      return key ? `/objects/${key}` : rawPath;
    } catch {
      return rawPath;
    }
  }

  async getObjectEntityFile(objectPath: string): Promise<S3ObjectRef> {
    if (!objectPath.startsWith("/objects/")) {
      throw new ObjectNotFoundError();
    }

    const key = objectPath.slice("/objects/".length);
    if (!key) {
      throw new ObjectNotFoundError();
    }

    const bucket = getS3Bucket();

    try {
      await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    } catch (err: unknown) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e.name === "NotFound" || e.$metadata?.httpStatusCode === 404) {
        throw new ObjectNotFoundError();
      }
      throw err;
    }

    return { bucket, key };
  }

  async downloadObject(file: S3ObjectRef, cacheTtlSec: number = 3600): Promise<Response> {
    const resp = await s3Client.send(
      new GetObjectCommand({ Bucket: file.bucket, Key: file.key }),
    );

    const body = resp.Body;
    if (!body) {
      throw new ObjectNotFoundError();
    }

    // SDK v3 Body is a SdkStreamMixin — convert to Node Readable then to Web ReadableStream
    const readable = Readable.from(body as unknown as AsyncIterable<Uint8Array>);
    const webReadable = Readable.toWeb(readable) as ReadableStream;

    const headers: Record<string, string> = {
      "Content-Type": resp.ContentType ?? "application/octet-stream",
      "Cache-Control": `private, max-age=${cacheTtlSec}`,
    };
    if (resp.ContentLength !== undefined) {
      headers["Content-Length"] = String(resp.ContentLength);
    }

    return new Response(webReadable, { headers });
  }

  async searchPublicObject(filePath: string): Promise<S3ObjectRef | null> {
    const bucket = getS3Bucket();
    const key = `public/${filePath}`;

    try {
      await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return { bucket, key };
    } catch (err: unknown) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e.name === "NotFound" || e.$metadata?.httpStatusCode === 404) {
        return null;
      }
      throw err;
    }
  }
}
