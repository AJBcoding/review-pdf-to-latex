# Search agent B: AI PDF readers and legal redline tools

_Recovered from Claude episodic memory — subagent transcript acc486e7e8a1 of session `3013a85f` (2026-05-16, PDT)._

_Source: `~/.claude-accounts/anthony/.claude/projects/-Users-anthonybyrnes-PycharmProjects-Python419/3013a85f-a1d7-4f79-97da-e895a9941906/subagents/agent-acc486e7e8a185c0c.jsonl`_

---

Confirmed Humata = rag-chat-only. Compiling findings now.

## Agent B — Findings

### Top 5 (verified)

| # | name | url | demo_url | type | FMT | ANCHOR | EDIT_UX | CROSS_FMT | last_active | license_or_pricing | region | gaps_vs_vision | relevance | PDF_LABEL |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Harvey for Word | https://www.harvey.ai/platform/word-add-in | https://www.harvey.ai/resources/videos/improved-word-experience | turnkey | DOCX | inline (Word add-in) | per-suggestion accept/dismiss; agent iterates own work into clean redline; follow-up requests build context (F1-leaning) | DOCX only via add-in; broader platform handles other formats separately | 2025-06+ Brief; vision-model redline detection 2025 | enterprise SaaS, contact sales | Global, enterprise legal | No multi-variant flip (F2); enterprise gating | 5 | n/a |
| 2 | Spellbook | https://spellbook.com/features/review | https://www.youtube.com/watch?v=DOU4nRuDz9s (2024-02 complete review) | turnkey | DOCX | inline (Word add-in) | per-suggestion accept/modify/reject; bulk approve; comments drafted under user name (F1) | DOCX only | active 2025-2026; ~60% accept rate cited | per-seat SaaS | Global | Legal-domain bias; no F2 variants | 5 | n/a |
| 3 | Ivo Review 2.0 | https://www.ivo.ai/product/review | https://www.ivo.ai/demo (demo request); blog post on Review 2.0 | turnkey | DOCX | inline (Word add-in) | Redline-with-Assistant: plain-language prompts apply playbook edits; agentic redline + comments (F1) | DOCX | Review 2.0 launched 2025 | enterprise SaaS | Global | Demo gated; F2 unclear | 4 | n/a |
| 4 | Trinka AI Word Plugin | https://www.trinka.ai/wordplugin/ | https://www.trinka.ai/wordplugin/ (embedded walk-through video) | turnkey | DOCX | inline (Word add-in, right panel + highlight) | click suggested word to accept; thumbs-down to reject; per-error explanation (F1) | also has Proofread-File batch (TC DOCX out) | active 2025 | freemium + Premium | India/global, academic | No F2 variants; no agentic multi-turn chat per edit | 5 | n/a |
| 5 | Wordtune | https://www.wordtune.com/ | https://microsoftedge.microsoft.com/addons/detail/wordtune-aipowered-wri/fgngodlaekdlibajobmkaklibdggemdd | turnkey | DOCX, web, GDocs | inline highlight + sidebar | sentence rewrite produces N variants user flips between (F2 native); also single-shot accept/reject (F1-light) | browser + Word add-in | active 2025 | freemium + Premium/Business | Sentence-scope only (no doc-wide agent thread); weaker for technical/legal | 5 | n/a |

### Honorable Mentions (5)

| name | url | demo_url | type | FMT | EDIT_UX | last_active | gaps | relevance | PDF_LABEL |
|---|---|---|---|---|---|---|---|---|---|
| Dioptra | https://www.dioptra.ai/ | https://www.dioptra.ai/ (request demo) | turnkey, Word add-in | DOCX | playbook-driven inline redlines + issue list in Word | 2025 | demo-gated visual evidence; F2 absent | 4 | n/a |
| Screens by Agiloft | https://www.agiloft.com/solutions/screens-by-agiloft/ | demo on request | turnkey, Word add-in | DOCX | per-clause redline w/ explanation; configurable wording style | 2025 (12x usage growth) | Word add-in only; no F2 | 4 | n/a |
| DraftWise | https://www.draftwise.com/ | free demo on site | turnkey, Word+Outlook | DOCX | instant redline + clause comparison in Word | 2025 | requires deal history corpus | 3 | n/a |
| BlackBoiler | https://www.blackboiler.com/ | site demo | turnkey, Word add-in | DOCX | returns auto-marked-up version in Word Track Changes with inline comments | 2025 | batch markup, less per-edit conversational | 3 | n/a |
| Writefull Revise | https://www.writefull.com/writefull-revise | https://help.writefull.com/writefull-revise--user-guide | turnkey, upload→download | DOCX | upload → download DOCX with native Word Track Changes; choose Writefull vs GPT model (proto-F2) | 2025 (model picker added) | not live inline; institutions/publishers only | 3 | n/a |

### Checklist Status

