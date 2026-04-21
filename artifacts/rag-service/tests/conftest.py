"""Configure sys.path and environment so rag-service app modules are importable."""
from __future__ import annotations

import os
import sys

# Make `app.*` importable without installing the package.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Minimal env vars so config.py doesn't raise at import time.
os.environ.setdefault("S3_BUCKET", "test-bucket")
os.environ.setdefault("DATABASE_URL", "postgresql://test:test@localhost/test")
os.environ.setdefault("AWS_REGION", "us-east-1")
