# Minimal Ralph Example

This example shows the smallest useful Ralph path from the umbrella harness.

## Package-local validation

```bash
./scripts/rae.sh ralph --validate-prd
./scripts/rae.sh ralph --status
./scripts/rae.sh ralph --list-stories
```

## Embedded bootstrap for another repository

```bash
mkdir -p /tmp/rae-demo-repo
./scripts/rae.sh workflow repo-audit bootstrap /tmp/rae-demo-repo
cp /tmp/rae-demo-repo/.claude/ralph-audit/prd.json.example /tmp/rae-demo-repo/.claude/ralph-audit/prd.json
(cd /tmp/rae-demo-repo && MODE=audit ./.claude/ralph-audit/ralph.sh --check)
```

This path demonstrates the real deployment model: Ralph is usually embedded
into a target repository and then run there under a repo-specific `prd.json`.
