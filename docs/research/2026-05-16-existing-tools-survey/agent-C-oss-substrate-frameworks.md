# Search agent C: OSS substrate frameworks (Plate, BlockNote, Tiptap, ...)

_Recovered from Claude episodic memory — subagent transcript adbda0d6f517 of session `3013a85f` (2026-05-16, PDT)._

_Source: `~/.claude-accounts/anthony/.claude/projects/-Users-anthonybyrnes-PycharmProjects-Python419/3013a85f-a1d7-4f79-97da-e895a9941906/subagents/agent-adbda0d6f517ac6d9.jsonl`_

---

Now I'll compile the final report.

## Agent C — Findings

### Top 5 (verified)

| name | url | demo_url | type | FMT | ANCHOR | EDIT_UX | CROSS_FMT | last_active | license_or_pricing | region | gaps_vs_vision | relevance |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Plate (udecode) | https://github.com/udecode/plate | https://platejs.org/docs/ai | substrate | HTML/MD (Slate model); no native DOCX/PDF | ProseMirror-style ranges via Slate; suggestion + comment nodes map AI feedback back to doc ranges | inline-suggestion + discussion threads (verified: `suggestionPlugin`, `discussionPlugin`, `applyAISuggestions`, accept/reject components in repo) | no | 2026-05-14 | MIT-style (Plate is OSS; Plate Plus paid template) | US | No DOCX/PDF ingest; assemble Mammoth/Nougat front-end; no agent loop | 5 |
| Tiptap + AI Suggestion (deprecated) / AI Toolkit | https://github.com/ueberdosis/tiptap | https://tiptap.dev/docs/content-ai/capabilities/suggestion/overview | substrate (core MIT) + plugin (paid) | HTML; DOCX via paid `tiptap-docx`/conversion | ProseMirror positions; suggestion extension renders accept/reject | inline accept/reject (verified in Tiptap docs; AI Suggestion is Pro Cloud, marked Deprecated → AI Toolkit) | partial (paid conversion) | 2026-05-16 | MIT core; AI Suggestion/Track Changes Pro = paid Tiptap Cloud subscription | EU (Berlin) | AI features paywalled; F1/F2 agent loop not provided; deprecation churn | 5 |
| SuperDoc | https://github.com/superdoc-dev/superdoc | https://github.com/superdoc-dev/demos | substrate | DOCX-native (OOXML) + can render PDF via export | Real OOXML tracked-changes IDs, native comments | inline tracked-changes + comments (verified in README: "Tracked changes — built-in UI", "AI redlining — demonstrated through examples"); demos repo lists DocRAG/eSign/Template Builder (AI redline tagline but no dedicated demo dir) | DOCX-first | 2026-05-16 | AGPL-3.0 + commercial dual-license | US | AGPL viral for closed-source distribution; agent loop and PDF/HTML ingest not turnkey; demo of AI redline UX is README-claim, not in demos repo (cap at `unverified` for F1/F2 UX until you build it) | 4 |
| BlockNote (+ blocknote-comments) | https://github.com/TypeCellOS/BlockNote | https://www.blocknotejs.org/examples/ai/minimal | substrate | HTML/JSON blocks; DOCX/PDF only via export | ProseMirror under the hood | "Interactive AI Suggestions … accept or reject … with a single click" (verified in docs); comments plugin separate (defensestation/blocknote-comments, Apache-2.0) | no | 2026-05-15 | core MPL-2.0-style; comments plugin Apache-2.0 | EU | No DOCX import fidelity; comments are 3rd-party fork; agent loop missing | 4 |
| ProseMirror + prosemirror-changeset | https://github.com/ProseMirror/prosemirror-changeset | https://github.com/TeemuKoivisto/prosemirror-track-changes-example | substrate | HTML/JSON schema | Position-mapped via PM transactions; changeset turns ops into ins/del pairs for "change-tracking interface" | track-changes primitives only — you build accept/reject UI (verified: README explicitly mentions change-tracking interfaces, with metadata for user/timestamp) | no | **archived 2026-04** (moved to code.haverbeke.berlin) | MIT | DIY everything: no UI, no comments, no agent, no DOCX/PDF | 4 |

