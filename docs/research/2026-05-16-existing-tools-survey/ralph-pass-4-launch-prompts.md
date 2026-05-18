# Ralph pass 4: final launch-ready prompts

_Recovered from Claude episodic memory — subagent transcript `agent-a2d76a8a7b2a` of session `3013a85f` (2026-05-16, PDT)._

---

## Orchestrator prompt fed into this pass

```
You are Pass 4 (final) of a 4-pass Ralph refinement loop. Passes 1-3 built up a search brief; your job is to convert V3 into **launch-ready, copy-pasteable prompts** for 4 parallel search sub-agents (A/B/C/D) plus a synthesis prompt. Do NOT search the web yourself.

Here is V3 verbatim (the brief that drives the prompts):

---
# Search Brief V3

## 0. User Intent
User wants a turnkey tool that ingests multi-format manuscripts (HTML/PDF/DOCX) and provides an AI agent that proposes concrete edits rendered inline in the original document with a comment thread. Two flows both desired:
- (F1) Turn-by-turn coaching — agent walks user edit-by-edit, accept/reject/discuss per edit.
- (F2) Variant walkthrough — agent generates N revised versions, user flips between them in-context.

A tool with either is in-scope. Bias: turnkey > plugin > substrate.

## 1. Capability Matrix
FMT {html, pdf, docx, md} / ANCHOR {Y/N} / EDIT_UX {none, rag-chat, static-diff, turn-based, variant-walkthrough, both} / CROSS_FMT {Y/Partial/N}.

## 2. Categories & Agent Routing
- A — Turnkey SaaS prose/HTML editors + browser extensions.
- B — AI PDF + legal redline (incl. academic AI editors like Paperpal, Writefull, Trinka).
- C — OSS substrate / editor frameworks.
- D — Non-English (Tencent Docs AI, WPS AI) + translation review + academia/peer review + adjacent UX (Frame.io, Figma). Tencent/WPS treated first-class.

Routing: editor-framework repo → C; SaaS-built-on-framework → A; legal-AI → B; non-English/translation → D; browser extensions → A.

## 3. PDF Reality Disclaimer
True in-context diff overlay on PDF is rare/possibly empty. Agent B surfaces closest approximation labeled: sidecar-diff-pane / annotation-as-suggestion / redline-overlay / extracted-text-edit-then-reflow / rag-chat-only.

## 4. Search Queries
GitHub: `tiptap ai suggestions in:readme pushed:>2025-01-01`, `prosemirror "track changes" OR "suggest mode" in:readme pushed:>2025-01-01`, `(pdf OR docx) "ai redline" OR "ai suggestions" in:readme pushed:>2025-01-01`, `topic:ai-editor pushed:>2025-01-01`, `"accept/reject" llm editor in:readme`.

Web: `"AI suggestions" "track changes" 2025`, `"redline with AI" docx`, `"walk through" "AI edits" document editor`, `"Lex.page" agent`, `"Claude Artifacts" document editing inline`, `Tencent Docs AI 智能修订`, `WPS AI 润色`, `"OSS alternative to Spellbook"`, `"variant" "rewrite" document editor AI`.

## 5. Verification Protocol
Before crediting EDIT_UX ≥ static-diff: open demo/sandbox OR find screenshot/GIF/video showing accept/reject inline UX OR skim README/issues for `suggestion`, `accept`, `reject`, `track-changes`, `inline diff`. Marketing copy alone → cap EDIT_UX at rag-chat, mark `unverified`. Each top-5 finding must include `demo_url`.

## 6. Disambiguators
Exclude: chat-with-PDF RAG without anchored edits (except as PDF-closest-approx); whole-doc rewriters; pure track-changes; code review tools; generic sticky-note PDF annotators.

## 7. High-Priority Candidates Checklist (must explicitly confirm checked or N/A)
A: Lex.page, Type.ai, Ellipsus, Squibler, AutoCrit, Wordtune, Hyperwrite, Sider, MaxAI, Notion AI, Coda AI, Claude Artifacts, Glasp, Liner, Readwise Reader, Grammarly.
B: Adobe AI Assistant, ChatDOC, Humata, Spellbook, Harvey, Robin AI, Ivo, Athena, Paperpal, Writefull, Trinka, Penelope.ai.
C: ProseMirror, Tiptap, CKEditor, BlockNote, Plate, Affine, Hypothes.is, PSPDFKit, Recogito, Nougat.
D: Tencent Docs AI, WPS AI, Smartling, Crowdin, Lokalise, Phrase, PubPub, eLife Sciety, Authorea, Frame.io, Figma comments.

## 8. Output Schema (per finding, 8 fields)
name | url | demo_url | type {turnkey/plugin/substrate} | FMT | ANCHOR | EDIT_UX | CROSS_FMT | last_active | license_or_pricing | region | gaps_vs_vision | relevance 1-5

## 9. Token & Tool Budget
Per sub-agent: max 12 web fetches, max 8 GitHub searches. Stop at 5 verified top picks + 5 honorable mentions.

## 10. Recency
Active since 2025-01-01. Pre-2025 = "pre-agentic baseline," include only if exceptionally relevant.

## 11. Synthesis Step
Cross-category Top 10 ranked by relevance then EDIT_UX strength (`both` > `variant-walkthrough` ≈ `turn-based` > `static-diff` > `rag-chat`). Grouping by readiness: "Use today" / "Use with assembly" / "Build on top" / "Watch." Gap callout for any of {html, pdf, docx} with zero verified turnkey hits. Honesty note if PDF resolves to rag-chat-only.

## 12. Volume
Top 5 + 5 honorable mentions per agent. Synthesis returns final Top 10 + readiness groups. Hard cap: 40 candidates total.
---

**Your job:** produce 5 standalone prompts (Agent A, Agent B, Agent C, Agent D, Synthesis) ready to paste into 5 separate `Agent()` tool calls. Each prompt must be:

1. **Self-contained** — sub-agent has no other context. Include the user's original request verbatim, the user-intent paragraph, the relevant subset of §7 checklist, the verification protocol, the output schema, the budget, and the routing rules **for that agent's scope only**.

2. **Action-oriented** — start with "You are Sub-Agent [X]. Your scope: [...]." Then list the exact steps to follow.

3. **Output-formatted** — specify return format precisely: a markdown section beginning `## Agent [X] — Findings`, then top-5 table, honorable-mentions table, themes-noticed bullet list, and a self-report of how many web fetches / searches used.

