"""Unit tests for artifacts/rag-service/app/config.py."""
from __future__ import annotations

import os

import pytest


class TestRequired:
    def test_returns_value_when_env_var_is_set(self):
        from app.config import _required
        os.environ["_TEST_REQUIRED_VAR"] = "hello"
        try:
            assert _required("_TEST_REQUIRED_VAR") == "hello"
        finally:
            del os.environ["_TEST_REQUIRED_VAR"]

    def test_raises_runtime_error_when_env_var_is_missing(self):
        from app.config import _required
        os.environ.pop("_TEST_MISSING_VAR_XYZ", None)
        with pytest.raises(RuntimeError, match="_TEST_MISSING_VAR_XYZ"):
            _required("_TEST_MISSING_VAR_XYZ")

    def test_raises_runtime_error_when_env_var_is_empty_string(self):
        from app.config import _required
        os.environ["_TEST_EMPTY_VAR"] = ""
        try:
            with pytest.raises(RuntimeError):
                _required("_TEST_EMPTY_VAR")
        finally:
            del os.environ["_TEST_EMPTY_VAR"]
