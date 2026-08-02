---
name: themeable-tokens-need-a-reach-count
description: A white-label token layer can be fully wired and still reach zero components — always measure consumer counts per token during /vzt-ui extract, never trust the config comment
metadata:
  type: feedback
---

During `/vzt-ui extract`, measure a **consumer count for every token** before describing it as
live. "Declared" and "wired" are not "reached".

**Why:** In `Risk_Management_Platform` (2026-07-30) the white-label colour path was correct at
every link — `brandCssOverrides()` emitted a winning `:root` override from env, and
`tailwind.config.ts` mapped `--accent-red`/`--silver` into utilities via `var()`. The config even
carried a comment asserting per-client theming worked. But **0 of 80 `.tsx` files used the
resulting classes**; every brand surface was a literal `red-600`. Setting the tenant's brand
colour changed nothing on screen. 6 of the repo's 9 custom properties had zero consumers, and
`body` restated their values as literals. A DESIGN.md written from the config comment would have
told every future agent that theming worked, and sent them to edit a token that changes nothing.

**How to apply:** For each token, run both `grep -rIF "var(--<name>"` and a grep for its Tailwind
utility form, and record the count in the frontmatter next to the value. Where the count is 0, say
so in `## Known gaps` and add an **inverse ratchet** gate (count must never go DOWN, baseline 0) so
converting literals into themeable classes is the measured direction of travel. Also watch for
*name traps* that inflate a naive grep: a `Badge variant="silver"` prop rendering `gray-400`, and
Tailwind's `accent-red-500` (the `accent-color` utility) both look like the token and are not it.
