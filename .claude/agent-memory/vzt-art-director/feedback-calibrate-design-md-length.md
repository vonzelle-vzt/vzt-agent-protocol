---
name: feedback-calibrate-design-md-length
description: DESIGN.md length must be calibrated to repo maturity — a short honest file beats a padded one, and "this repo doesn't justify a cache" is an allowed verdict
metadata:
  type: feedback
---

When running `/vzt-ui extract`, size the file to what the repo actually has. A padded
`DESIGN.md` is a tax on every future session, and the user grants explicit permission to
return "this is a scaffold, revisit when real screens exist" as the deliverable.

**Why:** the router treats any `DESIGN.md` over 400 bytes as a cache hit and down-routes every
future visual request in that repo to Sonnet forever. So a long file full of invented structure
does active harm twice — it routes work down a tier *and* points it at fiction. The user framed
this as "a calibrated short file is the correct deliverable, not a long one."

**How to apply:** decide length from evidence, not from the template's section count. The
template's sections are prompts, not quotas — `motion: {}` and `variants: {}` with a verified
"grepped, zero matches" note are better entries than an invented scale. The real payload in a
thin repo is the *undeclared conventions* (surface ladder, no-shadow rule, default body size),
because those are invisible in the token file and get reinvented on every task. If the repo
genuinely has no UI, still write >400 bytes so the router can see it, but say plainly in
`## Known gaps` that it is a scaffold — and say so in the report too.

Related: [[project-hailer-design-cache]]
