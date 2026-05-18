# Search agent A: turnkey SaaS prose editors and browser extensions

_Recovered from Claude episodic memory — subagent transcript a0f2530c19ce of session `3013a85f` (2026-05-16, PDT)._

_Source: `~/.claude-accounts/anthony/.claude/projects/-Users-anthonybyrnes-PycharmProjects-Python419/3013a85f-a1d7-4f79-97da-e895a9941906/subagents/agent-a0f2530c19ce5b435.jsonl`_

---

Coda AI Reviewer is a real fit — comments and inline edits throughout the doc. I have enough. Let me synthesize.

## Agent A — Findings

### Top 5 (verified)

| name | url | demo_url | type | FMT | ANCHOR | EDIT_UX | CROSS_FMT | last_active | license_or_pricing | region | gaps_vs_vision | relevance |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Sudowrite | https://sudowrite.com/ | https://docs.sudowrite.com/using-sudowrite/1ow1qkGqof9rtcyGnrWUBS/quick-edit/2asL35fds36oHAFJN7bYzz | turnkey | md (in-app docs; .docx import/export) | Y | both (Quick Edit = inline accept/reject/refine; Write/Brainstorm cards = 1-6 variant walkthrough) | Partial (docx I/O; not native PDF/HTML) | 2026-01 (Quick Edit doc) | Subscription $10-44/mo | US | Fiction-leaning; weaker on PDF ingest; no rich comment threads | 5 |
| Type.ai | https://type.ai/ | https://blog.type.ai/post/introducing-a-faster-way-to-edit-with-ai | turnkey | md (in-app); .docx export | Y | turn-based (inline diff with per-edit A/R, "all-at-once" mode, keyboard shortcuts) | Partial (export-strong; ingest limited) | 2024-09 post; product active 2025 | Free + paid tiers | US | No native multi-variant view; no PDF ingest documented | 5 |
| Coda (AI Reviewer) | https://coda.io/ | https://help.coda.io/en/articles/7988177-coda-ai-features | turnkey | Coda canvas (HTML-ish); export to .docx/PDF | Y | turn-based (AI Reviewer leaves anchored comments + edit suggestions; resolve/action per item) | Partial (own canvas format; export-only) | 2025 (AI Reviewer shipped 2024-25) | Paid tiers | US | Locked to Coda doc model; no PDF/DOCX ingest as a manuscript | 4 |
| Lex.page | https://lex.page/ | https://lex.page/ | turnkey | md/html-ish (web doc); .docx export | Y | turn-based (Ask Lex inline prompt, line-level Checks, "show AI hidden text" diff) | Partial (web/export; no PDF ingest) | © 2026 active | Pro subscription | US | No explicit multi-variant carousel; no PDF ingest | 4 |
| Wordtune (Editor + Extension) | https://www.wordtune.com/ | https://www.wordtune.com/blog/wordtune-guide | turnkey + extension | Web editor; Chrome extension overlays Docs/Gmail/etc.; PDF summarizer | Y | variant-walkthrough (multi-suggestion view side-by-side); accept-on-click | Partial (extension reaches HTML surfaces; PDF read-mostly) | 2025 active | Free + Premium | US/IL | Single-sentence variant scope; comment thread weak | 4 |

### Honorable Mentions (5)

| name | url | demo_url | type | FMT | ANCHOR | EDIT_UX | CROSS_FMT | last_active | license_or_pricing | region | gaps_vs_vision | relevance |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Revise (revise.io) | https://revise.io/ | https://revise.io/ ; https://news.ycombinator.com/item?id=47477339 | turnkey | docx, gdoc, PDF ingest; docx/PDF export | Y | static-diff / turn-based (per-edit accept/reject; "self-review" agent) | Y (PDF via multimodal LLM, Word native) | 2025 Show HN | Paid plans | US | Comment-thread UX not yet shipped; variant flow not explicit | 4 |
| Notion AI (+ Suggested Edits) | https://www.notion.com/product/ai | https://www.notion.com/help/suggested-edits | turnkey | Notion blocks; .md/.html export | Y | turn-based (AI generates content, Suggested Edits mode supports tracked accept/reject + comment replies — AI-authored suggestions still maturing) | Partial | 2026 active | Paid AI add-on | US | Suggested Edits primarily human-authored; AI-as-reviewer still limited | 3 |
| HyperWrite | https://www.hyperwriteai.com/ai-document-editor | https://www.hyperwriteai.com/ai-document-editor | turnkey | Web doc; .docx export | Y (TypeAhead + chat-applies-changes) | turn-based (AI Feedback + agent applies edits) | Partial | 2025 active | Tiered paid | US | No documented per-edit accept/reject UI or variant carousel | 3 |
| Sider AI (browser extension) | https://sider.ai/extensions | https://sider.ai/extensions | extension | HTML surfaces (Docs/Gmail/CMS), PDF reader add-on | Y (selection-anchored) | turn-based (rewrite/replace per selection) | Partial (overlay only; no native DOCX edits) | 2025-2026 active | Free + Pro | US | Overlay model; no canonical doc + comment thread | 3 |
| MaxAI (browser extension) | https://www.maxai.me/ | https://www.maxai.me/ | extension | HTML page surfaces | Y (selection-anchored) | turn-based (right-click rewrite/explain) | N | 2025 active | Free + Pro | US | Pure overlay; no diff carousel or thread | 3 |