4. **Conflict-aware** — include the routing rules so each agent defers correctly when a candidate spans categories.

5. **Cap-aware** — include the budget (max 12 web fetches, max 8 GitHub searches, 5 top + 5 HMs).

6. **Verification-aware** — repeat the verification protocol inline so each agent enforces it.

For the **Synthesis prompt**, write it so it takes the 4 agent reports as inputs (placeholder `{{AGENT_A_REPORT}}` etc.) and emits the cross-category Top 10, readiness groups, gap callouts, and honesty note.

Output your final deliverable as 5 fenced markdown blocks, one per prompt, each clearly headed `### Agent A Prompt` / `### Agent B Prompt` / etc. No commentary outside the fences except a 2-line preamble. ~1500-2200 words total. This is the final pass — no more iteration; whatever you emit is what gets launched.
```

---

## Subagent response

Pass 4 final: 5 launch-ready prompts below, each self-contained for parallel dispatch. Synthesis prompt accepts the four agent reports as placeholders.

### Agent A Prompt

```
You are Sub-Agent A. Your scope: Turnkey SaaS prose/HTML editors and browser extensions with AI suggestion UX.

USER REQUEST (verbatim): "I want a turnkey tool that ingests multi-format manuscripts (HTML/PDF/DOCX) and provides an AI agent that proposes concrete edits rendered inline in the original document with a comment thread. Two flows both desired: (F1) Turn-by-turn coaching — agent walks user edit-by-edit, accept/reject/discuss per edit. (F2) Variant walkthrough — agent generates N revised versions, user flips between them in-context. A tool with either is in-scope. Bias: turnkey > plugin > substrate."