- **Adobe AI Assistant**: checked — sidebar chat with page-anchored citations + writing suggestions; user applies manually via Edit-PDF. PDF_LABEL: **rag-chat-only** (with sidecar suggestions). Not in top 5; misses anchored accept/reject.
- **ChatDOC**: checked — TapSource citation-based Q&A; no edit/redline. PDF_LABEL: **rag-chat-only**. Excluded.
- **Humata**: checked — Q&A + rewrite-summary; no inline doc edit. PDF_LABEL: **rag-chat-only**. Excluded.
- **Spellbook**: checked — Top 5 #2.
- **Harvey**: checked — Top 5 #1.
- **Robin AI**: checked — had Word add-in with accept/refine/reject and tracked-change recognition, but **company collapsed late 2025; engineering team absorbed into Microsoft Word Jan 2026**. No longer a procurable turnkey product. Excluded from top 5 despite strong fit; worth noting for context.
- **Ivo**: checked — Top 5 #3.
- **Athena**: N/A — no contract-redline product with this name surfaces; Athena Intelligence is an analytics platform, not redline. Likely a category-mislabel.
- **Paperpal**: checked — strong claim of inline accept/reject in Word/Web/GDocs/Overleaf sidebar; couldn't extract verbatim demo evidence from product page beyond marketing copy. Capped as honorable-equivalent; would land top-5 with verified demo. Marked `unverified` on F1 specifics.
- **Writefull**: checked — Honorable mention (download-only TC DOCX, no live inline).
- **Trinka**: checked — Top 5 #4 (verified demo video on plugin page).
- **Penelope.ai**: checked — out of scope. It is a manuscript **compliance/structure checker** that produces a flagged feedback report, not an AI editor with per-edit accept/reject anchored in the document body.

### PDF Reality Verdict

True in-context AI redline overlay on PDF is effectively absent in this category. Every PDF-native AI tool surveyed (Adobe AI Assistant, ChatDOC, Humata) collapses to **rag-chat-only** — chat sidebar with citation anchors back to the source PDF, where the AI does not produce accepted-or-rejectable edits inline in the rendered PDF. Adobe's Assistant adds a sidecar-suggestions layer ("rephrase this paragraph") but applying the edit requires hopping into the separate Edit-PDF tool, breaking the inline-accept loop. Anyone wanting F1/F2 flows on a PDF manuscript will, in practice, need to convert PDF→DOCX first and run a DOCX-native tool (Harvey/Spellbook/Trinka/Wordtune) — or accept rag-chat-only on the PDF itself.

### Themes Noticed

- **Format gravity is DOCX.** Every credible inline-edit-accept UX lives as a Microsoft Word add-in. HTML and PDF are second-class; PDF is essentially unsupported for true in-context AI diff.
- **F1 (turn-by-turn) is the dominant paradigm.** Harvey, Spellbook, Ivo, Trinka, Robin (pre-collapse), Dioptra, Screens, BlackBoiler all converge on the same pattern: AI proposes track-changes inline, user accepts/dismisses per edit, optional chat follow-up.
- **F2 (variant walkthrough) is rare and shallow.** Only Wordtune offers genuine multi-variant flipping, and only at sentence scope. Writefull's "choose your model" (Writefull vs GPT) is a proto-F2 across the whole doc but produces two separate downloads, not an in-context flip.
- **Legal-tech is the most mature vertical.** Half the top 10 are contract-redline tools; the UX patterns there are 1-2 years ahead of academic editors.
- **Robin AI's collapse (late 2025) is a market signal.** Even with a strong product, contract-redline as a standalone tier-1 vendor is being commoditized — Microsoft absorbing Robin's team hints at native Word AI redlining arriving in 2026.
- **"Agentic" claims usually mean iterative refinement within one suggestion, not true multi-turn coaching per edit.** Harvey is closest to F1's vision (agent "reviews its own work until clean"); nobody has fully delivered "discuss this specific edit, then accept/reject" as a first-class loop.

### Budget Self-Report

web_fetches_used: 6/12 ; github_searches_used: 0/8

Sources:
- [Harvey for Word how-to](https://help.harvey.ai/articles/harvey-for-word)
- [Harvey improved Word experience blog](https://www.harvey.ai/blog/improved-word-experience)
- [Spellbook Review feature page](https://spellbook.com/features/review)
- [Spellbook complete review (YouTube)](https://www.youtube.com/watch?v=DOU4nRuDz9s)
- [Ivo Review product page](https://www.ivo.ai/product/review)
- [Ivo Review 2.0 blog](https://www.ivo.ai/blog/introducing-review-2-0-contract-review-that-knows-what-your-team-has-agreed-to)
- [Trinka Word plugin](https://www.trinka.ai/wordplugin/)
- [Wordtune product page](https://www.wordtune.com/)
- [Writefull Revise](https://www.writefull.com/writefull-revise)
- [Writefull Revise user guide](https://help.writefull.com/writefull-revise--user-guide)
- [Paperpal for researchers](https://paperpal.com/paperpal-for-researchers)
- [Adobe Acrobat AI Assistant](https://www.adobe.com/acrobat/generative-ai-pdf.html)
- [ChatDOC](https://www.chatdoc.com/)
- [Humata](https://www.humata.ai/)
- [Robin AI Word add-in](https://robinai.com/news-and-resources/robin-university/word-add-in-an-intelligent-ai-sidekick-for-contract-review)
- [Penelope.ai](https://www.penelope.ai/)
- [Dioptra](https://www.dioptra.ai/)
- [Screens by Agiloft](https://www.agiloft.com/solutions/screens-by-agiloft/)
- [DraftWise](https://www.draftwise.com/)
- [BlackBoiler](https://www.blackboiler.com/)