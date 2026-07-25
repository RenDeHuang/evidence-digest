"""Makes `python -m unittest discover -s pipeline/tests` work when invoked
from the repository root (unittest's discovery does not always add
`pipeline/` to sys.path on its own, since `pipeline/` itself has no
`__init__.py`). Running from inside `pipeline/` does not need this, but it is
harmless either way."""

from __future__ import annotations

import sys
from pathlib import Path

_PIPELINE_DIR = str(Path(__file__).resolve().parent.parent)
if _PIPELINE_DIR not in sys.path:
    sys.path.insert(0, _PIPELINE_DIR)
