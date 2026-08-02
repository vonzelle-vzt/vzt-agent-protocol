---
name: nativewind-has-a-real-css-var-layer
description: An Expo/RN repo on NativeWind v4 DOES have a CSS custom-property layer — do not assume "RN means no CSS vars"; and its JS mirror is a twin, not a derived artifact.
metadata:
  type: feedback
---

Do not accept "React Native ⇒ there is no CSS variable layer" as a premise. NativeWind v4
injects a real stylesheet via `metro.config.js` → `withNativeWind(config, { input: './src/global.css' })`,
and `tailwind.config.js` maps color names to `var(--color-*)`. A naive token scan that greps
only `.tsx` files reports **0 CSS vars** and sends you looking for the wrong source.

**Why:** On CoachMe the brief asserted "RN repo, 0 CSS vars, token source is `src/theme/colors.ts`."
The actual authority was `src/global.css` (`:root` = light, `.dark:root` = dark) for the
className path, with `src/theme/colors.ts` as a **twin hand-maintained mirror** for the JS path
(icons, Skia, navigator options). Neither is generated from the other — the header comments just
ask a human to "keep in sync," and nothing in typecheck/lint/build detects drift.

**How to apply:**
- Before concluding an RN repo's token source, read `metro.config.js` for `withNativeWind(...)`
  and `tailwind.config.js` for `var(--...)` mappings. Check for a `global.css` even when a
  `.tsx`-only scan says there are no CSS vars.
- When two palettes mirror each other, do NOT claim one is "derived" — say they are twins and
  ship a **parity gate** as the repo-specific oracle. That gate is the highest-value thing in
  the file, because drift there is invisible to every other check.
- Variant keys must be the real mechanism (`useColorScheme()` + an imperative
  `colorScheme.set()` in a ThemeProvider), never a CSS selector that never runs on a device.
- `elevation` (Android) and `shadowColor/Offset/Opacity/Radius` (iOS) are two systems; a repo
  with zero of both has a deliberate flat surface ladder worth recording as a rule.

Related: [[vzt-protocol-visual-lane-design-md]]
