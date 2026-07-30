# Static Evidence Dossier demo

The GitHub Pages demo is derived from the maintained operator console at build
time. It copies the canonical HTML, CSS, and JavaScript modules, then adds only
this directory's simulation notice, sanitized fixture adapter, and visible
action labels.

The demo runs no command, contacts no operator API, and stores no run state.
Every interaction changes only the in-memory fixture until the page is reloaded.
It is a product walkthrough, not evidence from an autonomous run.

Build it from the repository root with:

```bash
npm --prefix packages/orchestration run build:pages-demo
```

The generated site is written to the ignored `dist/pages-demo/` directory.
