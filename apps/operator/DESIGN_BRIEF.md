# Operator console design brief

This brief records the evidence, reasoning and decisions behind the operator
console redesign on branch `design/operator-redesign`. It covers the loopback
operator (`apps/operator/static/`) and its static Pages demo, which shares the
same UI. The VitePress documentation site and the experimental platform are
out of scope. They are listed under next steps.

## 1. Product

RAE runs autonomous, agent-driven changes against a Git repository inside an
isolated worktree. It records schema-validated evidence at every phase and
stops at human checkpoints before it mutates code or releases. The operator is
a bearer-authenticated console bound to `127.0.0.1`. It lets the person who
owns the repository:

- see the runs for an allowlisted repository (catalogue, search, state filter,
  paging)
- start a bounded run: task and acceptance criteria, checkpoint policy,
  execution profile
- inspect a run: its phases, gates, projected artifacts, resources and a live
  NDJSON event stream
- **decide at a checkpoint**: approve, reject or escalate, with a required
  rationale that is saved with the actor
- resume, stop at a boundary, interrupt or clean up, where interrupt and
  cleanup require typing the run ID
- after completion, receive a hand-off: branch, report reference and a
  reminder to review the diff locally
- author workflows as revisions (Loop, Graph, Analyze and JSON views, an
  inspector, diff), validate them, and activate an exact digest

**Moment of value.** A checkpoint decision: the operator reads what the
machine recorded and then puts their own judgement on record. Every other
screen either leads to that moment (catalogue, run header) or follows it
(resume, hand-off). The console deliberately cannot commit, push, publish or
deploy, and it says so.

## 2. Audience

**Primary: the repository owner running agents on their own code.** This is a
senior or staff engineer, often a maintainer or security-minded individual
contributor, who already uses Codex or OpenCode. They work in a terminal, an
editor and Git all day. They are running the console on their own machine
beside those tools.

- *Goals:* let agents do bounded work without giving up control, and know
  exactly what happened and on whose authority.
- *Anxieties:* an agent quietly overreaching, confident model self-reports
  standing in for proof, irreversible actions a single click away, and losing
  track of which run is which.
- *What they distrust:* marketing gloss, progress bars that estimate, "AI
  magic" iconography, green checkmarks that mean "the model said so", and
  dashboards that hide the raw reference.
- *What signals quality to them:* exact identifiers they can copy, honest
  labels ("recorded evidence is not a pass verdict"), keyboard operation,
  typographic precision in tables, fast loading, no layout jank, and a
  visible distinction between what the machine did and what a human
  decided.

**Secondary:** a reviewer or maintainer browsing the Pages demo to judge
whether RAE is trustworthy. They need to see the same seriousness in the
first ten seconds.

## 3. Key journeys

1. **Decide at a checkpoint** (primary): open the URL → the latest run is
   selected → read the task and evidence → write a rationale → approve,
   reject or escalate → resume when enabled.
2. **Start a run:** New run → write the task and acceptance criteria → choose
   the checkpoint policy and profile → start → land on the new run.
3. **Review a completed run:** select it → read the result → follow the
   hand-off (copy branch and report reference) → review the diff in their own
   tools.
4. **Find a run:** All runs, or ⌘K → search and filter → select.
5. **Intervene:** Run details → stop, or interrupt / clean up behind
   typed-ID confirmation.
6. **Author a workflow:** Workflow editor → edit the graph and inspector →
   analyze → save a draft → validate → type the digest → activate.

## 4. Brand character

| Trait | Not |
| --- | --- |
| **Exact**: every value is the recorded value, with its reference | pedantic or cluttered |
| **Accountable**: human decisions are visibly authored and attributed | bureaucratic or stern |
| **Calm under load**: live runs never jitter or shout | sleepy or low-contrast |
| **Plain-spoken**: states what the console cannot do | apologetic or legalistic |
| **Engineered**: terminal heritage, keyboard-first | retro cosplay or hacker kitsch |

## 5. Market observations

Category references: agent and CI consoles (GitHub Actions run pages,
Buildkite, CircleCI), agent IDE panels (Cursor, Codex, Devin-style task
views), and workflow graph tools (Temporal UI, Dagster, n8n).

- *Conventions to honour:* a left-to-right phase or step sequence;
  status-colour semantics (green passed, amber waiting, red failed); a
  monospace log with timestamps; copyable IDs; `⌘K` search; a dark theme
  option.
- *Conventions to break:*
  - agent tools lean on purple gradients, sparkles and chat bubbles that
    anthropomorphise the model;
  - CI dashboards bury the human decision under logs;
  - graph tools use rounded pastel node cards and soft shadows;
  - everyone uses one sans family for everything.

  RAE's thesis is the separation of *machine record* from *human judgement*,
  and none of these tools show that separation visually.

## 6. Current state

