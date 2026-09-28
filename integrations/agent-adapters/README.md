# Agent adapter generation

This directory owns portable workflow guidance for Codex, Claude, Cursor,
Gemini, and Kilo. The files are runner guidance, not executable provider
integrations for the RAE engine.

## Source and generated paths

- `content/spec/adapter-manifest.json` declares runners and generated targets.
- `content/templates/` contains the source templates.
- `content/<runner>/` contains derived guidance and must not be edited by
  hand.
- `src/generate-adapters.ts` renders or checks the declared outputs.
- `dist/generate-adapters.js` is the compiled Node.js entrypoint.

Edit the manifest or templates, then regenerate from the repository root:

```bash
npm --prefix integrations/agent-adapters run build
node integrations/agent-adapters/dist/generate-adapters.js
node integrations/agent-adapters/dist/generate-adapters.js --check
```

Limit a run with repeatable `--runner <id>`. Use `--manifest <path>` only
when validating an explicit alternate manifest.

The repository gate also validates each manifest-declared skill and checks that
derived outputs are synchronized.