### Honorable Mentions (5)

| name | url | demo_url | type | FMT | ANCHOR | EDIT_UX | CROSS_FMT | last_active | license_or_pricing | region | gaps_vs_vision | relevance |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| CKEditor 5 Track Changes + AI Assistant | https://ckeditor.com/docs/ckeditor5/latest/features/collaboration/track-changes/track-changes.html | docs only | plugin on closed substrate | HTML; DOCX via paid converter | DOM range anchors; suggestion sidebar | `acceptSuggestion`/`discardSuggestion` commands (verified in CKEditor docs) — manual user UX, no AI auto-redline ship; AI Assistant is separate premium | partial (paid) | 2026 active | Premium/Commercial only | EU (Poland) | Premium paywall; AI + Track Changes not integrated by default; closed source | 3 |
| Word AI Redliner (yuch85) | https://github.com/yuch85/word-ai-redliner | https://www.youtube.com/watch?v=SusffH8eT-Y | turnkey-ish (Word add-in) | DOCX only (in-Word) | Word's native tracked changes via office-word-diff | LLM produces tracked-change redlines inside Word; user uses Word's native accept/reject; prompt management UI (verified via README + YouTube demo link) | DOCX-only | 2026-04-29 | MIT | individual | Tied to MS Word desktop; not a web editor; no HTML/PDF; only 27 stars | 3 |
| Affine | https://github.com/toeverything/AFFiNE | https://affine.pro | substrate (full app) | block-based; markdown export; **no verified DOCX/PDF import** | block-id anchors | "AI partner" mentioned in README; no verified inline accept/reject suggestion or comment-thread evidence for ingested manuscripts → **rag-chat, unverified for suggestion UX** | no | 2026-05-16 | MIT (Community); Cloud paid | China-origin / global | Note: Tencent/WPS-adjacent in posture; if routing → Agent D might also touch. Not a manuscript ingest tool; mostly knowledge-base | 2 |
| Recogito Text Annotator (successor) | https://github.com/recogito/text-annotator | https://recogito.github.io | substrate | HTML, plain text, + separate `pdf-annotator` package; TEI/XML | character-offset + Web Annotation model | annotation/comment UX only — **no AI suggestion, no accept/reject edits**; rag-chat unverified for editing | partial | 2026-04-30 | BSD-3-Clause | EU (Austria/Vienna) | Pure annotation; you build the agent + edit application yourself; original Recogito-js archived 2025-09 | 2 |
| Nougat (facebookresearch) | https://github.com/facebookresearch/nougat | https://huggingface.co/facebook/nougat-base | substrate (extractor, not editor) | PDF → Markdown/LaTeX | none (it's an OCR model) | N/A — purely document parsing | N/A | 2025-02-21 (slow) | MIT | US | Useful only as PDF-ingest stage of pipeline; no editor or agent; 10k stars but development largely paused | 2 |

### Checklist Status

- **ProseMirror** — checked. Core has no suggestion mode; `prosemirror-changeset` provides primitives but **archived 2026-04**. Substrate, DIY.
- **Tiptap (incl. AI Suggestions)** — checked. MIT core; AI Suggestion is Pro/Cloud (**marked Deprecated** in favor of new "AI Toolkit"); accept/reject UI verified in docs but paywalled.
- **CKEditor (incl. Track Changes + AI Assistant)** — checked. Both are **Premium-only** (commercial). Track Changes `acceptSuggestion`/`discardSuggestion` verified; AI integration is a separate paid module, not bundled.
- **BlockNote** — checked. AI Suggestions with accept/reject verified in docs; comments via 3rd-party `defensestation/blocknote-comments` (Apache-2.0).
- **Plate** — checked. Strongest OSS substrate match: verified `suggestionPlugin` + `discussionPlugin` + `applyAISuggestions` in docs/repo.
- **Affine** — checked. README mentions "multimodal AI partner" but **no verified evidence of inline suggestion accept/reject on imported docs** → `rag-chat unverified` per Step 4 cap.
- **Hypothes.is** — checked. Annotation-only on web/PDF; no AI suggestion/edit UX; BSD-2-Clause; would only serve as annotation substrate.
- **PSPDFKit / Nutrient** — checked. **Commercial only**, not OSS. AI Assistant for Q&A, no editing-suggestion accept/reject documented.
- **Recogito** — checked. Original `recogito-js` **archived 2025-09**; successor `@recogito/text-annotator` active (2026-04-30) but annotation-only, no AI editing.
- **Nougat** — checked. PDF→Markdown OCR model; not an editor. Useful as ingest stage only; near-dormant since 2025-02.

