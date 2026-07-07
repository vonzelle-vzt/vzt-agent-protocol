# VZT Agent Protocol — Routing Matrix

The protocol routes every piece of work to the **cheapest tier that can do it
well**. Under-routing is cheap (the escalation ladder catches it); over-routing
burns the quota this protocol exists to protect.

## Tiers

<!-- sync: TIERS in hooks/vzt-route-classifier.mjs — test/classifier.test.mjs asserts the Cost column matches -->
| Tier | Model | Alias | Owns | Fleet agents | Turn skill | Cost | Intelligence | Taste |
|------|-------|-------|------|--------------|------------|------|--------------|-------|
| 4 | Claude Fable 5 | `fable` | Architecture, system design, planning, migration strategy, impossible bugs, root-cause analysis, security analysis, multi-repo strategy | `vzt-planner`, `vzt-oracle` | `/vzt-plan`, `/vzt-fix` | 25× | 10 | 10 |
| 3 | Claude Opus 4.8 | `opus` | Large refactors, migrations, dense algorithms, performance/concurrency surgery, load-bearing review | `vzt-heavy-builder`, `vzt-reviewer` | — | 15× | 9 | 9 |
| 2 | Claude Sonnet 5 | `sonnet` | Standard implementation: features, bug fixes, tests, endpoints, components, integration — **the default tier** | `vzt-builder` | `/vzt-build` | 3× | 8 | 8 |
| 1 | Claude Haiku 4.5 | `haiku` | Search/recon, summaries, renames, typo fixes, formatting, lint, version bumps, commit messages, file moves | `vzt-scout`, `vzt-mechanic` | `/vzt-quick` | 1× | 5 | 4 |

## Decision procedure

1. Mechanical or pure discovery? → **Tier 1**, no exceptions.
2. Requires choosing an approach (architecture/schema/strategy/trade-offs), or
   has beaten a lower tier twice? → **Tier 4**.
3. Implementation with tight coupling, algorithms, or blast radius? → **Tier 3**.
4. Everything else → **Tier 2**. Unsure between two tiers? Take the lower.

## Hard rules

- **Escalation ladder**: two failures at a tier → up exactly one tier
  (haiku → sonnet → opus → fable), stated aloud.
- **Fable budget**: Fable turns ≤15% of a session (`vzt-agent stats` tracks it).
- **Never execute a routine plan on Fable/Opus** — plans hand off to
  `vzt-builder` via the step-routing table.
- **Chair-aware inversion**: on a Fable/Opus chair the doctrine flips to
  delegating DOWN; on a Sonnet/Haiku chair it escalates UP only when earned.

## Why this saves your limits

- Max-plan weekly limits have **two buckets**: one for all models, one for
  **Sonnet only**. Work routed to `vzt-builder`/`/vzt-build` draws on the
  Sonnet bucket and preserves the all-models bucket that Fable and Opus burn.
- Per-turn cost is tiered (Opus is several × Sonnet, Sonnet several × Haiku),
  so pushing recon and mechanical work to Haiku is nearly free.

## Effort routing

- Default effort per tier: Fable `high`, Opus `high`, Sonnet `medium`, Haiku
  `low`.
- Opus downgrades to `medium` on low-confidence classifications — don't spend
  high effort confirming a guess.
- The classifier never suggests `max` — that's reserved for pinned Fable
  agents or an explicit escalation, not routine routing.
- Fable-low ≈ Opus-high in quality-per-cost.
- `xhigh`/`max` on routine work causes overthinking, not quality.
