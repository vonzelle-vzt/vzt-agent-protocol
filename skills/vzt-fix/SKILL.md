---
name: vzt-fix
description: "Root-cause a hard bug on Fable 5 with full conversation context. Use for impossible bugs — race conditions, heisenbugs, corruption, intermittent failures — especially after cheaper attempts in this session have failed. Usage: /vzt-fix <symptom or bug description>."
model: fable
effort: max
---

# VZT Fix — frontier debugging turn (Fable 5)

This turn runs on Fable 5. Everything already tried in this conversation is
context — do not repeat failed attempts; reason about why they failed.

1. **Trace before theorizing.** Reproduce the failure or instrument the real
   path (logs, targeted Bash probes). An untested hypothesis is not a finding.
2. **Adversarial self-check.** Before concluding, name the evidence that would
   refute your root cause and check it.
3. **Separate cause from trigger.** The crashing line is rarely the wrong line.
4. Deliver a **fix packet**:
   - Root cause (mechanism + the evidence that proves it)
   - Exact fix: files, changes, ordering constraints
   - Verification oracle: command + expected result
   - Regression risk surface
   - Tier for the fix (`sonnet` default; say if it needs `opus`)

Apply the fix this turn **only if it is small and the oracle can run
immediately**; otherwise hand the packet to `vzt-builder` so Fable tokens
aren't spent on execution.
