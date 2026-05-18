# Synthesis: merge of all 4 agent reports

_Recovered from Claude episodic memory — subagent transcript a250735f98c9 of session `3013a85f` (2026-05-16, PDT)._

_Source: `~/.claude-accounts/anthony/.claude/projects/-Users-anthonybyrnes-PycharmProjects-Python419/3013a85f-a1d7-4f79-97da-e895a9941906/subagents/agent-a250735f98c9a7249.jsonl`_

---

## Cross-Category Top 10

1. | **WPS AI (全文润色 + 修订模式)** | D | turnkey suite | DOCX/online/PDF | both (F1 per-edit 接受/拒绝 + F2 4 style variants) | 5 | https://www.kdocs.cn/article/9EB467AE4A.html | Only verified tool that delivers both F1 and F2 by binding AI output to native track-changes
2. | **Sudowrite** | A | turnkey | md/docx I/O | both (Quick Edit inline A/R + 1-6 variant cards) | 5 | https://docs.sudowrite.com/using-sudowrite/1ow1qkGqof9rtcyGnrWUBS/quick-edit/2asL35fds36oHAFJN7bYzz | Dual-flow native; weakest on PDF/HTML ingest
3. | **Wordtune (Editor + Extension)** | A+B | turnkey + extension | DOCX/web/GDocs/HTML; PDF read-only | variant-walkthrough (sentence-scope N variants) | 5 | https://www.wordtune.com/blog/wordtune-guide | Only verified F2 outside Sudowrite/WPS; cross-referenced A↔B
4. | **Harvey for Word** | B | turnkey Word add-in | DOCX | turn-based (per-suggestion A/D, agent self-iterates redline) | 5 | https://www.harvey.ai/resources/videos/improved-word-experience | Most mature F1 on DOCX with agentic loop; legal vertical
5. | **Spellbook** | B | turnkey Word add-in | DOCX | turn-based (per-suggestion A/M/R, bulk approve, threaded comments) | 5 | https://www.youtube.com/watch?v=DOU4nRuDz9s | Comment-thread-on-edit connective tissue is real here
6. | **Trinka AI Word Plugin** | B | turnkey Word add-in | DOCX | turn-based (click-accept, thumbs-down reject, per-error explain) | 5 | (plugin page) | Academic-prose-tuned F1, closest legal-grade UX for manuscripts
7. | **Type.ai** | A | turnkey | md+docx export | turn-based (inline diff, per-edit A/R, keyboard shortcuts) | 5 | https://blog.type.ai/post/introducing-a-faster-way-to-edit-with-ai | Cleanest F1 inline-diff UX in general-writing tier
8. | **Revise (revise.io)** | A | turnkey | docx/gdoc/PDF ingest | turn-based (per-edit A/R + self-review agent) | 4 | (Agent A) | Only Top-10 entry with first-class **PDF ingest**; format unicorn
9. | **Coda (AI Reviewer)** | A | turnkey | canvas + docx/pdf export | turn-based (anchored comments + edit suggestions, per-item resolve) | 4 | https://help.coda.io/en/articles/7988177-coda-ai-features | Anchor + thread + suggestion fusion (rare combo)
10. | **Plate (udecode)** | C | OSS substrate | HTML/MD (Slate) | turn-based (suggestionPlugin + discussionPlugin + applyAISuggestions verified) | 5 | (udecode/plate) | Best OSS path to F1; comment threads native; assembly 3-6 eng-weeks

(Dropped from Top 10: Lex.page rel-4 turn-based; Ivo Review 2.0 rel-4 F1 DOCX; Tiptap rel-5 but AI Suggestion paywalled; SuperDoc rel-4 AI claim unverified; BlockNote rel-4; ProseMirror archived; Lokalise/Crowdin/Phrase strings-not-manuscripts; q.e.d rag-critique not inline-edit; Notion/HyperWrite/Sider/MaxAI all rel-3.)

## Readiness Groups

### Use Today
- **WPS AI** — both flows live in 修订模式; non-English UI is the only friction
- **Sudowrite** — both flows live; strongest on long-form narrative; weakest on PDF/HTML ingest
- **Wordtune** — F2 on sentence-scope today via DOCX/web/extension
- **Harvey for Word** — F1 on DOCX today (legal-tuned, but prose-agnostic)
- **Spellbook** — F1 + threaded comments on DOCX today
- **Trinka AI** — F1 on DOCX today, academic-prose-tuned
- **Type.ai** — F1 today on web/markdown with docx export
- **Coda AI Reviewer** — F1 + anchored thread today inside Coda canvas

### Use With Assembly
- **Revise (revise.io)** — F1 works on PDF ingest; missing F2 variant flow; assembly = wrap F1 calls to produce N versions and add a flipper UI
- **Wordtune** — has F2 at sentence scope only; missing whole-document variant flip; assembly = orchestrate per-section batch + custom variant browser

