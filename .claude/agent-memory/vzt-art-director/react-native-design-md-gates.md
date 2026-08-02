---
name: react-native-design-md-gates
description: For Expo/React Native repos the standard DESIGN.md gates (raw-Tailwind-palette, CSS variables) match NOTHING — use raw color literals outside the theme module, and key variants by runtime mechanism not CSS selectors.
metadata:
  type: project
---

**First settle the fork: NativeWind or not.** Per [[nativewind-has-a-real-css-var-layer]] a
NativeWind v4 repo DOES have a real CSS var layer. A *non*-NativeWind Expo repo has none,
and there the web `extract` gates and variant model both silently produce a decorative file.

**Prove which one you are in — six axes, not a filename.** Do not infer from the presence
of `src/global.css`: that is exactly the NativeWind input filename, so an orphaned copy of
it in a StyleSheet-only repo reads as a false positive (flagplay-mobile has one). Check:
`nativewind`/`tailwindcss` in `package.json`; `node_modules/nativewind`; whether
`metro.config.js` exists **at all** (no metro config ⇒ nowhere NativeWind could be wired);
`tailwind.config.*`; count of `className=` vs files using `StyleSheet.create`; count of
`var(--` in `src/`. flagplay-mobile scored 0 / absent / absent / absent / 0-vs-70 / 0.

**Why the default gate fails in the non-NativeWind case:** the primary web gate is a
raw-Tailwind-palette-class grep. It matches zero lines and reports a clean repo that has
129 raw color literals. Likewise `:root` / `[data-theme]` / `.dark` do not exist — an agent
that writes those selectors into `variants:` has written fiction.

**How to apply:**
- Token source is JS/TS: `src/theme/*.ts` exporting plain consts, consumed inside
  `StyleSheet.create`. Establish authority and say so in `## Token source of truth`.
- Gate 1 = raw color literals (`#hex` **and** `rgba(N`) outside the theme dir. The `rgba`
  half is usually the bigger number by 10x — RN theme modules rarely ship an alpha/tint
  token, so every translucent brand fill gets inlined. Missing `--brand-primary-muted`
  equivalent is the single highest-leverage token-layer fix in a mirrored web↔RN pair.
- Gate 2 = raw numeric `fontSize:` bypassing the scale.
- Gate 3 = `shadowColor` vs `elevation` counts. These are two different, non-equivalent
  systems; an iOS-only shadow means the effect is simply absent on Android.
- Gate 4 = dark-lock invariant: if `app.json` sets `userInterfaceStyle: "dark"` and there
  is no light palette, assert `useColorScheme` stays at 0 call sites.
- Key `variants:` by real mechanisms: `app.json userInterfaceStyle`, React Navigation
  `ThemeProvider value={navTheme}` (its `DarkTheme` override exists to kill RN's WHITE
  default container — removing it causes a white flash), `useResponsive()` breakpoints,
  role hooks, and `iap-policy.ts` gates.
- **Rejected gate worth remembering:** "every screen must import the theme module" — its
  hits are one-line `export { default } from '…'` re-export shims. 100% false positives.
- Also RN-only and worth a section: safe-area `edges`, `hitSlop` + 44pt/48dp targets,
  `maxFontSizeMultiplier` / Dynamic Type, `Platform.OS` ternaries vs `.ios.tsx` splits.

Worked example: `/Users/vonzellebrown/github-projects/flagplay-mobile/DESIGN.md`
(baselines 129 / 34 / shadowColor=1 elevation=0 / dark-locked). Related:
[[vzt-protocol-visual-lane-design-md]].
