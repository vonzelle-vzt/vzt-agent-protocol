# Chair Profiles

The **chair** is the model your Claude Code session is launched with (`/model`).
The VZT Agent Protocol reads it at `SessionStart` and inverts its routing
doctrine to match — because the scarce resource is different depending on where
you sit. Same fleet, same classifier; the delegation direction flips.

| Chair | Scarce resource | Default motion | Reaches for |
|-------|-----------------|----------------|-------------|
| **Opus 4.8** | Wall-clock + Opus quota | Build inline, delegate **down** | Sonnet for routine, Haiku for mechanical, Fable for the hard 15% |
| **Sonnet 5** | Model capability | Stay inline on the Sonnet bucket, escalate **up** when earned | Opus for heavy work, Fable for planning/impossible bugs, Haiku for recon |
| **Fable 5** | Fable tokens (tight limit) | Plan/reason inline, delegate **all** execution down | Sonnet/Opus/Haiku for everything that isn't frontier reasoning |
| **Haiku 4.5** | Judgment | Dispatcher — delegate almost everything up | Sonnet for builds, Opus/Fable for anything needing judgment |

---

## Opus 4.8 chair — the recommended flagship setup

Sit on Opus so strong first-line reasoning is always on tap, and let the
protocol push routine work *down* so your all-models bucket lasts the week.

**Set it as your default:**

```
/model opus
```

**What the protocol does each turn:**

- **Complex implementation** (the tricky, tightly-coupled, algorithmic work) →
  handled **inline on Opus**. This is what the chair is for; delegating it would
  cost more context than it saves.
- **Routine execution** (features, CRUD, endpoints, tests) → delegated **down**
  to `vzt-builder` (Sonnet 5). Sonnet draws on a *separate* weekly bucket on Max
  plans, so this directly preserves the all-models quota Opus/Fable burn.
- **Mechanical / recon** (renames, formatting, version bumps, searches,
  summaries) → delegated **down** to `vzt-mechanic` / `vzt-scout` (Haiku 4.5),
  which is nearly free.
- **Genuinely hard reasoning** (novel architecture, migration strategy,
  impossible bugs) → escalated **up** to Fable via `/vzt-plan`, `/vzt-fix`, or
  the `vzt-planner` / `vzt-oracle` subagents. Kept to ≤15% of turns.

**A turn on the Opus chair:**

```
you (Opus chair): "add a settings page with a profile form, and rename
                   getUserData to fetchUserProfile across the repo"

 ├─ classifier tags the build → vzt-builder (Sonnet 5) writes the settings page
 ├─ classifier tags the rename → vzt-mechanic (Haiku 4.5) does the rename + verifies
 └─ you stay on Opus as coordinator, review both, keep your quota for hard turns
```

```
you (Opus chair): "design the multi-tenant billing architecture and plan
                   the migration off the monolith"

 └─ this earns the frontier tier → /vzt-plan (switches THIS turn to Fable 5)
     or delegate to vzt-planner — returns a plan with a step-routing table
     → execution steps hand back down to vzt-builder / vzt-mechanic
```

**Why this fits "use Opus first line so I can call on Sonnet":** you never leave
the Opus seat. The router calls Sonnet (and Haiku) *for* you on the work that
doesn't need Opus, and only reaches up to Fable on the rare frontier turn.

---

## Sonnet 5 chair — maximum quota efficiency

Sit on Sonnet when you want the most turns per week. Most work stays inline on
the Sonnet-only bucket; the protocol escalates *up* only when a task earns it.

```
/model sonnet
```

- **Standard execution** → inline on Sonnet.
- **Recon / mechanical** → down to `vzt-scout` / `vzt-mechanic` (Haiku).
- **Heavy implementation / load-bearing review** → up to `vzt-heavy-builder` /
  `vzt-reviewer` (Opus).
- **Planning / architecture / impossible bugs** → up to `vzt-planner` /
  `vzt-oracle` (Fable), or the `/vzt-plan` / `/vzt-fix` turn skills when the
  work needs full conversation context.

---

## Fable 5 chair — frontier reasoning, delegate everything else

Sit on Fable only when the whole session is heavy reasoning. Fable tokens are
the tightest limit, so the doctrine is aggressive delegation:

```
/model fable
```

- Planning, architecture, and root-cause reasoning → **inline** (that's the point).
- **All** execution → down: routine → `vzt-builder`, mechanical → `vzt-mechanic`,
  heavy parallel implementation → `vzt-heavy-builder`.
- Never do file-by-file mechanical work inline on this chair.

---

## Switching chairs

The chair is read fresh at every session start, so switching is just
`/model <name>` on your next session — the correct profile loads automatically.
Mid-session, before the next SessionStart fires, the router falls back to a
safe chair-agnostic ladder (recon→Haiku, routine→Sonnet, heavy→Opus,
frontier→Fable), so routing stays correct either way.

Check your actual distribution any time:

```
vzt-agent stats
```

It shows the tier split and flags if Fable exceeds the ≤15% target.
