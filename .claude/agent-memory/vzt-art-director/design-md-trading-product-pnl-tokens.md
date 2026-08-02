---
name: design-md-trading-product-pnl-tokens
description: The recurring MTM/trading-product palette failure — direction (buy/sell) vs status (success/destructive) channels half-merged, and money without tabular figures
metadata:
  type: project
---

When extracting a DESIGN.md for a **trading product**, always check the direction-vs-status channel split explicitly and write the verdict plainly.

**Why:** the web sibling `mtm-hub` had NO profit/loss tokens at all — only `--destructive` — so losses and delete buttons shared a colour. `mtm-mobile` is the opposite case and shows the *other* failure mode: it has real `buy`/`sell`/`neutral` tokens plus a centralised `pnlColor()` helper, but `buy` is byte-identical to `success` (`#22C55E`) while `sell` (`#EF4444`) is a *different* red from `destructive` (`#DC2828`). Direction and status are half-merged in both directions. Neither repo derived this on its own; it is inherited drift from a web port.

**How to apply:** in the `## Colors` section, state which of the two channels each token belongs to (market vs system), and flag any collision as a ⚠️ callout with an explicit "do not resolve this unilaterally" — collapsing `sell` into `destructive` to tidy the palette is a plausible-looking change that destroys real meaning. Also check `pnlColor()`-style helpers for *bypass*: mtm-mobile's helper is used in 4 files while `JournalStats.tsx` re-implements the same ternary inline 9 times.

Second invariant for any money surface: **tabular figures**. Both web and RN default to proportional numerals, so currency columns jitter row to row. Count `tabular-nums` / `font-variant-numeric` and ratchet it UP. Pair with right-alignment and an explicit sign convention (mtm-mobile's `makeCurrencyFormatter` formats `Math.abs()` and prepends `+`/`-` itself — the correct pattern).

Related: [[design-md-react-native-gate]]
