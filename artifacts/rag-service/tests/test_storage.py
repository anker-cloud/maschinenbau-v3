"""Unit tests for artifacts/rag-service/app/storage.py.

boto3 is mocked throughout so no real AWS credentials or network calls are made.
"""
from __future__ import annotations

from io import BytesIO
from unittest.mock import MagicMock, patch

import pytest


# ── Helpers ───────────────────────────────────────────────────────────────────

def _client_error(code: str) -> Exception:
    """Build a botocore ClientError with the given error code."""
    from botocore.exceptions import ClientError
    return ClientError({"Error": {"Code": code, "Message": ""}}, "GetObject")


def _make_s3_response(body: bytes) -> dict:
    return {"Body": BytesIO(body)}


# ── download_object ───────────────────────────────────────────────────────────

class TestDownloadObject:
    @patch("app.storage.boto3")
    @patch("app.storage.S3_BUCKET", "test-bucket")
    def test_returns_bytes_on_success(self, mock_boto3: MagicMock):
        mock_client = MagicMock()
        mock_boto3.client.return_value = mock_client
        mock_client.get_object.return_value = _make_s3_response(b"file content")

        from app.storage import download_object
        result = download_object("/objects/uploads/abc")

        assert result == b"file content"
        mock_client.get_object.assert_called_once_with(Bucket="test-bucket", Key="uploads/abc")

    @patch("app.storage.boto3")
    @patch("app.storage.S3_BUCKET", "test-bucket")
    def test_strips_objects_prefix_from_key(self, mock_boto3: MagicMock):
        mock_client = MagicMock()
        mock_boto3.client.return_value = mock_client
        mock_client.get_object.return_value = _make_s3_response(b"data")

        from app.storage import download_object
        download_object("/objects/uploads/uuid-goes-here")

        _, kwargs = mock_client.get_object.call_args
        assert kwargs["Key"] == "uploads/uuid-goes-here"

    @patch("app.storage.boto3")
    @patch("app.storage.S3_BUCKET", "test-bucket")
    def test_raises_file_not_found_on_no_such_key(self, mock_boto3: MagicMock):
        mock_client = MagicMock()
        mock_boto3.client.return_value = mock_client
        mock_client.get_object.side_effect = _client_error("NoSuchKey")

        from app.storage import download_object
        with pytest.raises(FileNotFoundError):
            download_object("/objects/uploads/missing")

    @patch("app.storage.boto3")
    @patch("app.storage.S3_BUCKET", "test-bucket")
    def test_raises_file_not_found_on_404_code(self, mock_boto3: MagicMock):
        mock_client = MagicMock()
        mock_boto3.client.return_value = mock_client
        mock_client.get_object.side_effect = _client_error("404")

        from app.storage import download_object
        with pytest.raises(FileNotFoundError):
            download_object("/objects/uploads/missing")

    @patch("app.storage.boto3")
    @patch("app.storage.S3_BUCKET", "test-bucket")
    def test_raises_runtime_error_on_other_client_error(self, mock_boto3: MagicMock):
        mock_client = MagicMock()
        mock_boto3.client.return_value = mock_client
        mock_client.get_object.side_effect = _client_error("AccessDenied")

        from app.storage import download_object
        with pytest.raises(RuntimeError, match="S3 download failed"):
            download_object("/objects/uploads/secret")

    def test_raises_value_error_for_path_not_starting_with_objects(self):
        from app.storage import download_object
        with pytest.raises(ValueError, match="Unexpected file_path format"):
            download_object("uploads/abc")

    def test_raises_value_error_for_bare_objects_prefix(self):
        from app.storage import download_object
        with pytest.raises(ValueError, match="empty key"):
            download_object("/objects/")

    @patch("app.storage.boto3")
    @patch("app.storage.S3_BUCKET", "")
    def test_raises_runtime_error_when_bucket_not_configured(self, mock_boto3: MagicMock):
        from app.storage import download_object
        with pytest.raises(RuntimeError, match="S3_BUCKET"):
            download_object("/objects/uploads/abc")
