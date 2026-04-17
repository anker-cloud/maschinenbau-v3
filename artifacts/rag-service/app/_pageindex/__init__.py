"""Vendored copy of VectifyAI/PageIndex (open-source, MIT).

We import only the building blocks we need; the upstream package's
__init__ also pulls in a hosted-API client we don't use.
"""
from .page_index import page_index_main  # noqa: F401
from .utils import ConfigLoader  # noqa: F401