- **Stack:** vanilla TypeScript modules compiled with `tsc`. No framework or
  bundler, and no UI dependencies. CSS is split into eleven `@import`ed
  modules, with `terminal.css` layered last to override much of the
  preceding "forensic ledger" system. The two systems conflict: dead tokens,
  duplicated rules, `!important`, and roughly 3,000 lines for one page.
- **Brand assets:** `docs/assets/brand/` holds the official mark, a stepped
  calibration trace that crosses two checkpoint squares and ends in a filled
  "verified evidence" square. Its colours are ink `#14232B`, trace blue
  `#1F5EFF`/`#7DA2FF`, hold rust `#A94725`/`#F0926B` and proof green
  `#08735F`/`#54C9AB`. The README and docs site use it. The operator does
  not: it shows a pixel "space invader" and phosphor green.
- **Worth keeping:**
  - the official mark and its three semantic colours (tokens already named
    `trace`, `hold` and `proof`)
  - monospace as the console's native voice
  - the task-first layout (evidence beside decision)
  - bracket-free honesty copy ("Recorded evidence is not a pass verdict")
  - the list/selected two-mode model
  - the appendix-style disclosure of run details and the editor
- **Weaknesses:**
  - The terminal skin reads as generic "hacker green". It is off-brand
    against the official mark, and it imitates a CRT rather than expressing
    RAE.
  - Every text is the same monospace at similar sizes, so hierarchy relies
    on size alone and the human task looks like a log line.
  - The four-step journey is a generic breadcrumb.
  - Run IDs are truncated to 8 characters, so `run-demo-active`,
    `run-demo-hold` and `run-demo-complete` all read `run-demo`.
  - The project switcher disappears on mobile and the sticky header overlaps
    the demo banner in list view. The evidence "State" column breaks words
    mid-token at 390 px, and the workflow graph shrinks to unreadable 5 px
    text on mobile.
  - The workflow editor is an unstyled form stack.
  - Decision buttons carry a ✓ glyph; the approve hover is inconsistent.

## 7. Constraints

- **Functionality:** keep every element ID in `state.ts` `elements`, every
  `data-*` hook (`data-decision`, `data-run-id`, `data-copy-reference`,
  `data-all-runs`, `data-new-run`, `data-workflow-id`), ARIA roles
  (`listbox`/`option`, `tablist`/`tab`), and `body[data-run-view]` modes.
  Also keep the workflow SVG classes (`workflow-node--<kind>`,
  `workflow-edge--<type>`) and the capture script's Graph check.
- **Security:**
  - The server's CSP is `default-src 'none'` and permits nothing external.
  - Loopback only; no CDN, analytics or external fonts.
  - Any font must be self-hosted and served same-origin.
- **Demo:** `build-demo.ts` rewrites `/styles.css`, `/favicon.svg` and
  `/app.js` to relative paths. All other asset URLs must therefore be
  relative to the stylesheet so they work under a Pages subpath.
- **Tests and gates:** `test:operator`, the docs screenshot `--check` (Graph
  view connected, no browser errors, no page overflow at 1440 and 390),
  typecheck, lint, architecture and hygiene checks.
- **Accessibility:** WCAG 2.2 AA contrast in both themes, visible focus,
  keyboard operation throughout, and `prefers-reduced-motion`.
- **i18n:** English only; timestamps use the browser locale (keep).

## 8. Assumptions log

| # | Assumption | Evidence | Confidence |
| --- | --- | --- | --- |
| A1 | The primary user is a senior engineer operating agents on their own repository, not a manager watching dashboards | loopback-only, bearer token in fragment, typed-ID confirmations, vocabulary (worktree, digest, gate, quorum), Codex/OpenCode dependency | high |
| A2 | The official stepped-trace mark is the brand, and the pixel invader is a local placeholder that may be replaced | the mark is in `docs/assets/brand`, README lockup, social preview and docs theme; the invader appears only in the operator and favicon | medium. `styles.css` calls the terminal look "approved", so the redesign keeps monospace as the native voice and a dark default to honour that approval |
| A3 | Self-hosting two OFL fonts (~100 KB) and allowing `font-src 'self'` is acceptable | CSP is same-origin already for scripts and styles; loopback transfer cost is negligible; OFL permits bundling | medium. If rejected, the stacks fall back to `ui-serif`/`ui-monospace` (New York / SF Mono, Georgia / Menlo) and the concept still holds, because it depends on the *serif versus mono* contrast rather than on the specific families |
| A4 | Operators run the console on a desktop or laptop beside an editor; mobile is used for a quick check-in or decision on the go | tool nature; the README ships a mobile capture, so mobile matters | medium. Mobile is designed as "read and decide" first |
| A5 | Dark remains the expected default, but the system preference should be honoured when no choice is stored | README says "initial theme is dark"; developer audience; terminal heritage | medium. Default is dark only when the OS gives no preference |
| A6 | Showing full run IDs (ellipsised by CSS) is a presentation fix, not a contract change | `shortId` is presentational; collisions are visible in the demo fixtures | high |
| A7 | The docs screenshot captures are expected to change with a UI redesign | they are "regenerated from the current operator UI" per README | high |

