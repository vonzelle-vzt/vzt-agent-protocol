# DESIGN.md — the visual contract

A `DESIGN.md` at a repo root is the **taste cache**. It moves visual judgement off the model
tier and onto disk, the same way `templates/spec.md` moves a long-horizon plan onto disk. That
is the whole economic argument: with this file present, visual work routes DOWN to Sonnet,
because the taste is in the file and the model only has to apply it faithfully. Without it,
every restyle is a fresh act of taste and belongs on Opus.

Generate it with `/vzt-ui extract` — never by hand, and never from imagination. Every value in
it must be **read out of the repo's real token layer**. A DESIGN.md that describes tokens the
code does not have is worse than no DESIGN.md: it routes work down a tier *and* points it at
fiction.

The format follows the `awesome-design-md` convention (VoltAgent) — YAML frontmatter a machine
can parse, markdown an agent can read — with three sections added that the reference format
does not have (`Token source of truth`, `Compliance`, `Known gaps`). Those three are what make
this file load-bearing instead of decorative.

Copy everything below the line. Replace every `<…>` placeholder.

---

```yaml
version: 1
name: <Product or repo name>
description: >
  <2-4 sentences. The mood and the philosophy, not a feature list. What a user should FEEL.
  Name the one or two things that carry the brand — the accent color, the type treatment, the
  surface ladder — and say what is deliberately restrained. An agent reads this first and it
  sets everything downstream.>

# Where these values are copied FROM. See "Token source of truth" below.
source: <e.g. packages/ui/src/tokens.css>

# ── Base layer ──────────────────────────────────────────────────────────────
# The default/global scope. Every token here must EXIST in `source` under :root.
# Write the token name exactly as the code declares it, minus the leading `--`.
colors:
  <brand-primary>: "<#hex>"
  <brand-primary-foreground>: "<#hex>"
  <vzt-color-bg>: "<#hex>"
  <vzt-color-surface>: "<#hex or rgba()>"
  <vzt-color-text>: "<#hex>"
  <vzt-color-text-muted>: "<#hex or rgba()>"
  <vzt-color-border>: "<#hex or rgba()>"
  <vzt-color-success>: "<#hex>"
  <vzt-color-warning>: "<#hex>"
  <vzt-color-danger>: "<#hex>"
  <vzt-color-focus-ring>: "<#hex>"

typography:
  <role, e.g. display-xl>:
    fontFamily: <var(--brand-font-family) or a real stack>
    fontSize: <e.g. 48px or var(--vzt-font-size-xl)>
    fontWeight: <400-700>
    lineHeight: <e.g. 1.1>
    letterSpacing: <e.g. -0.02em>
  # One entry per role the codebase actually uses. Do not invent an 11-step
  # scale because the reference files have one — record what exists.

spacing:
  <xs>: <4px>
  <sm>: <8px>
  <md>: <12px>
  <lg>: <16px>
  <xl>: <24px>

rounded:
  <sm>: <6px>
  <md>: <8px>
  <lg>: <12px>
  <pill>: <9999px>

motion:
  <duration-fast>: <120ms>
  <duration-base>: <200ms>
  <ease-out>: <cubic-bezier(...)>

# ── Variant layers ──────────────────────────────────────────────────────────
# The reference `awesome-design-md` frontmatter is FLAT — one value per token —
# because those files describe single-theme marketing sites. Real products are
# not flat. Declare every scope that overrides the base, keyed by the EXACT CSS
# selector or media query that activates it, and list ONLY the tokens it changes.
#
# Omitting a variant is not a cosmetic loss: an agent that cannot see a scoped
# admin skin will "fix" it by editing the global brand token, which silently
# restyles every other surface. That is the single most expensive mistake this
# file exists to prevent.
variants:
  <':root[data-theme="dark"]'>:
    description: <when this applies, in one line>
    colors:
      <vzt-color-bg>: "<#hex>"
      <vzt-color-text>: "<#hex>"
  <'[data-admin-skin="lux"]'>:
    description: <e.g. Admin console only. Scoped — never leaks to tenant surfaces.>
    colors:
      <brand-primary>: "<#hex>"
  <'@media (prefers-reduced-motion: reduce)'>:
    description: <what is disabled>

# ── Components ──────────────────────────────────────────────────────────────
# Only components that actually exist. Reference tokens by name, never by raw
# value — that is what makes this section checkable against the code.
components:
  <button-primary>:
    background: <{colors.brand-primary}>
    text: <{colors.brand-primary-foreground}>
    typography: <{typography.button}>
    rounded: <{rounded.md}>
    padding: <8px 14px>
    states: <hover / focus / active / disabled — one clause each>
```

---

## Overview

<The narrative version of the frontmatter `description`. 1-2 paragraphs, then a short bulleted
list of the defining characteristics. This is the section an agent leans on when the request is
vague ("make this page feel like the rest of the app"), so write the *principles*, not a
restatement of the hex codes above.>

