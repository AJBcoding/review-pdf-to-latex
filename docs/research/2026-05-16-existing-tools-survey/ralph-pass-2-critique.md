# Ralph pass 2: critique and tighten V1

_Recovered from Claude episodic memory — subagent transcript `agent-a80b88c5f96d` of session `3013a85f` (2026-05-16, PDT)._

---

## Orchestrator prompt fed into this pass

```
You are Pass 2 of a 4-pass Ralph refinement loop. Your job is to **critique Pass 1's search brief and produce an improved Version 2**. Do NOT run any searches yourself.

Here is Pass 1's output verbatim:

---
# Search Brief: AI-Agent-Driven In-Context Document Review Tools

## 1. Core Capability Matrix

The user's vision combines six distinct capabilities. A candidate tool ideally hits 4+ of these.

| # | Capability | What "good" looks like |
|---|---|---|
| C1 | **Multi-format document viewer** | Renders HTML, PDF, and DOCX faithfully in-browser with the same UI shell, preserving layout/styling rather than flattening to plain text. |
| C2 | **Inline anchored annotation** | User clicks/selects text or a region and drops a comment that stays bound to that anchor across edits and reflows (Hypothes.is/Google Docs-style margin pins). |
| C3 | **AI/agent-generated revision suggestions** | An LLM or agent proposes concrete edits (not just chat replies) scoped to a selection or whole document, with reasoning attached. |
| C4 | **In-context diff/preview overlay** | Proposed edits render *inside* the document view — strikethrough/insert, side-by-side, or accept/reject hunks — not in a separate text pane. |
| C5 | **Multi-version walkthrough** | Agent generates 2+ alternative revisions and the user can step through them in the same viewer (variant A/B/C with diff). |
| C6 | **Conversational guidance per edit** | Each suggested change carries a comment thread explaining *why*; user can ask follow-ups and the agent revises in place. |

## 2. Likely Product / Repo Categories

- Web annotation frameworks (Hypothes.is, Annotator.js, Recogito, Apache Annotator)
- PDF.js-based annotation viewers (PSPDFKit/Nutrient, PDFTron/Apryse, Adobe PDF Embed)
- DOCX/HTML "Suggest Mode" clones (Etherpad, CKEditor track-changes, TinyMCE, ProseMirror/Tiptap with suggestions plugin)
- AI manuscript / writing copilots (Lex, Sudowrite, Type.ai, Grammarly Editor, Microsoft Editor)
- LLM-powered legal/contract redlining (Spellbook, Harvey, Robin AI, Ivo, Diligen)
- Academic peer review platforms (Manubot, PubPub, ScholarOne, eLife Sciety, Authorea)
- Agentic doc workflows (LangChain doc-QA UIs, Continue.dev for prose, Cursor-for-docs analogs)
- Diff/redline viewers (Draftable, Litera Compare, diff2html, redlines library)
- Open-source AI editors (Novel.sh, BlockNote + AI, Plate.js AI plugin, Affine)

## 3. Search Query Candidates

GitHub-flavored:
1. `topic:annotation stars:>100 language:typescript`
2. `"pdf annotation" "ai" OR "llm" stars:>50`
3. `topic:track-changes OR topic:suggest-mode prosemirror`
4. `"document review" agent llm in:readme stars:>20`
5. `topic:redline OR topic:diff "docx" OR "pdf"`
6. `hypothesis annotation fork:false stars:>50`
7. `"inline suggestions" LLM editor prosemirror OR tiptap`
8. `topic:peer-review open-source manuscript`

Google/web-flavored:
9. `"AI agent" "inline edit" "in-context" document review tool`
10. `open source alternative to Spellbook OR "Robin AI" document redline`
11. `LLM "suggest changes" PDF DOCX viewer side-by-side diff`
12. `AI copilot for proofreading "show changes in document" not Word`
13. `agentic document editor "walk through" revisions accept reject`
14. `web-based PDF annotator with GPT suggestions open source`
15. `multi-format (HTML PDF DOCX) AI review tool comments versions`

## 4. Disambiguators — What Results Should NOT Be

Exclude or flag-as-partial:
- **Plain PDF viewers** with no annotation (pdf.js alone, Mozilla viewer).
- **Pure comment threads** with no AI suggestion layer (Disqus, Hypothes.is alone).
- **Track-changes-only** tools with no LLM agent (Litera, classic Word redline).
- **Code review tools** (GitHub PR review, Reviewable, Gerrit) — adjacent but wrong medium.
- **Chat-with-your-PDF** RAG demos where the AI answers questions but cannot propose anchored edits visible in the document.
- **Whole-document rewrite** tools that replace text without showing the diff in context (most ChatGPT-style writing assistants).
- **Single-format** tools (HTML-only or PDF-only) unless they're clearly extensible.

The central wedge is: **agent proposes a concrete edit → user sees the change rendered in the original document with a comment explaining it → user accepts/rejects or asks for an alternate version, in the same view.**

## 5. Output Schema (Per Finding)

(see Pass 1 schema — name, url, type, stars/age, one_line, formats_supported, annotation_model, ai_integration, in_context_diff, multi_version_walkthrough, license, gaps_vs_user_vision, relevance_score 1-5)

## 6. Division of Labor

- Agent A — GitHub OSS annotation & viewer libraries
- Agent B — GitHub AI/agent-powered doc review repos
- Agent C — Commercial SaaS / closed-source
- Agent D — Adjacent ecosystems (academia, editorial, HCI prototypes)
---

**Your critique — be tough. Specifically address:**

1. **PDF-specific gap.** PDF is structurally different from HTML/DOCX (pixel-positioned vs. flow text). Suggestions inside a PDF are dramatically harder than in HTML. Does the brief separate "PDF" from "flow-text formats" enough? Should there be a 7th capability or split categories?

2. **The "agent walks you through" UX.** The user emphasized *walking through* fixes. This is closer to a chat/turn-based UX than a static diff. Is this captured? Should we add tools like Cursor's agent mode for docs, "Lex" agent mode, "Claude Artifacts" for documents?

3. **Search query weaknesses.** Several queries are too generic (#1, #4) and will drown in noise. Several quoted phrases like `"in-context"` may not actually appear in product copy. Suggest replacements grounded in how vendors actually market this.

4. **Missing categories.** What about: Notion AI, Coda AI, Mem.ai, Reflect, Lex.page, Github Copilot for Docs (cancelled but research), Adobe Acrobat AI Assistant, DocuSign Insight, Briefly, Wordtune, Stripe Atlas legal review, Goodnotes/Highlights for PDF, RemNote, Logseq, Obsidian + AI plugins, "Storia" video review (as analog), Frame.io for documents?

5. **Geographic/language scope.** Should we explicitly include Chinese, Japanese, European tools? (Tencent Docs, WPS AI, Drawboard PDF — Australia, etc.)

6. **Time horizon.** The agentic-doc-review space exploded post-late-2024. Should we hard-bias to projects active since 2025-01? Add explicit recency filter.

7. **Agent overlap.** Pass 1's split risks Agent A and Agent B both finding ProseMirror/Tiptap+AI plugins. Tighten the boundaries with explicit "if you find X, route to Agent N."

8. **Output volume.** 12 findings per agent × 4 = 48 results. Likely too many to digest. Should each agent rank top 5 + "honorable mentions"?

9. **What's the user actually likely to do with this?** Reading between the lines, they probably want to *use one*, not *build one*. So bias toward usable products over libraries-to-compose. Add a "buildability" axis if recommending a substrate-stack.

Produce **Version 2 of the search brief** incorporating your critique. Same structure, same ~600-900 word target. Be concrete. Pass 3 will critique you next.
```

