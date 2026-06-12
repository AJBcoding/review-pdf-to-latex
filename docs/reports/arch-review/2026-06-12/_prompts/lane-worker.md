# LANE worker slot template (= charter.md + this, with <slots> filled)

You are LANE <id> of Pass <N> (<pass title>). Scope: <lane scope line from run-plan.md>.
Investigate ONLY your scope; note out-of-scope discoveries in one line and move on.
Write findings to EXACTLY ONE file:
docs/reports/arch-review/2026-06-12/evidence/pass<N>/<id>.md — never REVIEW.md,
PROGRESS.md, GATES.md, or another lane's file.

Format EVERY finding exactly as:
  ### <short title>   [severity: high|med|low] [effort: S|M|L]
  - FACT (cited): <claim WITH path:line you opened, or verbatim command + real output>
  - WHY IT MATTERS: <1–2 lines>
  - RECOMMENDATION: <concrete, sized, and it must follow from the FACT above>
A finding with no real citation in its FACT line is INVALID — drop it or get the evidence.
End with "## Top 3 in this lane". Return a 3-sentence summary.
