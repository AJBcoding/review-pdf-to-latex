# Existing-tools survey — 2026-05-16

**Recovered 2026-05-17** from Claude episodic memory (subagent transcripts of session `3013a85f`, Python419 project, 2026-05-16 18:35–19:32 PDT). This is the research that immediately preceded the brainstorm session in which `review-pdf-to-latex` was conceived — the "market survey of OSS document-review tooling" referenced by `docs/research/2026-05-16-superdoc-fit-analysis.md`.

## What was asked

> "can you deploy 4 sub agents to search github and the web and see if anyone has created an html based review tool for html, pdf or other word documents — the idea would be that you see the html doc or pdf that you're editing — and you can place comments or notes and then in particular an agent could provide different versions of the document or walk you through fixes or edits allowing you to see the change in the comment in context. — RUN THIS PROMPT THROUGH A 4 pass Ralph loop in sub agents before we execute the search"

— AJB, 2026-05-16 18:42 PDT

## Process

Two-stage workflow under the `superpowers:dispatching-parallel-agents` skill:

1. **Ralph loop** (passes 1–4) refined the search brief from a one-line ask into 5 launch-ready agent prompts.
2. **4 search agents** ran in parallel against the web + GitHub:
   - Agent A — turnkey SaaS prose editors + browser extensions
   - Agent B — AI PDF readers and legal redline tools
   - Agent C — OSS substrate frameworks
   - Agent D — non-English suites and adjacent UX (CAT tools, etc.)
3. **Synthesis agent** merged the four reports into a Top-10 + readiness groups + gap callouts.

## Vision the agents were testing against

A tool that ingests an HTML/PDF/DOCX manuscript and provides an AI agent that proposes concrete edits **rendered inline in the original document with a comment thread**, supporting either or both of:

- **F1 — Turn-by-turn coaching:** agent walks user edit-by-edit, accept/reject/discuss per edit.
- **F2 — Variant walkthrough:** agent generates N revised versions; user flips between them in-context.

## Headline findings

| | |
|---|---|
| Verified F1+F2 (turnkey, both flows) | **WPS AI**, **Sudowrite** |
| Verified F1 only (turnkey) | Harvey for Word, Spellbook, Trinka, Type.ai, Coda AI Reviewer, Wordtune |
| Verified F1 on **PDF ingest** | **Revise (revise.io)** — the *only* turnkey hit with first-class PDF ingest |
| OSS substrate for F1 | **Plate (udecode)** — 3–6 eng-weeks to F1; comment threads native |
| Out of scope (rag-chat only on PDF) | Adobe AI Assistant, ChatDOC, Humata |
| Watch list | SuperDoc, Microsoft Word native AI redlining, Ivo Review 2.0, q.e.d Science, Tiptap AI Suggestion, prosemirror-changeset |

**Plain finding:** "Inline AI-diff on PDF does not exist in the wild as of 2026-05." — Agent B's verdict, retained by the synthesis. Every PDF-native AI tool surveyed collapses to rag-chat. This is the gap `review-pdf-to-latex` is built into.

## How this informed the project

The brainstorm session (`0386c45f`, 2026-05-16 19:35 PDT, immediately following) drew on this survey to:

- Reject SuperDoc as a substrate (full analysis at `../2026-05-16-superdoc-fit-analysis.md`) — DOCX-only doesn't fit PDF+LaTeX.
- Implicitly reject the rest of the OSS substrate path (Plate / BlockNote / Tiptap / ProseMirror) — too much assembly weight (3–6 eng-weeks) for a single-user tool, and none ingest PDF.
- Justify the "sidecar + vanilla HTML viewer + Claude in the terminal" pattern: the gap the survey identified (inline AI-diff on PDF with comment threads + F1 walkthrough) didn't exist as a product, and building it on a heavy substrate was uneconomical.

## Files in this folder

| File | Source subagent | Content |
|---|---|---|
| `synthesis-merged-report.md` | a250735f | Top-10, readiness groups, gap callouts, cross-agent themes |
| `agent-A-turnkey-saas-editors.md` | a0f2530c | Sudowrite, Wordtune, Type.ai, Coda AI Reviewer, Lex.page, Revise.io |
| `agent-B-ai-pdf-and-legal-redline.md` | acc486e7 | Harvey, Spellbook, Trinka, Ivo Review, Humata, Adobe AI |
| `agent-C-oss-substrate-frameworks.md` | adbda0d6 | Plate, BlockNote, Tiptap, ProseMirror, SuperDoc, Slate, Lexical |
| `agent-D-non-english-and-adjacent-ux.md` | a83658b5 | WPS AI, Tencent Docs, Lokalise, Crowdin, Phrase, XTM |
| `ralph-pass-1-initial-brief.md` | af219624 | First-draft search brief |
| `ralph-pass-2-critique.md` | a80b88c5 | Critique → V2 brief (introduces F1/F2 framing) |
| `ralph-pass-3-critique-v2.md` | a0a6f225 | Critique → V3 brief (tightens capability matrix) |
| `ralph-pass-4-launch-prompts.md` | a2d76a8a | Final 5 launch-ready agent prompts |

All files were extracted verbatim (last assistant message of each subagent transcript) from `~/.claude-accounts/anthony/.claude/projects/-Users-anthonybyrnes-PycharmProjects-Python419/3013a85f-a1d7-4f79-97da-e895a9941906/subagents/`. The episodic transcripts themselves remain in place; this folder is the durable copy.