---

## Subagent response

# Search Brief V2: AI-Agent-Driven In-Context Document Review Tools

## 0. User Intent (new — frames everything)

The user wants **to use a tool**, not build one. They want to drop in a multi-format manuscript (HTML/PDF/DOCX), have an AI agent **walk them turn-by-turn through proposed revisions**, see each edit rendered in the original document with a comment thread, and step through variant versions. Bias findings toward **ready-to-use products** over assemble-it-yourself libraries. Libraries surface only as a fallback "buildable substrate" tier.

## 1. Capability Matrix (7 capabilities, PDF split out)

| # | Capability | What "good" looks like |
|---|---|---|
| C1a | **Flow-text rendering** (HTML/Markdown/DOCX) | Faithful in-browser render with editable text model. |
| C1b | **Fixed-layout rendering** (PDF) | PDF.js or native render; annotation layer must handle pixel coords AND reflowed text extraction. |
| C2 | **Anchored inline annotation** | Selection-bound comments that survive edits (text-quote + position anchors). |
| C3 | **Agent-proposed concrete edits** | LLM produces edit objects (insert/delete/replace), not free-text suggestions. |
| C4 | **In-context diff overlay** | Edits render inside the document view (strikethrough/insert, accept/reject hunks). For PDF: redaction-style overlay or sidecar diff layer, since text replacement in PDF is structurally hard. |
| C5 | **Variant walkthrough** | Multiple alternative revisions navigable in same viewer. |
| C6 | **Turn-based agent dialogue per edit** *(new emphasis)* | Chat-style "next fix?" UX — agent presents one suggestion, explains, awaits accept/reject/discuss, then advances. Distinct from static diff list. |
| C7 | **Cross-format unification** | Same shell handles all three formats with consistent annotation model. Rare; flag tools that explicitly claim it. |

