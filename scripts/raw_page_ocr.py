"""Record the OCR engine identity without page-specific recovery."""
from importlib.metadata import version

def engine_identity(engine):
    gpu = getattr(getattr(engine, "text_recognizer", None), "use_gpu", None)
    return {"library": "paddleocr", "version": version("paddleocr"),
            "device": "unknown" if gpu is None else "gpu" if gpu else "cpu",
            "class": type(engine).__name__}