ROUTING RULES (defer when out of scope):
- Editor-framework REPOS (ProseMirror, Tiptap, BlockNote, Plate, etc.) → defer to Agent C.
- SaaS apps BUILT ON those frameworks → keep in A.
- Legal-AI redline, academic AI editors (Paperpal, Writefull, Trinka), AI-PDF tools → defer to Agent B.
- Non-English Chinese suites (Tencent Docs AI, WPS AI), translation review, peer-review platforms, Frame.io/Figma → defer to Agent D.
- Browser extensions that overlay AI edits → keep in A.

CHECKLIST (explicitly confirm checked or N/A for each, with one-line note):
Lex.page, Type.ai, Ellipsus, Squibler, AutoCrit, Wordtune, Hyperwrite, Sider, MaxAI, Notion AI, Coda AI, Claude Artifacts, Glasp, Liner, Readwise Reader, Grammarly.

STEPS:
1. Run targeted web searches: "AI suggestions" "track changes" 2025; "walk through" "AI edits" document editor; "Lex.page" agent; "Claude Artifacts" document editing inline; "variant" "rewrite" document editor AI.
2. For each checklist item, locate official site + a demo screenshot/GIF/video or sandbox.
3. Hunt 3-5 non-checklist candidates surfaced by searches.
4. VERIFY before crediting EDIT_UX >= static-diff: open demo/sandbox OR find screenshot/GIF/video showing accept/reject inline UX OR locate README/issues mentioning suggestion, accept, reject, track-changes, inline diff. Marketing copy alone -> cap EDIT_UX at rag-chat and mark `unverified`. Every top-5 row MUST include a demo_url.
5. Exclude: chat-with-PDF RAG without anchored edits, whole-doc rewriters, pure track-changes (no AI), code review tools, generic sticky-note annotators.
6. Recency: active since 2025-01-01. Pre-2025 only if exceptionally relevant; mark "pre-agentic baseline."

BUDGET: max 12 web fetches, max 8 GitHub searches. Stop at 5 verified top picks + 5 honorable mentions.

OUTPUT SCHEMA (8 fields per row): name | url | demo_url | type {turnkey/plugin/substrate} | FMT {html,pdf,docx,md} | ANCHOR {Y/N} | EDIT_UX {none, rag-chat, static-diff, turn-based, variant-walkthrough, both} | CROSS_FMT {Y/Partial/N} | last_active | license_or_pricing | region | gaps_vs_vision | relevance 1-5

RETURN FORMAT (exactly this structure):
## Agent A — Findings
### Top 5 (verified)
<markdown table with all schema fields>
### Honorable Mentions (5)
<markdown table>
### Checklist Status
<bulleted list, one line each: name — checked/N-A — note>
### Themes Noticed
<3-6 bullets on what's converging/diverging in this category>
### Budget Self-Report
web_fetches_used: N/12 ; github_searches_used: N/8
```

### Agent B Prompt

```
You are Sub-Agent B. Your scope: AI-PDF tools, legal redline platforms, and academic AI editors (Paperpal, Writefull, Trinka, Penelope.ai).

USER REQUEST (verbatim): "I want a turnkey tool that ingests multi-format manuscripts (HTML/PDF/DOCX) and provides an AI agent that proposes concrete edits rendered inline in the original document with a comment thread. Two flows both desired: (F1) Turn-by-turn coaching — agent walks user edit-by-edit, accept/reject/discuss per edit. (F2) Variant walkthrough — agent generates N revised versions, user flips between them in-context. A tool with either is in-scope. Bias: turnkey > plugin > substrate."

PDF REALITY DISCLAIMER: True in-context AI diff overlay on PDF is rare and may be empty. Surface the closest approximation and LABEL each PDF tool explicitly with one of:
- sidecar-diff-pane
- annotation-as-suggestion
- redline-overlay
- extracted-text-edit-then-reflow
- rag-chat-only
If the whole category resolves to rag-chat-only, say so plainly in Themes.

ROUTING RULES (defer when out of scope):
- Browser extensions / general prose SaaS / HTML editors → Agent A.
- Editor framework REPOS (PSPDFKit/Nougat are substrate, route to C; Adobe/ChatDOC stay here as turnkey).
- Tencent/WPS/translation review/peer review/Frame.io/Figma → Agent D.

CHECKLIST (explicitly confirm checked or N/A, one-line note each):
Adobe AI Assistant, ChatDOC, Humata, Spellbook, Harvey, Robin AI, Ivo, Athena, Paperpal, Writefull, Trinka, Penelope.ai.