## 9. Design direction

Three directions were developed. Each starts from RAE's own material: the
calibration-trace mark, the `.pipeline/` evidence record, checkpoints, and
the split between machine record and human judgement.

### Direction A: "Instrument Record" (chosen)

**Concept.** The console is a signed instrument record. Two voices share
every screen, and typography keeps them apart:

- **Machine record:** refs, gates, events, IDs and states, set in IBM Plex
  Mono, the console's native terminal voice.
- **Human word:** the task as written, rationale and saved decisions, set in
  Newsreader, a text serif.

The run's journey is drawn as the brand's own **stepped calibration trace**:
a line that steps down through checkpoint squares and ends in the filled
proof square. It fits the audience because it makes RAE's core promise
visible: you can always tell what the model recorded from what a person
decided.

- **Typography:**
  - Newsreader 400/500 and italic 400 for human-authored text. The task is
    the page's headline at 28–44 px, in a regular weight with tight leading.
  - IBM Plex Mono 400/500/600 for everything recorded and for interface
    chrome.
  - The scale is a 1.2 ratio from 13 px: 11 · 12 · 13 · 15 · 18 · 22 · 28 ·
    36 · 44.
  - The mono is small, with wide tracking for uppercase labels; the serif is
    large and quiet.
- **Colour:** a cool paper and ink ground taken from the mark (`#14232B`
  ink). Every hue has one role:
  - **trace blue**: interaction, focus and the path
  - **hold rust**: waiting on a human
  - **proof green**: recorded pass
  - **fault red**: failure or destructive action

  Nothing else is coloured. No gradients.
- **Layout:**
  - A 12-column content grid, max 88 rem, with a 4 px base unit.
  - On desktop the selected run is a two-column record: evidence 7/12 on
    the left, the decision 5/12 on the right, sticky.
  - The catalogue is a dense ledger list, not cards.
  - Appendices (run details, workflow editor) are full-width, lettered
    sections below a hairline.
  - Density is compact in tables and generous around the task and the
    decision.
- **Motion:** colour and border transitions of 120 ms on hover and focus;
  the connection dot breathes only while connecting; the dialog fades in
  over 160 ms. Nothing moves on scroll. All motion is removed under
  `prefers-reduced-motion`.
- **Signature details:**
  1. The *stepped trace*: the journey list is drawn as the mark's
     staircase, with hollow squares for pending steps, a rust square when a
     human is required, and a filled green square when recorded. It is
     built in pure CSS from the existing `<ol>`.
  2. *Signed entries*: the rationale field and saved decisions are set in
     the serif behind a margin rule, like a signature line. "Your decision"
     reads as authorship, not form-filling.
- **Against the category:** no cards-in-cards, no pastel node chips, and no
  anthropomorphic AI. The human is typographically distinct from the
  machine, and colour is semantic only.
- **Refuses:** gradients, glow, shadows except on dialogs, icons for
  decoration, progress estimates, rounded corners above 2 px, and emoji or
  sparkle.

### Direction B: "Phosphor Terminal, refined"

- **Concept:** keep the approved CRT terminal and perfect it. Use Departure
  Mono (a pixel-cut OFL mono) for display and JetBrains Mono for text, keep
  bracket labels and the pixel invader, use phosphor green on near-black,
  and give every region an ASCII box frame.
- **Signature:** an ASCII-drawn phase line (`──■──□──`) and a blinking
  cursor after the task.
- **Assessment:** it honours the earlier approval and costs little, but it
  is the category cliché ("neon on dark", hacker kitsch). It conflicts with
  the official mark, and a single monospace voice cannot separate the human
  from the machine. It fails the "Specificity" and "Clean" bars.

### Direction C: "Chain of Custody docket"

- **Concept:** a legal evidence docket. Warm cream paper, a Didone serif for
  headings, a typewriter mono for exhibits, exhibit numbers
  (`EXH-03 plan.md`), rubber-stamp decision marks ("APPROVED", rotated
  2°), and a light-only theme.
- **Signature:** the stamped decision and exhibit tags.
- **Assessment:** it is memorable and on-message for accountability.
  However, the stamps are theatrical for engineers who distrust
  ornamentation, a light-only theme ignores a terminal-dwelling audience,
  and it borrows a domain (law) that RAE does not live in.

### Choice

**Direction A.** It grows directly out of RAE's own mark and its thesis
(machine record against human judgement). It keeps the monospace voice and
dark default the earlier "approved terminal" direction valued, while
dropping its off-brand CRT surface. It also yields a genuinely ownable
signature: the stepped trace, drawn from real run state.

What we trade away:

- Direction B's zero-migration familiarity: existing screenshots and the
  pixel motif are retired.
- Direction C's warmth and the theatrical, memorable stamp.
- A little bundle weight: ~100 KB of self-hosted fonts, which falls back
  gracefully (A3).
