"""Download document bytes from AWS S3.

`file_path` is the normalized path stored in the documents table, e.g.
`/objects/uploads/<uuid>`. We strip the `/objects/` prefix to get the S3
object key, then download directly using boto3.
"""
from __future__ import annotations

import logging

import boto3
from botocore.exceptions import ClientError

from .config import AWS_REGION, S3_BUCKET

log = logging.getLogger("rag.storage")


def download_object(file_path: str) -> bytes:
    """Download the object at `file_path` from S3 and return its bytes.

    `file_path` must start with `/objects/`; the remainder is the S3 key.
    """
    if not file_path.startswith("/objects/"):
        raise ValueError(f"Unexpected file_path format (expected /objects/<key>): {file_path}")

    key = file_path.removeprefix("/objects/")
    if not key:
        raise ValueError(f"file_path has empty key: {file_path}")

    if not S3_BUCKET:
        raise RuntimeError("S3_BUCKET environment variable is not set")

    s3 = boto3.client("s3", region_name=AWS_REGION)
    try:
        obj = s3.get_object(Bucket=S3_BUCKET, Key=key)
        return obj["Body"].read()
    except ClientError as exc:
        error_code = exc.response["Error"]["Code"]
        if error_code in ("NoSuchKey", "404"):
            raise FileNotFoundError(
                f"Object not found in S3: bucket={S3_BUCKET} key={key}"
            ) from exc
        raise RuntimeError(
            f"S3 download failed: bucket={S3_BUCKET} key={key} error={error_code}"
        ) from exc
