# RAE contracts

This package owns RAE's immutable, versioned JSON Schemas. Existing schema
files are compatibility protocols: change semantics by adding a new schema
version, not by silently repurposing a published version.

The engine resolves these files through its contract catalog. Applications
must not duplicate or patch them.

## TypeScript contracts

The package root exports generated structural types, canonical schema digests
and `parseContract(schemaName, value)`. External values remain `unknown` until
`parseContract` validates them with the corresponding authoritative schema.
Numeric bounds, patterns and other runtime constraints are enforced by the
schema validator even when TypeScript cannot represent them structurally.

Build the compiled runtime and check generated types from the repository root:

```text
npm --workspace @rae/contracts run build
npm --workspace @rae/contracts run build:generator
npm --workspace @rae/contracts run check:generated
```

After adding a schema version, regenerate with `npm --workspace @rae/contracts
run generate:types`. Existing schema paths and identifiers remain unchanged.
Generation and freshness checks use the repository's pinned Biome formatter,
so install the root workspace before running either command. Generated files
must be reproduced through the generator.
