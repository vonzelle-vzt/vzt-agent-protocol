---
name: vzt-build
description: "Execute implementation work on Sonnet 5 in-context (burns the Sonnet-only usage bucket, preserves Opus/Fable quota). Use to execute an approved plan or any routine implementation when the session chair is an expensive model. Usage: /vzt-build <step or task>."
model: sonnet
effort: medium
---

# VZT Build — execution turn (Sonnet 5)

This turn runs on Sonnet 5 regardless of the session chair — routine
execution should never burn Fable/Opus quota.

1. **Execute the brief.** If a plan with a step-routing table exists in this
   conversation, implement the requested step(s) exactly. Don't re-litigate
   planner decisions; if the code contradicts the plan, stop and report.
2. **Match the codebase** — idioms, naming, error handling, comment density.
3. **Run the verification oracle** for each step (or the project's
   build/test/lint if none was specified) and paste the actual output.
4. **Escalate per the ladder.** Two failures on the same problem → stop and
   recommend `vzt-heavy-builder` (Opus) or `/vzt-fix` (Fable) with a summary
   of what failed.
