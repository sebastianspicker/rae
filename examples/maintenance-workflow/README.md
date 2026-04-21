# Maintenance Workflow Example

This example exercises the umbrella hygiene lane with a config file that targets
multiple co-author trailer identities.

## Validate the configuration

```bash
./scripts/rae.sh hygiene coauthor-cleaner \
  --config examples/maintenance-workflow/coauthor-targets.json \
  --validate-only
```

## Inspect the help surface

```bash
./scripts/rae.sh hygiene coauthor-cleaner --help
```

The config file keeps the operation local and explicit:

- `dryRun: true`
- `noPush: true`
- two removable identities in `targets[]`
