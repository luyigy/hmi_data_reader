"""HTTP view of the same code-owned capability catalog used by the CLI."""
from fastapi import APIRouter
from scripts.extractor_registry import capabilities

router = APIRouter()
router.add_api_route("/api/v1/capabilities", capabilities, methods=["GET"])
