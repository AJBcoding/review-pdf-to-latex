# Search agent D: non-English suites and adjacent UX (CAT tools, etc.)

_Recovered from Claude episodic memory — subagent transcript a83658b5fab8 of session `3013a85f` (2026-05-16, PDT)._

_Source: `~/.claude-accounts/anthony/.claude/projects/-Users-anthonybyrnes-PycharmProjects-Python419/3013a85f-a1d7-4f79-97da-e895a9941906/subagents/agent-a83658b5fab8a4b70.jsonl`_

---

I have enough to compile the report. Let me compose findings.

## Agent D — Findings

Non-English suites are clearly leading on inline-AI-edit UX, especially WPS AI's "revision mode" hook where AI-generated changes flow through the same per-edit accept/reject mechanism as human track-changes. Tencent Docs has the AI assistant breadth but its inline accept/reject UX is less crisply documented. Translation-review CAT tools (Lokalise, Crowdin, Phrase, XTM) are surprisingly close to the vision — per-segment is a natural anchor — but they treat the segment as the unit, not the in-prose edit.

### Top 5 (verified)

| name | url | demo_url | type | FMT | ANCHOR | EDIT_UX | CROSS_FMT | last_active | license_or_pricing | region | gaps_vs_vision | relevance |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| WPS AI (全文润色 + 修订模式) | https://ai.wps.cn/ | https://www.kdocs.cn/article/9EB467AE4A.html ; https://bbs.wps.cn/topic/40645 | turnkey suite | DOCX, online doc, PDF (via WPS) | inline char-range; tracked-change markers (strikethrough/underline) | per-edit accept/reject across full polish; style variants (更正式/党政风/更活泼/口语化) — closest dual F1+F2 | yes — WPS Writer + Docs online + mobile | active 2025 (May 2026 still shipping) | commercial; freemium + WPS 365 paid | CN (intl version available) | AI rewrites can drop revision-mode mid-edit (known bug per WPS forum); polish is selection-scope, not "agent walks edit-by-edit" with discussion thread | 5 |
| Lokalise AI Suggestions | https://lokalise.com/ai/ | https://docs.lokalise.com/en/articles/7187498-ai-suggestions | turnkey CAT | strings/JSON/XLIFF (not prose docs) | per-segment | turn-by-turn: Translate→Approve/Try again/Cancel; "Suggest variants" → choose-one (true F2 in miniature); Rephrase/Shorten buttons | weak — segmented content only | active 2025; AI Suggestions GA | commercial SaaS | EU (Latvia) | segment ≠ in-prose edit; no DOCX/PDF authoring; comment thread is per-key not per-edit-proposal | 4 |
| Crowdin AI in Editor + AI QA | https://support.crowdin.com/crowdin-ai/ | https://crowdin.com/blog/2025/07/01/whats-new-at-crowdin | turnkey CAT | strings + WYSIWYG preview for HTML | per-segment popover in WYSIWYG; AI QA warnings inline | save-to-editor with "Run Tool" confirm (proto-F1 turn-by-turn); pre-translate variants reviewable | yes — WYSIWYG over rendered HTML is closest analog to in-prose | active June 2025 update | commercial SaaS, OSS-ish workflow | EU (Estonia) | string-bounded; AI QA only flags, doesn't propose rewrites with comment threads | 4 |
| Phrase TMS (AI Translation Agent + QPS) | https://phrase.com/platform/ai/ | https://support.phrase.com/hc/en-us/articles/5709683847964-CAT-Editor-TMS | turnkey CAT | XLIFF + DOCX/PDF connectors | per-segment in CAT editor; QPS scores route segments to AI post-edit | inline TM/MT/AI suggestions appear when ≥50% match; AI agent does post-edit; QPS quality-flagged segments routed for review | yes — file-format agnostic via filters | active 2025 | commercial SaaS | EU (DE/CZ) | not a discussion-thread UX; "agent walks user" is automated not coached | 3 |
| q.e.d Science (eLife partner) | https://www.qedscience.com/ | https://connect.biorxiv.org/news/2025/11/04/qed_review_tool ; https://www.the-scientist.com/q-e-d-an-ai-tool-for-smarter-manuscript-review-73759 | turnkey academic peer-review AI | PDF upload (bioRxiv pipeline) | claim-level (breaks paper into claims) — not inline char-range | report-style critique with claim-anchored gaps + suggested mitigations; not per-edit accept/reject | weak — output is a report, not inline edits on source manuscript | active 2025 (eLife partnership announced; B2X pipeline live Nov 2025) | commercial; institutional access at 1000+ sites | US/global | not inline-edit UX — it's structured critique. Useful as F1 "coaching" inspiration but no in-doc edits | 3 |

### Honorable Mentions (5)

