# Survey screenshots — UX comparison

Two layers of imagery, captured 2026-05-17:

- **`screenshots/`** — full-page captures of each tool's canonical marketing/landing URL (Playwright Chromium, 1440×900 viewport). One file per tool. Useful for "how does the vendor pitch this," less so for actual UX.
- **`ux-images/`** — vendor-embedded product images extracted from docs / blog / examples pages, plus alternate captures targeting live editors or GitHub READMEs. Multiple files per tool; quality varies (some are real product UI, some are marketing chrome that slipped through the filter). A `_manifest.md` in that folder lists every harvested file with source URL and alt text.

The **"Best UX shot"** column below is the one image per tool that most directly shows the real product UI as of capture. Where no harvest got past marketing chrome, I fall back to the marketing landing.

## Top 10 — turnkey commercial candidates

| # | Tool | Best UX shot | What it shows |
|---|---|---|---|
| 1 | **WPS AI** | `ux-images/01-wps-ai--img07-1232x1000-4d02421f.png` | 修订模式 panel composite (Chinese UI) |
| 2 | **Sudowrite** | `ux-images/02-sudowrite--img05-1306x1015-ae3f4ffc.png` | Write / Rewrite / Describe / Brainstorm pill toolbar + Wormhole panel |
| 3 | **Wordtune** | `ux-images/03-wordtune--img02-1600x982-81d4815d.webp` | Rewrite / Casual / Formal / Shorten / Expand pill toolbar + spelling-correction popover |
| 4 | **Harvey for Word** | `ux-images/04-harvey-word--img05-688x515-00e3b362.png` | Word add-in side panel (best of the 7 harvested; img01 is a logo collage) |
| 5 | **Spellbook** | `ux-images/05-spellbook--img01-1440x1144-b32f0dc0.webp` | Suggestion card with Critical badge + Add Comment + side-by-side redline |
| 6 | **Trinka AI Word** | `screenshots/06-trinka.png` | Marketing landing — only public image is a YouTube thumbnail |
| 7 | **Type.ai** | `ux-images/07-type-ai--img01-940x523-2d866320.png` | Real editor with inline tracked changes (strike-throughs + colored replacements) and per-edit action ribbon |
| 8 | **Revise (revise.io)** | `screenshots/08-revise.png` | Marketing landing — product gated behind login; `/product` `/instant` `/how-it-works` all 404 |
| 9 | **Coda AI Reviewer** | `ux-images/09-coda-ai--img03-2466x2466-6cbd1c2b.png` | AI side panel — Summarize / Write / Make a table / Brainstorm / Give feedback prompt buttons + speed selector |
| 10 | **Plate (udecode)** | `ux-images/10-plate--alt50-fullpage.png` | The Plate Playground homepage — full rich-text editor with formatting toolbar, AI-Powered Editing, collaborative suggestions, comments |

## OSS shortlist (Agent C)

| # | Tool | Best UX shot | What it shows |
|---|---|---|---|
| oss-1 | **BlockNote AI demo** | `ux-images/oss-1-blocknote--alt1-focus.png` | The live editor canvas focused (interact at the URL to see Ask AI / accept-reject flow) |
| oss-2 | **SuperDoc** | `ux-images/oss-2-superdoc--img01-864x652-fd4a4454.png` | SuperDoc Word add-in rendered against an NDA document — sidebar + tracked changes |
| oss-3 | **Tiptap AI Suggestion** | `screenshots/oss-3-tiptap.png` | Docs page; embed preview was blank, suggesting AI Suggestion is gated. Use the homepage `oss-3-tiptap--alt50-fullpage.png` for tour content |
| oss-4 | **prosemirror-changeset** | `screenshots/oss-4-prosemirror-cs.png` | GitHub repo page — no images in README. Demo via `prosemirror.net/examples/track/` |
| oss-5 | **Word AI Redliner** | `ux-images/oss-5-word-ai-redliner--readme01.gif` | Animated demo of LLM → Word native tracked-changes flow (from README) |
| oss-6 | **Affine** | `ux-images/oss-6-affine--img04-1040x722-c536f1d6.png` | Block-editor screenshot (the others are marketing hero shots) |
| oss-7 | **Recogito text-annotator** | `ux-images/oss-7-recogito--readme01.gif` | Animated demo of in-text annotation creation (from README) |
| oss-8 | **Nougat (Meta)** | `screenshots/oss-8-nougat.png` | GitHub README page — Nougat is a parser, not an editor; no product UI exists |

## Patterns worth noting for our design

From scanning the harvested UX imagery, the patterns that appear consistently across tools that ship F1 (accept/reject) flows:

- **Per-suggestion card with a status badge** (Spellbook "Critical", Sudowrite suggestion cards, Coda anchored comments). Our `[Approve] [Reject] [Redraft] [Skip] [Surface]` row is in the same family.
- **Side panel as the AI conversation surface**, document body left alone (Harvey, SuperDoc, Coda, Plate). Our three-pane layout puts the LaTeX snippet in the middle and live PDF preview on the right — closer to a code-review UI than a doc-review UI.
- **Inline tracked-changes rendering with colored strike-throughs + insertions** (Type.ai, Word AI Redliner) for showing the proposed diff. We currently use a side-by-side Before/Proposed pair instead. Worth thinking about whether inline overlay is better when LaTeX-snippet diffs are short.
- **Toolbar pill-row above the text for global actions** (Wordtune, Sudowrite). Our top bar has phase / order / nav-counter instead — less action-oriented.
- **Comment threads bound to a specific anchor** (Coda, Spellbook). We have the per-annotation context but no thread.

## How to navigate

- Quick comparison of "what 18 tools look like at first impression": browse `screenshots/`.
- Deep look at real product UX per tool: browse `ux-images/`, ordered by tool prefix (`01-`, `02-`, … `10-`, then `oss-1-` through `oss-8-`).
- Provenance for every harvested image: `ux-images/_manifest.md`.

## Caveats

- 9 of the Top 10 are paid SaaS; the actual review UX sits behind login. What we have is what the vendor publishes externally.
- WPS AI is Chinese-first; product imagery has 修订模式 / 接受 / 拒绝 labels.
- BlockNote is the only OSS option in this set where you can experience F1 accept/reject **right now without setup** — visit <https://www.blocknotejs.org/examples/ai/minimal> and select text → Ask AI.
- The Plate Playground (`platejs.org/`) is the second-best interactive demo and is more fully-featured (suggestions + comments + AI editing all in one page).
- Harvested images filter by size (>480×280) to skip favicons/avatars but some marketing illustrations slip through — `_manifest.md` is the audit trail.
