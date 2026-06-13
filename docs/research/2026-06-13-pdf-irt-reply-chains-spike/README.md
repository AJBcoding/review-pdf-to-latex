# Spike S-1 — PDF /IRT reply chains (READ and WRITE halves)

**Bead:** rev-n7 (roadmap N7). **Date:** 2026-06-13. **Status:** done — both halves pass programmatically; one manual Acrobat checkbox remains (below).
**Blocks:** rev-l4 (L4 round-trip WRITE adapter). **Gates:** `native.in_reply_to` population + PDF adapter `capabilities.replies` (spec §8, decision D10).

## Question

The 2026-05-21 pdf-lib annotation spike (rev-cvr) proved the §10.4 markup
shapes (Highlight/StrikeOut/Text) and the PDF.js→pdf-lib coord transform, but
a fresh grep over its artifacts (`spike.mjs`, `readback.json`) found **zero
/IRT hits** — reply threading was never exercised. Per the unified-comment-model
spec, that left BOTH halves unproven (spec §8, S-1; challenge issue 3):

- **READ:** can a reply thread be extracted from a threaded PDF — both via a
  pdf-lib walk and via the path the renderer actually uses, pdf.js
  `page.getAnnotations()`?
- **WRITE:** can pdf-lib emit a `/Text` annotation carrying `/IRT` (→ parent)
  + `/RT /R` that displays as a thread and survives a re-save?

The kill ladder hangs on the answers (spec §8):
- WRITE fails → v1 ships replies **read-only**; `capabilities.replies = false`.
- READ also fails → replies are **out of v1 entirely**; `native.in_reply_to`
  stays an optional schema field, populated only when readable.

## Result — BOTH HALVES PASS ✔

Run `node spikes/rev-cvr-pdf-lib/spike-irt.mjs` from `desktop/`. All four
verification passes succeed:

| Pass | What it proves |
|---|---|
| **WRITE → pdf-lib read** | The written `/IRT` chain (parent ← reply-1 ← reply-2) reconstructs exactly. `/RT` = `R` on both replies. |
| **WRITE → pdf.js read** | `page.getAnnotations()` exposes `.inReplyTo` (parent id) + `.replyType` (`'R'`) on both replies — the renderer's read path works. |
| **Round-trip → pdf-lib read** | After a structural re-save, the chain is byte-for-byte intact. |
| **Round-trip → pdf.js read** | pdf.js still parses the thread post-re-save. |

So per the kill ladder: **no rung triggers.** v1 can ship PDF replies
**read AND write**; the PDF adapter sets `capabilities.replies = true`.

### Remaining manual checkbox (inherent to a headless spike)

Headless code cannot open Adobe Acrobat and eyeball its comment panel. The
programmatic proof is strong — well-formed `/IRT` dicts that **pdf.js** (the
same parser our renderer uses) reads as a thread, surviving re-save — but the
final Acrobat-interop confirmation is a one-time manual step:

1. `open -a "Adobe Acrobat" desktop/spikes/rev-cvr-pdf-lib/out-threaded.pdf`
2. Confirm the yellow highlight shows a **2-reply thread** in the comment panel.
3. Add a reply *in Acrobat*, save, then re-run the spike pointed at the
   Acrobat-saved file to confirm round-trip in **both** authoring directions.

If Acrobat does NOT thread `out-threaded.pdf`, the WRITE half regresses to the
read-only rung — but pdf.js threading it is a strong positive signal that it
will. File a bead if the manual check fails.

## How /IRT works (PDF 1.7 §12.5.2) — and the one interop subtlety

A reply is a markup annotation (we use `/Text`) with two extra keys:

| Key | Type | Value |
|---|---|---|
| `/IRT` | **indirect reference** | the annotation being replied to — a `PDFRef`, **not** a string id |
| `/RT` | Name | `/R` = threaded reply (what we want); `/Group` = grouped-not-threaded (don't use) |

`/IRT` chains are **transitive**: reply-2's `/IRT` points at reply-1, whose
`/IRT` points at the parent. A reader must follow the chain, not assume one hop.
The spike writes a depth-2 chain to exercise this.

### The mapping subtlety the renderer must handle

`native.in_reply_to` in the comment model is the **parent's `comment_id`**
(= its `/NM`, or a minted id). But the two read paths surface the parent
differently:

- **pdf-lib walk** — `/IRT` is a `PDFRef`; resolve it and read the parent
  dict's `/NM` directly. (`spike-irt.mjs:readThreadPdfLib`.)
- **pdf.js `getAnnotations()`** — `.inReplyTo` is the parent's **ref-id
  string** (e.g. `"10R"`), NOT its `/NM`. Each annotation also carries `.id`
  (its own ref-id string). So the renderer must build an `id → comment_id`
  map in one pass over the annotations, then resolve `.inReplyTo` through it.

The spike's `threaded.readback.json` shows both views agreeing on the ref keys
(`8R…12R`), so the mapping is mechanical:

```
pdf.js: reply-1.id="11R", reply-1.inReplyTo="10R"
        parent.id="10R",  parent.NM="spike-irt-parent"
   ⇒ native.in_reply_to(reply-1) = comment_id of "10R" = "spike-irt-parent"
```

This is the single non-obvious bit the L4 read+display adapter must get right.
Annotations authored without an `/NM` (Acrobat usually writes one; pdf-lib does
not by default) fall back to a minted id keyed by the ref string — so the
WRITE half sets `/NM` on every annotation it emits to keep ids stable across
re-saves.

## Handoff to rev-l4 (round-trip WRITE adapter)

The adapter at `desktop/main/pdf-comments.ts` (per spec §8) should:

1. **WRITE a reply:** build a `/Text` dict per `spike-irt.mjs:addReply` — set
   `/IRT` to the parent annotation's `PDFRef` (register the parent first to
   get its ref), `/RT /R`, and an `/NM` minted from the comment_id. Push onto
   the page `/Annots`. Lift `addReply`/`addHighlight` from the spike.
2. **READ + DISPLAY replies (renderer):** in the `page.getAnnotations()` pass
   (pdf-viewer.ts:204 slot), build the `id → comment_id` map, then set each
   `CommentV2.native.in_reply_to` from `.inReplyTo` via that map; set the card
   stream's thread parent from it. Carry `.replyType` only to distinguish
   `R` (thread) from `Group` (don't thread).
3. Set `capabilities.replies = true` on the PDF adapter.

The spike's builders are factored to lift cleanly into `main/` (PDF mutation
runs in Node, not the renderer) — same as the rev-cvr handoff.

## Files

| Path | Role |
|---|---|
| `desktop/spikes/rev-cvr-pdf-lib/spike-irt.mjs` | Working script — write threaded PDF, read it back (pdf-lib + pdf.js), round-trip, verify |
| `desktop/spikes/rev-cvr-pdf-lib/out-threaded.pdf` | Fixture + 1 highlight with a 2-deep reply chain — open in Acrobat for the manual check |
| `desktop/spikes/rev-cvr-pdf-lib/out-threaded-resaved.pdf` | `out-threaded.pdf` re-saved — round-trip survival artifact |
| `desktop/spikes/rev-cvr-pdf-lib/threaded.readback.json` | Reconstructed thread from both read paths, written + re-saved — the proof record |

## How to run

```
cd desktop
npm install                                   # pdf-lib + pdfjs-dist already in deps
node spikes/rev-cvr-pdf-lib/spike-irt.mjs
```

Expected: four `[verify] … ✔` lines and a `[report]` line. A non-zero exit or a
`ASSERT FAILED` line means a half regressed — consult the kill ladder above.