| name | url | demo_url | type | FMT | ANCHOR | EDIT_UX | CROSS_FMT | last_active | license_or_pricing | region | gaps_vs_vision | relevance |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Tencent Docs AI (智能助手) | https://docs.qq.com/ai | https://www.qbitai.com/2024/01/116911.html ; https://www.uied.cn/56070.html | turnkey suite | online doc, sheet, slide, PDF, mind-map | spell/grammar inline; AI generation appears as block insert | real-time spell/grammar with replacement; AI rewriting is generation-then-insert, not per-edit accept/reject thread | yes — across full QQ docs format ecosystem | active 2024 public beta → 2025 | commercial; free tier + 会员 | CN | inline accept/reject UX for AI rewrite not clearly documented; closer to RAG+gen than edit-by-edit coach | 3 |
| Smartling AI Toolkit (Post-Editing Agent + LQA Agent) | https://help.smartling.com/hc/en-us/articles/25056873662107 | https://www.smartling.com/company-news/growth-in-ai-translation-in-2025 | turnkey CAT | XLIFF + connectors | per-segment in CAT editor | AI post-edit applied automatically; LQA Agent (April 2026) scores quality — review UX not crisp per-edit accept/reject | yes via connectors | active 2025; +218% YoY | enterprise SaaS | US | post-edit is automated not coached; little public demo of segment-level human approval UX | 2 |
| memoQ AGT | https://www.memoq.com/product/memoq-agt/ | https://docs.memoq.com/current/en/Workspace/pre-translate-with-agt.html | turnkey CAT | XLIFF | per-segment | AI generates suggestions surfaced in CAT grid; linguist edits manually — no "agent walks edit-by-edit" thread | yes | active 2024-2025 | commercial | EU (HU) | classic CAT, no comment-thread-on-edit UX | 2 |
| DeepL Write Pro (enterprise) | https://www.deepl.com/en/products/write | https://support.deepl.com/hc/en-us/articles/9710730337820 | turnkey writing assistant | freeform text input (not file-anchored) | inline highlighted spans; click → alternatives popover | "accept, reject, or modify as you go, similar to track changes" per docs; style rules apply org-wide | weak — text-area only, not native DOCX/PDF round-trip | active 2025 | commercial SaaS, enterprise tier | EU (DE) | no file-anchor, no comment thread, no variant walkthrough; closest English analog to WPS 润色 | 3 |
| XTM Cloud Intelligent Post-Editing | https://xtm.ai/ai-translation/intelligent-post-editing | https://xtm.cloud/ai-translation-software/intelligent-workflow/ | turnkey CAT | XLIFF + connectors | per-segment + auto inline-tag insertion | automated correction before linguist sees it; linguist reviews flagged segments | yes | active 2025 | enterprise SaaS | EU (PL/UK) | automation-first, not user-paced coaching | 2 |

### Checklist Status

- **Tencent Docs AI (智能修订)** — checked; honorable mention. Confirmed AI assistant with grammar/spell inline + AI generation, but per-edit accept/reject UX for AI rewrites under-documented in public sources. Relevance 3.
- **WPS AI (润色)** — checked; **TOP-1**. Confirmed full-text polish renders via revision mode with per-edit 接受/拒绝, plus 4 style variants (formal/政/lively/colloquial) — gives both F1 and F2 in one product. Sources: kdocs.cn article, WPS BBS topics 40645/43859/86156/86180.
- **Smartling** — checked; honorable mention. AI Post-Editing Agent + 2026 LQA Agent, but the user-facing accept/reject UX is not crisply demo'd.
- **Crowdin** — checked; top-5. AI in Editor + AI QA + June 2025 "Run Tool" confirm gate. WYSIWYG preview with click-to-edit popovers is closest CAT analog to in-prose anchoring.
- **Lokalise** — checked; top-5. Documented turn-by-turn UX (Translate → Approve/Try again) and explicit "Suggest variants" → choose-one (F2 mini).
- **Phrase** — checked; top-5. Inline TM/MT/AI suggestions at segment level + QPS-driven review routing; AI Translation Agent + post-editing.
- **PubPub** — checked; N/A as direct candidate. Open peer-review workflow platform from Knowledge Futures; supports annotation and review stages but no AI inline-edit-proposal UX surfaced. Inspiration only.
- **eLife Sciety** — checked; N/A as direct candidate. eLife → q.e.d Science partnership is the active AI peer-review experiment; Sciety itself remains a human-curation layer. q.e.d brought in as Top-5 instead.
- **Authorea** — checked; N/A. Wiley-owned collaborative LaTeX/Markdown writing with Git history and journal templates, but no AI inline-edit-suggestion UX in public docs.
- **Frame.io** — checked; adjacent-UX inspiration (not candidate). Frame-accurate annotation + threaded comments + paintbrush-icon-on-card marker is the gold-standard async-review pattern worth stealing for comment threads on inline edits.
- **Figma comments** — checked; adjacent-UX inspiration. Native AI design review assistant + community plugins (Uixx, Resonote, Ornis) that pin AI suggestions as comments on exact elements — closest visual analog for "pin AI suggestion to a specific span."

### Adjacent-UX Inspirations

