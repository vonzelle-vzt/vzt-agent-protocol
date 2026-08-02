---
name: design-md-react-native-extraction
description: Generated/separately-bundled code breaks the DESIGN.md color gate two ways — a 566KB single line inside a normal .tsx, and a WebView JS file that re-declares theme colors because it structurally cannot import them. Length-filter the first; parity-gate the second.
metadata:
  type: project
---

Two traps that the RN gate advice in [[react-native-design-md-gates]] and
[[design-md-react-native-gate]] does not cover. Both come from code that is **generated, or
bundled separately from the app**. Found on `tradescriptai-mobile` (2026-07-30).

**1. Filter generated lines by LENGTH, never by filename.**
`src/components/editor/CodeEditor.tsx` was 576KB — because **line 33 alone was a 566KB
generated string** (an esbuild'd CodeMirror bundle injected by `webview/build.mjs` between
`__CODEMIRROR_HTML_START__`/`__END__` markers). It sits inside a normal-looking 255-line `.tsx`
with real hand-written code around it.

**Why:** excluding the whole file loses coverage of the real code; including it makes the grep
dump ~600KB. And `grep -c` silently **undercounts** it as *one* match while it contains
hundreds of hex values no human can edit. `awk 'length($0) < 400'` catches generated and
minified content generically without naming any file, so it keeps working as the repo changes.

**How to apply:** before trusting any color-literal baseline, check for outlier line lengths
(`awk '{if(length>m){m=length;n=NR}}END{print n,m}'`). A hex count that seems suspiciously low
in a repo with an embedded editor/webview is this bug.

**2. A WebView that re-declares theme colors is a parity gate with a HARD baseline of 0.**
`webview/cm-entry.js` re-declared `BG/SURFACE/BORDER/TEXT/MUTED/ACCENT` as its own consts.

**Why:** it is bundled independently by esbuild into a self-contained CSP-safe HTML document
that runs inside a `WebView`, so it **cannot** import the app's TS theme module. The
duplication is structural, not sloppiness — and nothing type-checks it, so drift is silent and
surfaces only as an editor whose background is a shade off the app around it. This is the same
shape as the NativeWind JS-palette twin in [[nativewind-has-a-real-css-var-layer]]: a twin, not
a derivation, so it needs a parity check rather than a "don't duplicate" rule.

**How to apply:** ship it as a repo-specific Gate 2 comparing the two files' constants, failing
on any mismatch (baseline 0, no ratchet — unlike Gate 1). Also: keep the WebView's **syntax
highlighting palette** OUT of the app token layer — it is a categorical palette, i.e. data, the
same exclusion as chart series colors.