STEPS:
1. Search: "redline with AI" docx; "AI suggestions" PDF 2025; "OSS alternative to Spellbook"; Paperpal track changes; Writefull revise; Trinka edit suggestions; legal AI redline 2025.
2. For each checklist item, find demo evidence (video/GIF/screenshot) showing the actual edit-acceptance UX, not marketing.
3. For every PDF tool, classify with the disclaimer labels above.
4. Hunt 3-5 non-checklist surfaced candidates.
5. VERIFICATION: Before crediting EDIT_UX >= static-diff, open demo/sandbox OR confirm visual evidence of accept/reject inline UX. Marketing copy alone -> cap at rag-chat + `unverified`. Every top-5 row MUST include demo_url.
6. Exclude: chat-with-PDF RAG without anchored edits (UNLESS it's the closest PDF approximation — then include and label rag-chat-only), whole-doc rewriters, pure track-changes, code review tools, generic annotators.
7. Recency: active since 2025-01-01. Pre-2025 only if exceptional.

BUDGET: max 12 web fetches, max 8 GitHub searches. Stop at 5 verified top + 5 honorable mentions.

OUTPUT SCHEMA: name | url | demo_url | type | FMT | ANCHOR | EDIT_UX | CROSS_FMT | last_active | license_or_pricing | region | gaps_vs_vision | relevance 1-5
For PDF tools, append PDF_LABEL field with one of the five disclaimer labels.

RETURN FORMAT:
## Agent B — Findings
### Top 5 (verified)
<table with PDF_LABEL column where applicable>
### Honorable Mentions (5)
<table>
### Checklist Status
<bulleted list>
### PDF Reality Verdict
<one paragraph: is true PDF inline AI diff real, or does category collapse to rag-chat-only / sidecar?>
### Themes Noticed
<3-6 bullets>
### Budget Self-Report
web_fetches_used: N/12 ; github_searches_used: N/8
```

### Agent C Prompt

```
You are Sub-Agent C. Your scope: OSS substrate and editor frameworks — repos you'd build ON, not buy.

USER REQUEST (verbatim): "I want a turnkey tool that ingests multi-format manuscripts (HTML/PDF/DOCX) and provides an AI agent that proposes concrete edits rendered inline in the original document with a comment thread. Two flows both desired: (F1) Turn-by-turn coaching — agent walks user edit-by-edit, accept/reject/discuss per edit. (F2) Variant walkthrough — agent generates N revised versions, user flips between them in-context. A tool with either is in-scope. Bias: turnkey > plugin > substrate."

NOTE: User bias is turnkey > plugin > substrate, so your category is intentionally low-priority — but it's the "Build on top" tier in synthesis. Be honest about assembly cost.

ROUTING RULES:
- Hosted SaaS built ON these frameworks (e.g., a Tiptap-based commercial editor) → Agent A.
- Legal/academic AI built on frameworks → Agent B.
- Non-English / Tencent / WPS → Agent D.
- If a framework has both an OSS core AND a commercial cloud, cover the OSS core here; flag the cloud variant for A or B.

CHECKLIST (explicitly confirm checked or N/A, one-line note each):
ProseMirror, Tiptap (incl. Tiptap AI Suggestions), CKEditor (incl. Track Changes + AI Assistant), BlockNote, Plate, Affine, Hypothes.is, PSPDFKit, Recogito, Nougat.

STEPS:
1. GitHub queries:
   - `tiptap ai suggestions in:readme pushed:>2025-01-01`
   - `prosemirror "track changes" OR "suggest mode" in:readme pushed:>2025-01-01`
   - `(pdf OR docx) "ai redline" OR "ai suggestions" in:readme pushed:>2025-01-01`
   - `topic:ai-editor pushed:>2025-01-01`
   - `"accept/reject" llm editor in:readme`
2. For each checklist item, locate repo + a demo or example showing AI suggestion / accept-reject UX.
3. Hunt 3-5 non-checklist OSS repos (e.g., Yjs collab + AI suggestion plugins, novel.sh, lexical AI forks).
4. VERIFICATION: Before crediting EDIT_UX >= static-diff, open demo OR find screenshot/GIF/video OR find README/issue mentions of suggestion/accept/reject/track-changes/inline diff. README-only claims with no code path -> cap rag-chat + `unverified`.
5. Note last commit date, license, stars, and what assembly is required to reach F1/F2.
6. Exclude: pure rich-text editors with no AI hook; abandoned repos (last commit pre-2025-01-01 unless exceptional).

BUDGET: max 12 web fetches, max 8 GitHub searches. Stop at 5 verified top + 5 honorable mentions.

OUTPUT SCHEMA: name | url | demo_url | type {substrate/plugin} | FMT | ANCHOR | EDIT_UX | CROSS_FMT | last_active | license_or_pricing | region | gaps_vs_vision | relevance 1-5

RETURN FORMAT:
## Agent C — Findings
### Top 5 (verified)
<table>
### Honorable Mentions (5)
<table>
### Checklist Status
<bulleted list>
### Assembly Cost Notes
<bulleted list: for each top-5, what would need to be built to reach F1 or F2>
### Themes Noticed
<3-6 bullets>
### Budget Self-Report
web_fetches_used: N/12 ; github_searches_used: N/8
```

### Agent D Prompt

```
You are Sub-Agent D. Your scope: non-English suites (Tencent Docs AI, WPS AI) FIRST-CLASS, translation review, academic peer review, and adjacent UX inspiration (Frame.io, Figma comments).

USER REQUEST (verbatim): "I want a turnkey tool that ingests multi-format manuscripts (HTML/PDF/DOCX) and provides an AI agent that proposes concrete edits rendered inline in the original document with a comment thread. Two flows both desired: (F1) Turn-by-turn coaching — agent walks user edit-by-edit, accept/reject/discuss per edit. (F2) Variant walkthrough — agent generates N revised versions, user flips between them in-context. A tool with either is in-scope. Bias: turnkey > plugin > substrate."

IMPORTANT: Tencent Docs AI and WPS AI are first-class candidates, not afterthoughts. Chinese-language UX often leads on inline-AI-edit patterns. Use Chinese-language queries.

ROUTING RULES:
- English SaaS prose editors / extensions → Agent A.
- Legal-AI / academic AI English-language (Paperpal etc.) → Agent B.
- OSS frameworks → Agent C.
- Authorea, PubPub, eLife Sciety, Frame.io, Figma comments stay here as peer-review / adjacent-UX inspiration.

CHECKLIST (explicitly confirm checked or N/A, one-line note each):
Tencent Docs AI (智能修订), WPS AI (润色), Smartling, Crowdin, Lokalise, Phrase, PubPub, eLife Sciety, Authorea, Frame.io, Figma comments.

STEPS:
1. Search English + Chinese:
   - `Tencent Docs AI 智能修订`
   - `WPS AI 润色`
   - `腾讯文档 AI 修改建议`
   - "AI suggestions" translation review CAT tool 2025
   - "AI redline" Smartling OR Crowdin OR Phrase
   - eLife Sciety AI review; Authorea AI; PubPub AI
   - Frame.io comment threads; Figma comments AI
2. For each checklist item, find demo evidence of inline edit-accept UX (or note that it's pure comment-thread inspiration).
3. Hunt 3-5 non-checklist surfaced candidates (e.g., DeepL Write enterprise, Welocalize AI review, ResearchHub).
4. VERIFICATION: Before crediting EDIT_UX >= static-diff, open demo/sandbox OR find screenshot/GIF/video OR documentation showing the actual UX. Marketing copy alone -> cap rag-chat + `unverified`. Every top-5 needs demo_url.
5. For Frame.io / Figma: classify as adjacent-UX inspiration, not direct candidates — still useful for variant-walkthrough or comment-thread patterns. Mark relevance honestly.
6. Exclude: chat-with-PDF RAG without anchored edits, whole-doc rewriters, pure track-changes, code review, generic annotators.

BUDGET: max 12 web fetches, max 8 GitHub searches. Stop at 5 verified top + 5 honorable mentions.

OUTPUT SCHEMA: name | url | demo_url | type | FMT | ANCHOR | EDIT_UX | CROSS_FMT | last_active | license_or_pricing | region | gaps_vs_vision | relevance 1-5

RETURN FORMAT:
## Agent D — Findings
### Top 5 (verified)
<table>
### Honorable Mentions (5)
<table>
### Checklist Status
<bulleted list>
### Adjacent-UX Inspirations
<bulleted list: tools that aren't candidates but show patterns worth stealing>
### Themes Noticed
<3-6 bullets, especially what Chinese-market tools do that Western tools don't>
### Budget Self-Report
web_fetches_used: N/12 ; github_searches_used: N/8
```

### Synthesis Prompt

```
You are the Synthesis Agent. You receive four sub-agent reports (A: turnkey SaaS/extensions, B: AI-PDF + legal + academic AI, C: OSS substrate, D: non-English + translation + peer review + adjacent UX). You do not search the web; you only reconcile.

USER REQUEST (verbatim): "I want a turnkey tool that ingests multi-format manuscripts (HTML/PDF/DOCX) and provides an AI agent that proposes concrete edits rendered inline in the original document with a comment thread. Two flows both desired: (F1) Turn-by-turn coaching — agent walks user edit-by-edit, accept/reject/discuss per edit. (F2) Variant walkthrough — agent generates N revised versions, user flips between them in-context. A tool with either is in-scope. Bias: turnkey > plugin > substrate."

INPUTS:
{{AGENT_A_REPORT}}
{{AGENT_B_REPORT}}
{{AGENT_C_REPORT}}
{{AGENT_D_REPORT}}

RANKING RULE — cross-category Top 10:
1. Primary key: relevance (1-5) descending.
2. Secondary key: EDIT_UX strength, ordered: `both` > `variant-walkthrough` ≈ `turn-based` > `static-diff` > `rag-chat`.
3. Tiebreaker: turnkey > plugin > substrate (matches user bias).
4. Tiebreaker 2: cross-format support (Y > Partial > N).
5. Drop any entry marked `unverified` from the Top 10 — push to Watch.

READINESS GROUPS (assign every Top-10 entry to exactly one):
- "Use today" — turnkey, demoed, hits at least F1 or F2 on at least one of {html, pdf, docx}.
- "Use with assembly" — turnkey/plugin but missing one piece (e.g., needs export pipeline or single-format).
- "Build on top" — OSS substrate; concrete assembly path to F1/F2.
- "Watch" — promising but unverified, early, or pre-2025.

GAP CALLOUTS (mandatory):
- For each format in {html, pdf, docx}: if zero verified turnkey hits, call it out by name as a market gap.
- If PDF resolves entirely to rag-chat-only or sidecar-diff-pane with no true inline overlay, include an explicit Honesty Note quoting Agent B's PDF Reality Verdict.

DEDUPLICATION:
- If A and B both surface the same tool (e.g., a hybrid prose+legal editor), keep one entry and note the cross-reference.
- If C surfaces an OSS core whose hosted variant appears in A or B, keep both but link them.

HARD CAP: 40 candidates total across all agents; if exceeded, trim honorable mentions first.

RETURN FORMAT (exactly this structure):
## Cross-Category Top 10
<numbered list, each row showing: rank | name | category (A/B/C/D) | type | FMT | EDIT_UX | relevance | demo_url | one-line why-it-ranks>

## Readiness Groups
### Use Today
<bulleted list>
### Use With Assembly
<bulleted list with the one missing piece per entry>
### Build On Top
<bulleted list with assembly-cost note>
### Watch
<bulleted list with unverified / early / pre-2025 reason>

## Gap Callouts
- HTML: <verified hits count, gap statement>
- PDF: <verified hits count, gap statement>
- DOCX: <verified hits count, gap statement>

## PDF Honesty Note
<quote or paraphrase Agent B's PDF Reality Verdict; state plainly if true inline AI-diff on PDF does not exist in the wild>

## Cross-Agent Themes
<5-8 bullets on patterns visible only when looking at all four reports together — e.g., does the Chinese market lead, is the OSS layer maturing, does legal-AI converge with prose-AI, where do F1 and F2 actually both ship>

## Recommended Next Action for User
<2-3 sentences: given the bias turnkey > plugin > substrate, what's the single best move — pick one Top-10 tool, run a trial, and what to validate first>
```