### Assembly Cost Notes

- **Plate (Top 1):** Closest to a turnkey-style F1. Already ships suggestion + discussion nodes and `applyAISuggestions`. To reach F1/F2 you still need (a) DOCX import (Mammoth.js → HTML → Slate), (b) PDF import (Nougat or marker-pdf → markdown → Slate), (c) an agent loop driving suggestion creation per-edit with user state machine, (d) variant-storage layer for F2 (fork suggestion sets). Estimate: **3-6 engineer-weeks** to a working internal MVP.
- **Tiptap + AI Suggestion (Top 2):** Drop-in for accept/reject if you accept the **Tiptap Cloud subscription** (closes off "turnkey OSS"). DOCX import is also paid (`tiptap-docx`). With the paid stack: **~2 weeks** to F1. Without paid: collapses to ProseMirror DIY. Deprecation of AI Suggestion → AI Toolkit means rework risk.
- **SuperDoc (Top 3):** Best DOCX fidelity in the OSS list (native OOXML). README claims AI redlining demo but the demos repo doesn't have a dedicated redline directory — **assume you build it**. Need to add: agent loop, comment-thread UI on top of native comments, PDF/HTML ingest, and accept AGPL-3.0's distribution implications. Estimate **4-8 weeks**; AGPL is a real licensing constraint.
- **BlockNote (Top 4):** AI Suggestions verified, comments plugin verified — but DOCX fidelity is weak (export via library, no real OOXML tracked-changes). Better fit for HTML/markdown manuscripts. Add PDF ingest and 3-format normalization. Estimate **3-5 weeks**.
- **ProseMirror + changeset (Top 5):** True bare-metal. Everything is DIY: UI, anchoring, comments, agent. **Archived `prosemirror-changeset`** is a yellow flag — fork or migrate to the new home. Estimate **8-16+ weeks** for parity with Plate-on-day-one. Only justified if you need custom data model.

### Themes Noticed

- The AI-suggestion-with-accept/reject capability is consistently in the **paid tier** for mature editors (Tiptap Pro, CKEditor Premium) and only **OSS-native** in newer entrants (Plate, BlockNote) — which trade away DOCX fidelity.
- **DOCX fidelity vs AI suggestion UX is a fork in the road**: SuperDoc is the only OSS that does OOXML-native tracked changes with real fidelity; Plate/BlockNote operate on contenteditable-like models and lose OOXML structure on round-trip.
- `prosemirror-changeset` archival (2026-04) signals the original ProseMirror substrate is fragmenting — Marijn moved infra off GitHub. Long-term substrate risk for anyone planning to build on it.
- **Comments/discussions are usually a separate plugin** even in editors that have AI suggestions (BlockNote → 3rd-party plugin, Plate → built-in but newer, Tiptap → Pro). F1 needs both, so plan two integrations.
- **Variant walkthrough (F2)** is **not provided by any substrate**. Every OSS editor models a single document state; storing N parallel revisions with a flip-UI is your responsibility regardless of choice.
- The **MS Word add-in path** (Word AI Redliner) is the only "turnkey-ish" OSS option but it's surface-bound to Word desktop and excludes HTML/PDF inputs — useful as a reference implementation of the redline-via-tracked-changes pattern.

### Budget Self-Report
web_fetches_used: 12/12 ; github_searches_used: 8/8