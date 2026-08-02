---
name: design-md-react-native-gate
description: For React Native/Expo repos the default DESIGN.md Tailwind-palette gate is a permanent uninformative 0 — use raw hex in style position instead, and exclude categorical palettes
metadata:
  type: project
---

**First, prove NativeWind is actually absent** — see [[nativewind-has-a-real-css-var-layer]]; never accept "RN ⇒ no CSS vars" from a brief. The falsification that settles it: no `metro.config.js`, no `nativewind`/`tailwind` in `package.json`, zero `.css` files, zero `className=` in `src`. All four held on `mtm-mobile`.

Once that is established: the protocol's default `## Compliance` Gate 1 (raw Tailwind palette classes) is **meaningless in a React Native / Expo repo** with no NativeWind. It returns a permanent `0` and proves nothing.

**Why:** RN has no CSS custom-property layer and no utility classes. The real drift is a colour literal written into `StyleSheet.create` or an inline `style={{ }}` that bypasses the theme module (`src/theme/colors.ts`). Verified on `mtm-mobile` (Expo SDK 54, 119 .tsx): Tailwind gate would be 0, while the style-position hex gate found 29 real chrome violations and 159 total literals.

**How to apply:** when extracting a DESIGN.md for an RN repo —
- Gate 1 = `grep -rInE "(color|backgroundColor|borderColor|tintColor|shadowColor)[[:space:]]*:[[:space:]]*'#[0-9a-fA-F]{3,8}'"` over `src`, excluding the theme module, email-HTML templates, and **categorical palette maps** (video/ticket/agent category colours are DATA, not chrome — flagging them punishes the correct pattern of centralising them).
- Gate 3 = files containing `StyleSheet.create` that never import the theme module. High signal, tiny number, easy to ratchet to 0.
- Gate 4 for **trading products** = count of `tabular-nums`, ratcheting **UP** not down. Money columns in RN default to proportional system figures and visibly jitter; this is usually the highest-value visual fix in the repo.

Also RN-specific and worth documenting in every RN DESIGN.md: `elevation` is Android-only while `shadowColor/Offset/Opacity/Radius` are iOS-only (setting one gives a platform-asymmetric result); dark mode may be *statically locked* via `app.json` `userInterfaceStyle` rather than `useColorScheme()`, in which case a light-mode branch is unreachable code; and `allowFontScaling` defaults to `true`, so fixed row heights clip under Dynamic Type.

Related: [[design-md-trading-product-pnl-tokens]]
