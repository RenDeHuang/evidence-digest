"""Evidence Digest harvest/classify/score/build pipeline.

Stdlib-only by design (see pipeline/README.md) so it runs on a bare GitHub
Actions `ubuntu-latest` runner with no `pip install` step. `pubmed.py` is the
only module that touches the network; everything else is a pure function of
its inputs, which is what makes the classifier and scorer fully deterministic
and the test suite runnable offline.
"""

from __future__ import annotations

__all__ = ["__version__"]
__version__ = "0.1.0"