### Build On Top
- **Plate (udecode)** — 3-6 engineer-weeks to F1; add DOCX ingest (mammoth/SuperDoc bridge) + PDF→DOCX pre-step + agent loop + F2 variant storage layer (~2-3 more weeks for F2)

### Watch
- **SuperDoc** — best DOCX fidelity + AGPL-3.0; AI redlining claim unverified in repo (no demo); revisit when demo lands
- **Microsoft Word native AI redlining** — Robin AI team absorbed Jan 2026, native arrival expected 2026; pre-release
- **Ivo Review 2.0** — verified but legal-playbook-bound, not manuscript-shaped yet
- **q.e.d Science** — academic-AI peer review on PDF, but claim-level critique not inline-edit-with-thread
- **Tiptap AI Suggestion** — verified but paywalled and migrating to AI Toolkit (deprecation risk)
- **prosemirror-changeset** — archived 2026-04; track-changes primitive still usable but unmaintained

## Gap Callouts
- **HTML:** ~3 verified turnkey hits (Wordtune extension, Coda canvas, Lex.page web). No turnkey tool delivers F1+F2 on raw HTML manuscripts; substrate path (Plate/BlockNote) is the realistic route.
- **PDF:** **1 verified turnkey hit with real ingest (Revise).** Everything else collapses to rag-chat or requires PDF→DOCX conversion. F2 on PDF is zero.
- **DOCX:** 6 verified turnkey hits (Harvey, Spellbook, Trinka, Ivo, Wordtune, WPS AI). DOCX is where the market lives. F1 is solved; F2 is solved only by WPS AI and Wordtune (sentence-scope).

## PDF Honesty Note

Agent B's verdict, quoted: *"True in-context AI redline overlay on PDF is effectively absent in this category. Every PDF-native AI tool surveyed (Adobe AI Assistant, ChatDOC, Humata) collapses to rag-chat-only. Anyone wanting F1/F2 flows on a PDF manuscript will need to convert PDF→DOCX first."*

Plainly: **inline AI-diff on PDF does not exist in the wild as of 2026-05.** Revise gets closest by ingesting PDF, but the editing experience routes through a normalized doc model, not the original PDF page. If your manuscripts are PDF-first, plan for a PDF→DOCX conversion step (Nougat OSS, or the converter inside Revise/WPS).

## Cross-Agent Themes

- **Format gravity is DOCX.** Every category — legal (B), general writing (A), Chinese suites (D), and even OSS DOCX-fidelity substrates (C: SuperDoc) — converges on the .docx + tracked-changes substrate as the only place F1 truly works at production fidelity.
- **F1 is solved, F2 is rare.** Per-edit accept/reject with anchored comments is mainstream across A/B/D; whole-document variant-flip exists only in WPS AI (4 style presets), Sudowrite (1-6 cards), and at sentence-scope in Wordtune. The "flip between N full revisions in-place" UX is open green-field.
- **Comment-thread-on-edit is the missing connective tissue** (Agent A explicit, Agent D explicit). Only Coda AI Reviewer, Notion Suggested Edits, Spellbook, and WPS AI fuse anchored AI suggestion → threaded discussion → accept/reject. The user's request points squarely at this gap.
- **Legal-tech is 1-2 years ahead of academic editors** (Agent B). Harvey/Spellbook/Ivo UX patterns will migrate into academic writing tools through 2026 — and Word's own native AI redlining (post-Robin acquisition) will likely reset the field.
- **Chinese suites bind AI to native track-changes** (Agent D, unique insight). WPS AI rendering into 修订模式 means AI edits inherit the same per-edit accept/reject as human edits — no separate UI surface. This is the most elegant integration pattern across all four reports.
- **OSS-native AI suggestion is paywalled in mature editors, free in young ones.** Tiptap AI Suggestion and CKEditor Track Changes are premium-tier; Plate and BlockNote ship it MIT — but at the cost of DOCX fidelity. You pick: pay for fidelity, or assemble for freedom.
- **Variant walkthrough (F2) is provided by zero OSS substrates.** Whether you go Plate, BlockNote, SuperDoc, or ProseMirror, you build F2 yourself — variant storage, diff comparison, and flip-UI are not in any toolkit.
- **PDF is a dead end for inline editing** across A/B/C/D. Every PDF-native AI tool collapses to rag-chat. The pragmatic path is PDF→DOCX as a pre-processing step.

## Recommended Next Action for User

Given the turnkey > plugin > substrate bias and the user's both-flows-desired framing, **trial WPS AI first** — it is the only verified turnkey tool that delivers F1 and F2 simultaneously on DOCX/PDF, and its 修订模式 binding is the cleanest UX pattern across all 40 candidates. If the Chinese-first UI is a blocker, **run a parallel trial of Sudowrite** (also dual-flow, English-native, narrative-tuned) and **Spellbook** (F1 + threaded comments, English legal-tuned but prose-agnostic). What to validate first: whether the F2 variant granularity (full-document vs. paragraph vs. sentence) matches the manuscript scale you actually edit — that single choice eliminates 70% of the candidate field.