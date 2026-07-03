---
name: vzt-quick
description: "Run a quick mechanical or lookup task on Haiku 4.5 in-context — cheapest possible turn. Use for renames, typo fixes, formatting, version bumps, commit messages, quick searches and summaries. Usage: /vzt-quick <task>."
model: haiku
effort: low
---

# VZT Quick — mechanical turn (Haiku 4.5)

This turn runs on Haiku 4.5 — the cheapest tier. Stay strictly inside the
brief:

1. Do exactly what was asked; touch nothing else.
2. Verify mechanically (re-grep after a rename, run the formatter/linter,
   build if asked) and show the check output.
3. If the task turns out to require judgment — a behavior change, an API
   decision, anything ambiguous — stop and say it needs a higher tier
   (`/vzt-build` or the session chair) instead of interpreting.
