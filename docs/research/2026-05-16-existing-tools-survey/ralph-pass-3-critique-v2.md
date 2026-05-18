# Ralph pass 3: critique V2 of search brief

_Recovered from Claude episodic memory — subagent transcript `agent-a0a6f22546cf` of session `3013a85f` (2026-05-16, PDT)._

---

## Orchestrator prompt fed into this pass

```
You are Pass 3 of a 4-pass Ralph refinement loop. Your job is to **critique Pass 2's V2 search brief and produce an improved V3**. Do NOT run any searches.

Here is V2 verbatim:

---
# Search Brief V2: AI-Agent-Driven In-Context Document Review Tools

## 0. User Intent
User wants **to use a tool**, not build one. They want to drop in a multi-format manuscript (HTML/PDF/DOCX), have an AI agent **walk them turn-by-turn through proposed revisions**, see each edit rendered in the original document with a comment thread, and step through variant versions. Bias toward **ready-to-use products** over assemble-it-yourself libraries.

## 1. Capability Matrix (7 capabilities)
C1a Flow-text rendering / C1b Fixed-layout PDF rendering / C2 Anchored inline annotation / C3 Agent-proposed concrete edits / C4 In-context diff overlay / C5 Variant walkthrough / C6 Turn-based agent dialogue per edit / C7 Cross-format unification.

## 2. Categories
Agentic prose editors (Lex.page, Cursor-for-docs, Claude Artifacts, Notion AI, Coda AI, Mem, Reflect, Wordtune, Briefly); AI PDF review (Adobe AI Assistant, Drawboard, Foxit AI, Kami, Nougat, ChatDOC, Humata, AskYourPDF); legal redline (Spellbook, Harvey, Robin AI, Ivo, Diligen, Lexis+); track-changes + AI plugins (ProseMirror/Tiptap/CKEditor/TinyMCE/BlockNote/Plate/Novel/Affine); academic peer review (PubPub, eLife Sciety, Authorea, Manubot); adjacent timeline-review (Frame.io, Storia, Figma); substrate (Hypothes.is, Recogito, PSPDFKit, Apryse); PKM+AI (Obsidian, Logseq, RemNote); Asian (Tencent Docs AI, WPS AI).

## 3. Search Queries (sharpened, vendor-language)
GitHub: prosemirror+AI, tiptap+AI suggestions, redline+gpt+docx/pdf, pdf-annotation+ai, suggest-mode editors, accept/reject suggestion LLM. Web: "AI suggestions"+"track changes", "redline with AI", AI proofreader+"show changes", Lex.page agent mode, Claude Artifacts document editing, "walk through" AI edits, Adobe Acrobat AI Assistant, Tencent Docs AI, OSS Spellbook alternative.

## 4. Disambiguators
Exclude: chat-with-PDF RAG without anchored edits; whole-doc rewriters; pure track-changes; code review tools; plain PDF + sticky notes. Central wedge: agent proposes concrete edit → renders in doc with explanation → accept/reject/variant → advance.

## 5. Recency Filter
Active since 2025-01-01 (commits, releases, AI feature launches). Pre-2025 = "pre-agentic baseline."

## 6. Output Schema (per finding)
name, url, type, last_active, formats, C1a-C7 (Y/Partial/N), license_or_pricing, buildability {turnkey/plugin/substrate}, region, gaps_vs_vision, relevance_score 1-5.

## 7. Output Volume
Top 5 + up to 5 honorable mentions per agent. ≤40 total.

## 8. Division of Labor
A — Turnkey SaaS prose editors. B — AI PDF/redline products. C — OSS libraries & editor frameworks. D — Academia/international/adjacent UX. Routing rules: ProseMirror/Tiptap repos→C always; SaaS on Tiptap→A; OSS legal→B; non-English→D.

## 9. Buildability Axis
turnkey / plugin / substrate. User wants turnkey.
---

**Your critique — be rigorous:**

1. **Operational executability.** Can a sub-agent actually run query #2 (`topic:tiptap "ai suggestions" OR "track changes" pushed:>2025-01-01`) on GitHub? The `pushed:` filter is valid GitHub syntax but `topic:` requires exact topic match — many relevant repos may not have set those topics. Should we add `in:readme` variants?

2. **Verification commands missing.** The brief doesn't tell agents *how to verify a candidate satisfies C3/C4*. Without instructions like "read the README's GIF/screenshot section, look for 'accept/reject' UI screenshots, check the demo URL," sub-agents will rely on marketing claims and over-credit tools. Add a verification protocol.

3. **The "walk you through" UX is still under-specified.** Re-read the user's words: "an agent could provide different versions of the document or walk you through fixes or edits allowing you to see the change in the comment in context." Two distinct UX flows are implied: (a) batch-generate variants user can flip between, and (b) sequential turn-by-turn coaching. C5 covers (a) and C6 covers (b), but the relative weight matters — which is the load-bearing UX? Should agents flag both vs. either?

4. **PDF realism check.** Be honest: very few tools actually do C4 in PDF (overlaid diff). Adobe AI Assistant doesn't. Most "AI PDF" tools are RAG-chat. Should V3 explicitly call out that PDF-with-true-in-context-diff is a **rare/possibly-empty category**, and instruct Agent B to surface "closest approximation" (sidecar diff pane, annotation-as-suggestion, redaction-overlay) rather than return nothing?

5. **Missing names that should be checked.** Look hard at: Kortext, Type.ai, Ellipsus, Squibler, AutoCrit, Writefull (academic), Trinka, Paperpal, Penelope.ai, Recurse, Goblin Tools, Hyperwrite, Sider, MaxAI, "Cursor for Writers" startups, Granola (meeting notes adjacent), Athena AI for legal, Smartling for translation review (parallel-text + suggestion), Crowdin (translation), Lokalise (translation), Phrase. Should V3 add an explicit "high-priority candidates checklist" agents must check by name?

6. **Browser extension category missing.** Tools like Glasp, Liner, Readwise Reader (with AI), Wordtune extension, Grammarly extension can annotate any HTML page — this is *exactly* the user's stated workflow for HTML docs. Where do these go? Add a category or assign to Agent A?

7. **Region asymmetry.** Agent D owns China/Japan/EU. But Tencent/WPS AI may be better-matched than Western tools to "agent walks you through edits" UX. Should V3 elevate this rather than treating it as adjunct?

8. **Output schema bloat.** 14 columns is too many for a human to scan. Compress: collapse C1a+C1b into "formats," collapse C3+C4+C5+C6 into "agent-edit UX (none/RAG-chat/static-diff/turn-based/variant-walkthrough)" with a categorical value.

9. **The "show me the goods" requirement.** Agents should include a **demo URL or video link** for each top-5 finding, not just a product homepage. Otherwise the user has to chase down whether the tool actually does what's claimed.

10. **Final synthesis missing.** After Agents A-D return, who synthesizes? V2 doesn't specify a merge protocol. Should V3 include a synthesis step (rank cross-category top-10, group by readiness)?

11. **Token budget for sub-agents.** Searching the web is expensive. Should V3 cap each agent's tool calls / web fetches? E.g., "max 10 web fetches per agent, prioritize candidate by candidate."

Produce **V3 of the search brief** incorporating these critiques. Same ~600-1000 word target. Be concrete. Pass 4 will do final polish and emit the launch-ready brief.
```