## Colors

<Group by ROLE, not by hue: Brand & Accent, Surface, Text, Semantic. For each, give the token
name and the hex together — `` `{colors.brand-primary}` **#2563eb** `` — plus one line on what
it is FOR and, where it matters, what it is not for. State any color that is reserved (e.g.
"the accent appears only on the primary CTA, focus rings, and the logo mark"). Restraint rules
are more useful to an agent than the palette itself.>

## Typography

<Font families and their fallbacks. Then a hierarchy table: Token | Size | Weight | Line height
| Letter spacing | Use. Then principles — when to go up a step, when tracking tightens, whether
numerics use tabular figures.>

## Layout

<The spacing scale and what it means. Grid and container widths. Whitespace philosophy — the
rule that decides whether a section feels cramped or airy.>

## Elevation & depth

<How lift is expressed: shadows, or a surface ladder (background stepping + hairline borders),
or blur/glass. A table of Level | Treatment | Use. If the system deliberately avoids shadows,
say so — that is a rule an agent will otherwise violate on its first card.>

## Components

<Per component: the token bindings, then every state (hover, focus, active, disabled, loading,
empty, error). States are where generated UI most often goes wrong, because they are the part a
screenshot doesn't show.>

## Do's and don'ts

**Do**
- <Prescriptive, checkable rules. "Use `{colors.*}` tokens for every color.">

**Don't**
- <Anti-patterns, ideally ones this repo has actually committed. "Don't add a raw Tailwind
  palette class (`bg-slate-800`) — see Compliance below; it fails the gate.">
- <"Don't edit a base token to fix a scoped-variant problem.">

## Responsive behavior

<Breakpoints table. Touch-target minimums. What collapses, stacks, or hides at each step, and
what must never hide.>

---

## Token source of truth

<!-- VZT addition. Not in awesome-design-md. -->

| | |
|---|---|
| **Authoritative file** | `<path — the file whose values win, e.g. packages/ui/src/tokens.css>` |
| **This file's role** | Derived. Regenerate with `/vzt-ui extract` after changing the source. |
| **Consumers** | `<list — e.g. apps/web, packages/charts>` |
| **Derived artifacts** | `<e.g. mobile/src/theme/colors.ts — DERIVED, do not hand-edit>` |

<State the direction of derivation explicitly and name what must never be hand-edited. A
web↔mobile pair that stays in sync "by code comment" is the failure mode this table replaces:
if a mobile theme file mirrors a web token file, say so here and give the check that proves
they agree.>

## Compliance

<!-- VZT addition. This section is why the file is load-bearing. -->

The machine check for this repo. Runnable verbatim — this is the `MACHINE_CHECK` contract from
`templates/worker-brief.md` applied to visual work. `/vzt-ui apply` runs it and pastes real
output; wire it into the repo's merge gates alongside typecheck/test/build.

**Baseline-and-ratchet, not a flag day.** Record today's counts and fail only on an *increase*.
A repo with 1,200 existing violations can adopt this file on the same day as a clean one, which
is the only way this ever gets adopted at all.

```bash
# Gate 1 — raw Tailwind palette classes in feature code. The primary check:
# high signal, effectively zero false positives.
grep -rInE '\b(bg|text|border|ring|from|to|via)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]{2,3}\b' <src-dir> --include='*.tsx' | wc -l
# BASELINE: <N>   ← fails if this number goes UP

# Gate 2 — raw hex in feature code. Secondary, and MUST be filtered.
# Exclusions are not laziness; each one is a legitimate pattern:
#   var(--token, #hex)  CSS custom-property fallbacks — the CORRECT defensive
#                       pattern. An unfiltered hex rule flags the best code in
#                       the repo and gets switched off within a week.
#   email templates     Email clients do not support CSS custom properties.
#                       Hardcoded hex is REQUIRED there.
#   chart palettes      Categorical series colors are data, not chrome.
#   comments, tests     Not shipped styling.
grep -rInE '#[0-9a-fA-F]{6}\b' <src-dir> --include='*.tsx' --include='*.ts' \
  | grep -v 'var(--' | grep -vE '^\s*//|/\*' \
  | grep -vE '<email-dir>|<chart-palette-file>|\.test\.|\.spec\.' | wc -l
# BASELINE: <N>
```

<Add any repo-specific gate here — a contrast/a11y check, a scoped-variant leak check (e.g.
"no `data-admin-skin` token outside the admin subtree"), a web↔mobile token parity check.>

## Known gaps

<What this file does NOT specify, so an agent asks instead of inventing. Be candid: missing
light mode, undocumented form-error styling, an icon set with no rules, a component whose
states were never designed. A stated gap is a question; an unstated gap is a hallucination.>