- **Frame.io comment threads** — paintbrush-icon-on-card marker indicates an annotation; threaded replies; filter by annotated/unread/hashtag. Steal: per-edit comment cards with attached visual diff, filterable.
- **Figma Uixx / Ornis / Resonote plugins** — AI critique pinned as comments on exact design elements with action buttons. Steal: AI-edit-proposal-as-pinned-comment-with-quick-actions.
- **Feishu (Lark) revision mode** — though human-driven, the right-rail "revision suggestion card" UX with per-edit accept/reject/reply/resolve and color-coded authorship (which client/editor/collaborator) is the cleanest doc-side analog to Frame.io. Steal: card-rail + authorship colors, treat AI as just another "reviewer identity."
- **PubPub release/review stages** — explicit lifecycle stages (Works-in-Progress → community review → release) for structuring iterative AI+human feedback rounds.
- **q.e.d Science claim decomposition** — break manuscript into claims and target feedback at the claim level — useful conceptual anchor for F1 ("walk me through each claim's weakness") above char-range edits.

### Themes Noticed

- **Chinese suites bind AI output to the existing track-changes substrate.** WPS AI 全文润色 explicitly renders into "修订模式" so AI-proposed edits inherit the same per-edit 接受/拒绝 controls as human edits — Western prose tools treat AI as a separate sidebar/popover layer. This is the single biggest UX delta and points straight at F1.
- **Style/tone variants are first-class in Chinese tools.** WPS exposes 4 named voice presets (formal/governmental/lively/colloquial) as one-click rewrites; this is closer to F2 (variant walkthrough) than anything in DeepL Write or Grammarly. Tencent's smart assistant similarly leans on stylistic verb-prompts ("写正式版", "简化", etc.).
- **Translation CAT tools have already solved per-anchor accept/reject — at segment granularity.** Lokalise's Approve/Try again/Cancel and Crowdin's "Run Tool" confirm-gate are mature turn-by-turn UX, but the anchor is a string, not an in-prose character range. Porting the segment idiom to sentence/clause spans is a small leap.
- **Variants exist but are weak.** Lokalise "Suggest variants" → choose-one and Phrase's TM/MT/AI parallel suggestions are the only F2-shaped features in the verified set. Nobody has a true "flip between N full-document revisions in-place" experience — open green-field for the proposed tool.
- **Western academic AI = report mode, not inline-edit mode.** q.e.d Science, Paperpal, Trinka (English) all default to a report or sidebar-suggestion paradigm; only Trinka writes back into a DOCX with track-changes. Closest English peer to WPS's revision-mode-binding is Trinka, but it lacks variant walkthroughs and discussion threads.
- **Frame.io's threaded-comment-on-anchored-mark UX is unmatched in document tooling.** Doc world has comment threads (Google Docs/Word) OR AI suggestions, but no one fuses "anchored AI suggestion → threaded discussion → accept/reject → version-flip." That's the gap the brief is pointing at.

### Budget Self-Report

web_fetches_used: 5/12 ; github_searches_used: 0/8

Sources:
- [WPS AI 全新升级：智能全文润色与修订模式](https://www.kdocs.cn/article/9EB467AE4A.html)
- [WPS AI 帮我改 教程](https://bbs.wps.cn/topic/40645)
- [WPS AI 全文润色 体验帖](https://bbs.wps.cn/topic/43859)
- [腾讯文档 AI](https://docs.qq.com/ai)
- [腾讯文档智能助手公测 (量子位)](https://www.qbitai.com/2024/01/116911.html)
- [Lokalise AI Suggestions docs](https://docs.lokalise.com/en/articles/7187498-ai-suggestions)
- [Lokalise AI orchestration](https://lokalise.com/ai/)
- [Crowdin AI docs](https://support.crowdin.com/crowdin-ai/)
- [Crowdin June 2025 update](https://crowdin.com/blog/2025/07/01/whats-new-at-crowdin)
- [Phrase CAT Editor](https://support.phrase.com/hc/en-us/articles/5709683847964-CAT-Editor-TMS)
- [Phrase AI Platform](https://phrase.com/platform/ai/)
- [Smartling AI Toolkit](https://help.smartling.com/hc/en-us/articles/25056873662107)
- [Smartling 218% AI growth 2025](https://www.smartling.com/company-news/growth-in-ai-translation-in-2025)
- [DeepL Write enterprise](https://www.deepl.com/en/products/write)
- [memoQ AGT product](https://www.memoq.com/product/memoq-agt/)
- [XTM Intelligent Post-Editing](https://xtm.ai/ai-translation/intelligent-post-editing)
- [q.e.d Science](https://www.qedscience.com/)
- [q.e.d + bioRxiv pipeline](https://connect.biorxiv.org/news/2025/11/04/qed_review_tool)
- [eLife on AI review](https://elifesciences.org/articles/110392)
- [PubPub platform](https://www.knowledgefutures.org/pubpub/)
- [Authorea](https://www.authorea.com/inst/7193-authorea)
- [Frame.io comments](https://help.frame.io/en/articles/9105251-commenting-on-your-media)
- [Figma AI design review](https://www.figma.com/solutions/ai-design-review-assistant/)
- [Feishu revision mode](https://www.feishu.cn/content/feishu-documents-new-revision-mode-meet-professional-needs-boost-collaboration-efficiency)
- [Feishu 智能纠错](https://www.feishu.cn/hc/zh-CN/articles/360043910114)