# Maintenance Workflow Example

This example exercises the umbrella hygiene lane with a config file that targets
multiple co-author trailer identities.

## Validate against a local clone

```bash
REPO_URL=https://github.com/example/example-repo
REPO_PATH=/absolute/path/to/example-repo

./scripts/rae.sh hygiene coauthor-cleaner \
  --config examples/maintenance-workflow/coauthor-targets.json \
  --validate-only \
  "$REPO_URL" "$REPO_PATH"
```

## Inspect the help surface

```bash
./scripts/rae.sh hygiene coauthor-cleaner --help
```

The config file keeps the operation local and explicit:

- `dryRun: true`
- `noPush: true`
- two fictional `example.com` identities in `targets[]`
