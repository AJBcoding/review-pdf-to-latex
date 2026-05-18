# Ralph pass 1: initial draft of the search brief

_Recovered from Claude episodic memory — subagent transcript `agent-af2196242bff` of session `3013a85f` (2026-05-16, PDT)._

---

## Orchestrator prompt fed into this pass

```
You are Pass 1 of a 4-pass Ralph refinement loop. Your job is NOT to do any searching. Your only job is to produce a precise, well-scoped **search brief** that 4 parallel search agents will later execute against GitHub and the open web.

The user's raw request (verbatim):

> "search github and the web and see if anyone has created an html based review tool for html, pdf or other word documents - the idea would be that you see the html doc or pdf that you're editing - and you can place comments or notes and then in particular an agent could provide different versions of the document or walk you through fixes or edits allowing you to see the change in the comment in context."

Decompose this into a structured search brief. Cover:

1. **Core capability matrix** — list the distinct capabilities the user is asking about (e.g., document viewer, inline annotation, AI-driven revision suggestions, version comparison/diff overlay, in-context preview of proposed edits, multi-format support across HTML/PDF/DOCX). For each capability, write 1 sentence on what "good" looks like.

2. **Likely product/repo categories** to search across — e.g., "PDF annotation libraries," "Hypothes.is-style web annotation," "AI document review SaaS," "Word/Google Docs Suggest Mode clones," "redline/track-changes tools," "AI-assisted editing IDEs for docs," "LLM-powered manuscript review tools."

3. **Search query candidates** — produce ~15 concrete search strings, mixing GitHub-flavored (`stars:>50 topic:annotation`, etc.) and Google-flavored ("AI agent inline document review comments in-context"). Include synonyms (annotate, redline, markup, review, suggest, comment) and AI-era terms (agent, LLM, copilot).

4. **Disambiguators** — what should results NOT be? (e.g., "this is not just a PDF viewer; not a plain comment thread; not pure track-changes without AI; not a code review tool"). The user wants the *agent walks you through changes in context* angle to be central.

5. **Output schema** — define exactly what each of the 4 downstream search agents should return per finding: name, URL, stars/age (if GH), what it does, multi-format support, AI/agent integration, in-context-diff capability, license, last commit date, gaps vs. user's vision.

6. **Division of labor across 4 agents** — propose a non-overlapping split (e.g., Agent A = GitHub open-source annotation libs; Agent B = GitHub AI-document-review/copilot projects; Agent C = web/SaaS commercial tools; Agent D = adjacent ecosystems — Hypothes.is, Manubot, prose-AI, academic peer-review platforms, Substack/Ghost-style editorial tools).

Return the search brief as a single markdown document, ~600-900 words. Be concrete. Do not preamble. Do not search the web. Pass 2 will critique your output.
```

---

## Subagent response

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

Each downstream agent returns findings as a markdown table or JSON list with these fields:

```
- name:                       (string)
- url:                        (canonical repo or product URL)
- type:                       (OSS library | OSS app | commercial SaaS | research project)
- stars / age / last_commit:  (GH only; "n/a" for SaaS)
- one_line:                   (what it does in <20 words)
- formats_supported:          (HTML / PDF / DOCX / MD / other)
- annotation_model:           (anchored inline | margin | overlay | none)
- ai_integration:             (none | chat-only | suggest-mode | agentic-revision)
- in_context_diff:            (yes / partial / no)
- multi_version_walkthrough:  (yes / no)
- license:                    (MIT / Apache / proprietary / etc.)
- gaps_vs_user_vision:        (1-2 sentences on what's missing for C1-C6)
- relevance_score:            (1-5; 5 = direct match)
```

Each agent returns **max 12 findings** ranked by `relevance_score`, plus a 3-bullet "themes I noticed" summary.

## 6. Division of Labor Across 4 Agents

**Agent A — GitHub: OSS annotation & viewer libraries.**
Scope: annotation frameworks (Hypothes.is, Recogito, Annotator.js), PDF.js viewer forks with annotation, ProseMirror/Tiptap/BlockNote suggestion plugins, redline diff libraries. Goal: catalog the *substrate* tools someone could compose into the user's vision. ~10-12 findings.

**Agent B — GitHub: AI-/agent-powered document review projects.**
Scope: repos combining LLMs with document editing — "AI editor," "LLM redline," "agent doc review," Continue.dev/Cursor-analog projects for prose, manuscript-review agents, autonomous-edit demos. Filter for stars >20 OR commits in last 12 months. ~10-12 findings.

**Agent C — Commercial SaaS & closed-source products.**
Scope: Spellbook, Harvey, Robin AI, Ivo, Lex, Sudowrite, Grammarly, Microsoft Editor/Copilot for Word, Adobe AI Assistant for PDF, Draftable, PSPDFKit AI Assistant, Lexis+ AI. Focus on whether they offer in-context agentic walkthroughs across multi-format docs. ~10 findings.

**Agent D — Adjacent ecosystems & research.**
Scope: academic peer-review platforms (Manubot, PubPub, eLife Sciety, Authorea), editorial CMS (Substack/Ghost suggestion features), accessibility/proofreading tools, arXiv comment layers, legal-tech research papers, and any HCI/CSCW prototypes from 2023-2026 describing this exact UX. ~8-10 findings.

Each agent must explicitly note overlap with the others' scope and defer rather than duplicate. Pass 3 will reconcile.