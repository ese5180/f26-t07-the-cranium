# CRANIUM Mix native engine

This is the full persistent C++ source inside the CRANIUM Mix monorepo.
Edit and commit it directly in this repository. Do not reset it, run the legacy
prepare-engine.py, or export an engine patch; all native changes are already
included as source. Keep licenses and attribution.

Never use near or far as shared C++ identifiers: Windows headers define those
macros. Use descriptive names. Run the sibling overlay Windows identifier
contract before any Windows build. Use the root tools/test.sh for host checks.
