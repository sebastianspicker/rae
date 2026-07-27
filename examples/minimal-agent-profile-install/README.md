# Minimal Agent Profile Install

This example shows the smallest public profile installation path.

## Commands

```bash
TARGET_DIR="$(mktemp -d)"
mkdir -p "$TARGET_DIR/scripts"
printf '#!/usr/bin/env bash\nexit 0\n' > "$TARGET_DIR/scripts/verify.sh"
chmod +x "$TARGET_DIR/scripts/verify.sh"
bash profiles/agent-environments/installers/install-profile.sh "$TARGET_DIR"
find "$TARGET_DIR" -type f | sort
```

Expected files:

- `.codex/config.toml`
- `.claude/settings.json`
- `docs/agent-operator-policy.md`

To remove the installed payload:

```bash
bash profiles/agent-environments/installers/uninstall-profile.sh "$TARGET_DIR"
```
