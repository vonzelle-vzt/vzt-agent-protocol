---
name: tailwind-flat-color-override-kills-scale
description: A flat string in tailwind `theme.extend.colors` (e.g. red:'#E4202B') DESTROYS that family's numeric scale — every `text-red-400` in the repo silently compiles to nothing. Check this during every extract.
metadata:
  type: feedback
---

When extracting a `DESIGN.md`, always check whether `tailwind.config.ts` overrides a
**built-in palette name** (`red`, `blue`, `orange`, `green`, `gray`…) with a **flat string**
instead of a scale object.

```js
extend: { colors: { red: '#E4202B' } }   // ← replaces the ENTIRE red-50..950 scale
```

`extend` merges shallowly *per key*. A string value replaces the whole object, so
`text-red-400`, `bg-red-500/20`, `border-red-500/30` no longer exist and emit **zero CSS** —
the element silently inherits its parent's colour. Found in GeminiFX: 161 lines / 229
occurrences across 24 files, including P&L sign colours on the landing page and scanner.

**Why:** this is invisible to every normal review. It is not a style preference — it is a
correctness bug that looks like a style preference, and the generic raw-Tailwind-palette gate
(Gate 1) buries it inside a 1,351-line count where nobody will ever notice it.

**How to apply:**
- Verify authoritatively with `resolveConfig`, NOT by grepping a `.next/` build artifact —
  those chunks are stale and per-route, and gave me a false reading on this repo:
  ```bash
  node -e "const rc=require('tailwindcss/resolveConfig');
  const t=rc({content:[],theme:{extend:{colors:{/* paste the override */}}}}).theme.colors;
  for(const k of ['red','blue','orange'])console.log(k, typeof t[k]==='string'?'FLAT — scale destroyed':'intact');"
  ```
- When present, give it its **own dedicated gate** in `## Compliance` that ratchets to **zero**,
  separate from the baseline-and-ratchet style gates.
- Record it as `## Known gaps` #1 and as the loudest **Don't**, because the fix is a decision
  (rename the config key to `brand-red` and restore the scale, vs. rewrite every call site) —
  not something a stylist should pick unilaterally.

Related: [[design-md-extract-honest-thin-layer]]