**Format-aware scoring:** PDF-only and flow-text-only tools are scored against C1a OR C1b (not both); penalize on C7 only if the tool *claims* multi-format and fails.

## 2. Product / Repo Categories (expanded)

- **Agentic prose editors:** Lex.page (agent mode), Cursor-for-docs analogs, Claude Artifacts (doc mode), Notion AI, Coda AI, Mem.ai, Reflect, Wordtune, Briefly.
- **AI PDF review:** Adobe Acrobat AI Assistant, Drawboard PDF, Foxit AI, Kami, Nougat-based viewers, ChatDOC, Humata, AskYourPDF (rate for C3/C4, not just RAG-chat).
- **Legal redline + AI:** Spellbook, Harvey, Robin AI, Ivo, Diligen, Lexis+ AI, Henchman, DocuSign Insight.
- **Track-changes + AI plugins:** ProseMirror/Tiptap suggestion modes with LLM, CKEditor "AI Assistant," TinyMCE AI, Etherpad, BlockNote AI, Plate.js, Novel.sh, Affine.
- **Academic/peer review:** PubPub, eLife Sciety, Authorea, Manubot, ScholarOne; HCI prototypes (CHI/UIST 2024–2026).
- **Adjacent timeline-review UX as analog:** Frame.io (video frame comments), Storia, Figma comments — useful pattern references, not direct fits.
- **Annotation substrate (buildable tier):** Hypothes.is, Recogito, Apache Annotator, PSPDFKit/Nutrient, Apryse.
- **PKM + AI plugins:** Obsidian (Smart Connections, Copilot), Logseq, RemNote — surface only if they support anchored diffs.
- **Asian-market tools:** Tencent Docs AI, WPS AI, Kingsoft, Doc.ai (CN); evaluate even if UI is non-English.

## 3. Search Queries (sharpened — vendor language, not jargon)

GitHub:
1. `topic:prosemirror "ai" OR "llm" suggestion stars:>50 pushed:>2025-01-01`
2. `topic:tiptap "ai suggestions" OR "track changes" pushed:>2025-01-01`
3. `"redline" "gpt" OR "claude" "docx" OR "pdf" in:readme`
4. `topic:pdf-annotation "ai" pushed:>2025-01-01`
5. `"suggest mode" prosemirror OR tiptap OR slate pushed:>2025-01-01`
6. `"accept" "reject" "suggestion" llm editor in:readme stars:>30`