---

## Subagent response

# Search Brief V3: AI-Agent-Driven In-Context Document Review Tools

## 0. User Intent (Load-Bearing UX)
User wants **to use a tool** (turnkey > plugin > substrate) that ingests a multi-format manuscript (HTML/PDF/DOCX) and provides an AI agent that **proposes concrete edits rendered inline in the original document with a comment thread**. Two flows are both desired, weighted equally — flag tools that do **either**:
- **(F1) Turn-by-turn coaching**: agent walks user edit-by-edit, accept/reject/discuss per edit.
- **(F2) Variant walkthrough**: agent generates N revised versions; user flips between them in-context.

A tool with only (F1) or only (F2) is still high-value. A tool with neither is out of scope.

## 1. Capability Matrix (compressed)
- **FMT**: which inputs render natively — {html, pdf, docx, md}
- **ANCHOR**: anchored inline annotation? {Y / N}
- **EDIT_UX** (categorical, load-bearing): `none` / `rag-chat` / `static-diff` / `turn-based` (F1) / `variant-walkthrough` (F2) / `both`
- **CROSS_FMT**: unified UX across formats? {Y / Partial / N}

## 2. Categories & Agent Routing
- **Agent A — Turnkey SaaS prose/HTML editors + browser extensions** (Lex.page, Type.ai, Ellipsus, Squibler, Wordtune, Hyperwrite, Sider, MaxAI, Glasp, Liner, Readwise Reader, Grammarly, Notion AI, Coda AI, Mem, Reflect, Claude Artifacts, Cursor-for-docs clones).
- **Agent B — AI PDF + legal redline** (Adobe AI Assistant, Drawboard, Foxit AI, Kami, ChatDOC, Humata, AskYourPDF, Spellbook, Harvey, Robin AI, Ivo, Athena, Diligen, Lexis+, Paperpal, Writefull, Trinka, Penelope.ai).
- **Agent C — OSS substrate / editor frameworks** (ProseMirror, Tiptap, CKEditor, TinyMCE, BlockNote, Plate, Novel, Affine, PSPDFKit, Apryse, Hypothes.is, Recogito, Nougat).
- **Agent D — Non-English + adjacent UX** (Tencent Docs AI, WPS AI, Smartling, Crowdin, Lokalise, Phrase, PubPub, eLife Sciety, Authorea, Frame.io, Figma comments). **Elevated**: Tencent/WPS AI may match (F1) better than Western tools — Agent D returns these as **first-class**, not adjuncts.

