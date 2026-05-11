# Tool definitions

This directory contains tool-definition artifacts consumed by an agent runner.

## Current artifact
- `tools.json`

## Schema reference resolution
`tools.json` uses JSON Schema `$ref` pointers to runtime skill input schemas.

Important:
- `$ref` paths are relative to the location of `tools.json` (this directory).
- In this repo, runtime skill schemas live under `skills/**/schemas/`.

## How to verify locally
From the repo root, verify that every `$ref` points at an existing file:
```bash
python3 - <<'PY'
import json, pathlib
base = pathlib.Path("agent-config/tool-definitions").resolve()
data = json.loads((base / "tools.json").read_text(encoding="utf-8"))
missing = []
for t in data:
  ref = (t.get("parameters") or {}).get("$ref")
  if not ref:
    continue
  p = (base / ref).resolve()
  if not p.exists():
    missing.append((t.get("name"), ref))
if missing:
  raise SystemExit("Missing $ref targets: " + ", ".join([f"{n} -> {r}" for n,r in missing]))
print("OK: all $ref targets exist.")
PY
```

## Notes
- This file is maintained directly. If you add new runtime skills or rename schema locations,
  update this file and re-run the verification snippet above.
