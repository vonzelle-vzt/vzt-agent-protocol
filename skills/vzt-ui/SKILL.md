---
name: vzt-ui
description: "Visual design lane — author a repo's DESIGN.md from its real token layer, then apply it. Use for restyling, rethemes, brand passes, spacing/typography/palette work, 'make this look right'. Not for technical architecture (that is /vzt-design). Usage: /vzt-ui extract | /vzt-ui apply <change>."
---

# VZT UI — the visual lane

Visual work is the one kind of work this protocol used to be blind to. *"Restyle the
dashboard"*, *"fix the spacing"*, *"apply the brand palette"* match no routing signal and land
in the default bucket, where they get done by whichever model happened to be in the chair, from
whatever the model imagines the product looks like. The result is thirty repos with thirty
palettes.

The fix is not a better model. It is a file.

## The thesis: DESIGN.md is a taste cache

A `DESIGN.md` at the repo root moves visual taste **off the model tier and onto disk** — the
same move `/vzt-ship` makes for long-horizon plans, for the same reason. Once the taste is in
the file, applying it is not an act of judgement; it is execution, and execution is Sonnet
work.

That gives the lane its economics, and its two modes:

| | taste comes from | tier | agent | mode |
|---|---|---|---|---|
| **No DESIGN.md** | the model | Opus | `vzt-art-director` | `extract` — decide once, write it down |
| **DESIGN.md exists** | the file | Sonnet | `vzt-stylist` | `apply` — follow it faithfully |

An art director decides; a stylist executes the decision. That pairing *is* the tier split, and
the split is why the down-route is safe: `vzt-stylist`'s brief forbids inventing values and
requires every one to trace to a token. Routing cache-hit work to a generic builder instead
would remove the only mechanism that makes cheap visual work trustworthy.

So the first move on any visual request in a repo with no `DESIGN.md` is **not** to style the
thing that was asked for. It is to write the `DESIGN.md`. Styling one page from imagination
solves one page and leaves the next thirty to guesswork.

## `/vzt-ui extract` — author the file

1. **Find the real token layer.** In order of authority: `packages/ui/src/tokens.css` →
   `globals.css` `@theme` / `:root` → `tailwind.config.*` → `components.json` →
   `src/theme/colors.ts`. Read it **in full**. This is Gate 2 — evidence before reasoning. You
   are transcribing, not designing.
2. **Enumerate the variant scopes.** Grep for `:root`, `[data-*=`, `@media (prefers-`,
   `.dark`. Each one that overrides tokens is a `variants:` entry keyed by its exact selector.
   Flattening a scoped skin into the base is the most expensive error in this lane — see rule 3
   of `vzt-stylist`.
3. **Absorb what already exists.** If the repo has a `docs/design/DESIGN-SYSTEM.md`,
   `docs/specs/DESIGN_SYSTEM.md`, or similar, read it and carry its *prose* — principles,
   do's/don'ts, component rules — into the new file. Leave the old path as a one-line pointer
   so nothing dangles. Do not carry values it asserts that the code contradicts; the code wins,
   and the discrepancy goes in `## Known gaps`.
4. **Choose the oracle and record the baseline** — see Compliance below. Run it, write the
   real numbers in.
5. **Write `DESIGN.md`** from `.claude/templates/DESIGN.md`, at the repo **root** (that placement is
   why it gets read, the same reason `CLAUDE.md` works).

   > **Where the template lives.** It ships with the protocol, not with your project:
   > `.claude/templates/DESIGN.md` for a project install, `~/.claude/templates/DESIGN.md` for a
   > global one. There is **no `templates/` directory at a repo root** — looking for one there
   > is what makes an otherwise-installed template report as missing.
6. **Add the pointer.** One line in the repo's `CLAUDE.md`: *read `DESIGN.md` before writing
   or restyling UI.* Per the audit this line is the highest-leverage part of the whole
   convention — a design doc nothing is told to read is a design doc nothing reads.

## `/vzt-ui apply <change>` — use the file

1. **Read `DESIGN.md` first.** All of it, including `variants:` and `## Known gaps`. If the
   change needs something the file does not specify, that gap is a **question**, not a licence
   to invent — ask, then record the answer in the file.
2. **Make the change through tokens.** Never a raw hex, never a raw Tailwind palette class.
   If no token fits, that is a token-layer change: say so, and treat it as an `extract`-tier
   decision rather than quietly inventing a value in feature code.
3. **Respect the scope.** A problem visible only under a scoped variant is fixed inside that
   variant. Editing a base token to fix a scoped surface restyles everything else.
4. **Run `## Compliance` and paste real output.** Not "the check passes" — the output.
5. **Then look at it.** The oracle proves you used tokens; it cannot prove the result is any
   good. For anything a user will see, render it and check.

## Compliance — the part that makes this real

A design doc with no gate is decorative, and the evidence says so: the repos in this portfolio
carrying 300-line design systems also carry over a thousand raw palette classes. The gate is
what converts the file from documentation into a contract.

**Primary check — raw Tailwind palette classes.** High signal, near-zero false positives.

**Secondary check — raw hex, filtered.** The exclusions are not laziness. `var(--token, #hex)`
fallbacks are the *correct* defensive pattern; email templates genuinely cannot use CSS custom
properties; chart series colors are data, not chrome. An unfiltered hex rule flags the best
code in the repo and gets switched off within a week.

**Baseline-and-ratchet.** Record today's counts; fail on an *increase*. This is what lets a
repo with real debt adopt the file today instead of never.

Full commands live in `.claude/templates/DESIGN.md` under `## Compliance`, and get copied into each
repo's own `DESIGN.md` with that repo's numbers. Wire it into the merge gates next to
typecheck/test/build.

## Boundaries

- **Not technical design.** Architecture, schemas, APIs, migration plans → `/vzt-design`
  (`vzt-architect`, the `opus@max` rung). The word "design" is overloaded; this lane is
  strictly visual.
- **Not a redesign mandate.** `extract` documents what the product already looks like. If it
  looks bad, say so and stop — proposing a new direction is a separate, explicit ask.
- **No frontier rung above this.** Visual work never escalates to Fable. Taste is not frontier
  reasoning — there is no no-prior-art problem here, since every product ever shipped is prior
  art. Two failures → stop and ask for a human eye, naming what you'd need to see.
- **A stub does not count.** The router treats a `DESIGN.md` under 400 bytes as absent. A
  three-line placeholder would down-route every visual request in the repo forever while
  containing no taste to apply — a cache that lies is worse than no cache.

## Proving the cache is live

The oracle is the router, not `test -f` — a file the router cannot see buys nothing:

```bash
printf '{"prompt":"restyle the dashboard header","cwd":"<repo>"}' \
  | node ~/.claude/hooks/vzt-router/vzt-route-classifier.mjs \
  | grep -q 'ui:cache-hit(DESIGN.md)'
```

⚠️ **The probe must be four or more words.** The classifier bypasses classification
entirely below that (`prompt.split(/\s+/).length < 4` → `process.exit(0)`), emitting zero
bytes — so a three-word probe reports a miss for a repo whose cache is perfectly fine, and
does it identically for every repo. Falsify it too: the same prompt against a repo with no
`DESIGN.md` must return `ui:cache-miss`, or the signal is always-on and proves nothing.

`~/.claude/scripts/vzt-design-md-audit.sh [repo ...]` runs this across a whole portfolio.