### Checklist Status

- **Lex.page** — checked — verified: inline "Ask Lex" prompt, line-level Checks, "show AI hidden text" diff. Top 5.
- **Type.ai** — checked — verified: inline diff with per-edit A/R + keyboard shortcuts (Accept A / Reject R). Top 5.
- **Ellipsus** — checked — N/A: explicitly anti-AI positioning; out of scope.
- **Squibler** — checked — partial: "Ask Squibler" rewrite chat in editor, but no clear per-edit accept/reject diff UX in marketing; cap EDIT_UX at rag-chat unless sandbox tested. Excluded from top picks (`unverified` for inline accept/reject).
- **AutoCrit** — checked — pre-agentic baseline: long-running fiction editor with static reports, no agentic inline edit flow surfaced for 2025. Excluded.
- **Wordtune** — checked — verified: multi-suggestion side-by-side variants. Top 5.
- **HyperWrite** — checked — partial; honorable mention.
- **Sider** — checked — verified extension overlay flow; honorable mention.
- **MaxAI** — checked — verified overlay rewrite; honorable mention.
- **Notion AI** — checked — verified suggested edits accept/reject UX with comment threads (primarily human-authored; AI integration partial); honorable mention.
- **Coda AI** — checked — verified AI Reviewer leaves anchored comments + comprehensive edit suggestions; resolve/action per item. Top 5.
- **Claude Artifacts** — checked — verified inline replace-based edits, but no per-edit accept/reject UI in the artifact (whole-artifact replace). Claude for Word add-in defers to Office track-changes — cross-listed; Agent B/D may overlap. Not a top SaaS prose editor experience on its own.
- **Glasp** — checked — N/A: highlight/annotation + AI chat, no manuscript edit flow.
- **Liner** — checked — N/A: research/reading copilot, not a manuscript editor.
- **Readwise Reader (Ghostreader)** — checked — N/A: define/translate/Q&A only; no inline manuscript edits.
- **Grammarly** — checked — pre-agentic baseline; verified per-suggestion accept/reject with keyboard shortcuts and generative rewrites, but no agentic turn-by-turn or variant carousel — note as baseline rather than top pick for the vision.

### Themes Noticed

- **Turn-based per-edit accept/reject is the dominant UX** (Type, Lex, Sudowrite Quick Edit, Coda AI Reviewer, Grammarly). The Word "track changes" mental model has crossed into native web editors.
- **Variant-walkthrough remains rarer**: Wordtune's multi-suggestion panel and Sudowrite's 1-6 generation cards are the clearest analogs to flow F2; most others only support "regenerate" not "compare-N-side-by-side".
- **Comment-thread-on-edit is the missing connective tissue** — Coda AI Reviewer + Notion Suggested Edits are the only turnkey systems where an AI edit lands as an anchored, discussable comment thread rather than a transient diff.
- **Multi-format ingestion is the weakest axis**: Revise is the only one with first-class PDF + DOCX + Google Docs ingest. Most prose editors are export-strong, ingest-weak.
- **Browser-extension overlays (Sider/MaxAI/Wordtune Extension)** trade canonical-document fidelity for ubiquity — strong for HTML surfaces, weak for PDF/DOCX manuscripts.
- **Agentic "coach" framing emerging**: Coda's AI Reviewer and HyperWrite's chat-applies-changes hint at where F1 (turn-by-turn coaching) is heading, but no shipping product fully realizes "agent walks you edit-by-edit" today.

### Budget Self-Report
web_fetches_used: 5/12 ; github_searches_used: 0/8