Routing rules: editor-framework repo → C; SaaS-built-on-framework → A; legal-AI → B; non-English or translation-review → D; browser extensions → A.

## 3. PDF Reality Disclaimer
**True in-context diff overlay on PDF is rare/possibly empty.** Agent B must NOT return empty — instead surface the closest approximation and label it: `sidecar-diff-pane` / `annotation-as-suggestion` / `redline-overlay` / `extracted-text-edit-then-reflow` / `rag-chat-only`. Honesty over coverage.

## 4. Search Queries (executable)

**GitHub** (combine `topic:` with `in:readme` and `in:description` since many repos lack topics):
- `tiptap ai suggestions in:readme pushed:>2025-01-01`
- `prosemirror "track changes" OR "suggest mode" in:readme pushed:>2025-01-01`
- `(pdf OR docx) "ai redline" OR "ai suggestions" in:readme pushed:>2025-01-01`
- `topic:ai-editor pushed:>2025-01-01`
- `"accept/reject" llm editor in:readme`

**Web** (Google / DuckDuckGo, prefer 2025+ results):
- `"AI suggestions" "track changes" 2025`
- `"redline with AI" docx site:*.com -site:adobe.com`
- `"walk through" "AI edits" document editor`
- `"Lex.page" agent OR "suggest mode"`
- `"Claude Artifacts" document editing inline`
- `Tencent Docs AI 智能修订` / `WPS AI 润色 走查`
- `"OSS alternative to Spellbook"`
- `"variant" "rewrite" document editor AI`

## 5. Verification Protocol (mandatory before crediting)
Before assigning EDIT_UX ≥ `static-diff`, sub-agent **must do at least one of**:
1. Open the tool's **demo/sandbox URL** and observe the UX directly.
2. Find a **screenshot, GIF, or video** (in README, blog post, or YouTube) showing the accept/reject inline UX. Marketing copy alone is insufficient.
3. For OSS: skim README + open issues/PRs for terms `suggestion`, `accept`, `reject`, `track-changes`, `inline diff`.

If only marketing claims found → cap EDIT_UX at `rag-chat` and note `unverified` in `gaps`. **Each top-5 finding must include a `demo_url` field** (sandbox, video, or screenshot link) — not just the homepage.

## 6. Disambiguators (exclude)
- Chat-with-PDF RAG without anchored inline edits → unless it's the closest PDF approximation (Agent B exception).
- Whole-document rewriters with no per-edit walkthrough.
- Pure track-changes without AI proposing.
- Code review tools (GitHub Copilot reviewer, etc.).
- Generic sticky-note PDF annotators.

## 7. High-Priority Candidates Checklist
Each agent must **explicitly confirm checked or not-applicable** for their relevant subset: Lex.page, Type.ai, Ellipsus, Squibler, AutoCrit, Wordtune, Hyperwrite, Sider, MaxAI, Notion AI, Coda AI, Claude Artifacts (A); Adobe AI Assistant, ChatDOC, Humata, Spellbook, Harvey, Robin AI, Ivo, Athena, Paperpal, Writefull, Trinka, Penelope.ai (B); ProseMirror, Tiptap, CKEditor, BlockNote, Plate, Affine, Hypothes.is, PSPDFKit (C); Tencent Docs AI, WPS AI, Smartling, Crowdin, Lokalise, Phrase, PubPub, eLife Sciety (D). Plus extensions: Glasp, Liner, Readwise Reader, Grammarly (A).

## 8. Output Schema (per finding, 8 fields)
`name | url | demo_url | type {turnkey/plugin/substrate} | FMT | ANCHOR | EDIT_UX | CROSS_FMT | last_active | license_or_pricing | region | gaps_vs_vision | relevance 1-5`

## 9. Token & Tool Budget
Per sub-agent: **max 12 web fetches, max 8 GitHub searches**. Prioritize candidates from §7 checklist before exploratory queries. Stop when you have 5 verified top picks + 5 honorable mentions. ≤40 findings total across all agents.

## 10. Recency
Active since **2025-01-01** (commits, releases, AI feature launches). Pre-2025 = "pre-agentic baseline," include only if exceptionally relevant.

## 11. Synthesis Step (post-A/B/C/D)
A **Synthesis pass** merges all four returns and produces:
- **Cross-category Top 10**, ranked by `relevance` then by `EDIT_UX` strength (`both` > `variant-walkthrough` ≈ `turn-based` > `static-diff` > `rag-chat`).
- **Grouping by readiness**: "Use today (turnkey + verified demo)" / "Use with assembly (plugin + framework)" / "Build on top (substrate)" / "Watch (announced, not shipped)."
- **Gap callout**: any of {html, pdf, docx} with zero verified turnkey hits → flag as "user must assemble."
- **Honesty note**: if PDF category resolves to only `rag-chat` / `sidecar-diff`, say so plainly.

## 12. Volume
Top 5 + 5 honorable mentions per agent. Synthesis returns final cross-cut Top 10 + readiness groups. Hard cap: 40 candidates evaluated.