Web/product (use marketing terms, not "in-context"):
7. `"AI suggestions" "track changes" document editor 2025`
8. `"redline with AI" contract review alternative to Spellbook`
9. `"AI proofreader" "show changes" manuscript`
10. `Lex.page agent mode review`
11. `Claude Artifacts document editing review`
12. `"walk through" OR "step through" AI edits document`
13. `Adobe Acrobat AI Assistant comments markup`
14. `Tencent Docs AI suggest mode`
15. `open source Spellbook alternative GitHub`

Drop generic `topic:annotation` / "in-context" queries — too noisy / unused in product copy.

## 4. Disambiguators — Hard Excludes

- **Chat-with-your-PDF RAG** (Humata-style Q&A): include only if they *also* propose anchored edits with diff.
- **Whole-doc rewriters** (vanilla ChatGPT, most "rewrite my essay" tools): exclude — no in-context diff.
- **Pure track-changes** without AI proposer (classic Word, Litera Compare): exclude unless plugin makes it agentic.
- **Code review tools** (GitHub PR, Gerrit): exclude — wrong medium.
- **Plain PDF readers + sticky notes** (Preview, basic pdf.js): exclude.

**Central wedge:** agent proposes a concrete edit → renders in original doc with explanation → user accepts/rejects or asks for variant → agent advances to next fix.

## 5. Recency Filter (new)

Hard bias to projects/products **active since 2025-01-01** (commits, releases, or product launches). The agentic-doc-review space inflected late-2024; older repos are likely stale prototypes. For SaaS, "active since" = released a notable AI feature in 2025+. Flag pre-2025 tools as "pre-agentic baseline."

## 6. Output Schema (per finding)

`name, url, type {SaaS|OSS|research}, last_active, formats {flow|pdf|both}, C1a, C1b, C2, C3, C4, C5, C6, C7 (each Y/Partial/N), license_or_pricing, buildability {turnkey|plugin|substrate}, region {US|EU|CN|JP|other}, gaps_vs_vision, relevance_score 1-5`

## 7. Output Volume

Each agent returns **top 5 + up to 5 honorable mentions**. Total ≤ 40, with the top-5 tier being the actual answer. One-line synthesis required from each agent ranking its top 3.

## 8. Division of Labor (tightened, no overlap)

- **Agent A — Turnkey SaaS prose editors** (Lex, Notion AI, Coda, Wordtune, Claude Artifacts, Cursor-for-docs, Mem, Reflect, Briefly). Owns: any product you can sign up for and use today on HTML/Markdown/DOCX.
- **Agent B — AI PDF/redline products** (Adobe AI, ChatDOC, Humata, Drawboard, Spellbook, Robin AI, Ivo, Harvey, DocuSign, legal redline). Owns: anything PDF-first OR contract-legal-vertical, SaaS or OSS.
- **Agent C — OSS libraries & editor frameworks** (ProseMirror/Tiptap/Slate/BlockNote/Plate/Novel/Affine + AI plugins, Hypothes.is, Recogito, Etherpad). Owns: things you'd compose to build it yourself.
- **Agent D — Academia, international, adjacent UX** (PubPub, eLife, CHI/UIST 2024–2026 prototypes; Tencent Docs AI, WPS AI; Frame.io / Storia as timeline-review analogs).

**Routing rules:** ProseMirror/Tiptap repos → C always. A SaaS built *on* Tiptap (e.g., Lex) → A. A legal product that happens to be OSS → B. Any non-English-primary tool → D regardless of category.

## 9. Buildability Axis (new)

Tag each finding: **turnkey** (sign up, use today) / **plugin** (drop into existing editor) / **substrate** (compose yourself). User wants turnkey; substrate findings need a justification ("closest architectural match, would need wrapper").