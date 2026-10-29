# Resident architecture

## Goal and priorities

Each resident independently pursues **grow stronger and richer through your trade, without dying**.

1. Preserve life and valuable assets within an acceptable risk budget.
2. Accumulate sustainable, secure wealth.
3. Develop skills, equipment, resources and knowledge that improve future opportunities.

Use risk-adjusted long-term utility, not three immediate yes/no checks:

`U(a) = E[secure wealth gain] + α E[capability gain] − β E[loss] − C(a)`

subject to `P(death | a, context) ≤ ε`.

Cost includes time, resources and missed opportunities. Coefficients and estimates learn from observed outcomes while retaining uncertainty and priors. The risk budget depends on exposed assets, health, uncertainty and escape options. Requiring guaranteed survival would prevent useful activity.

Prerequisites inherit the value of their intended outcome: walking to a bank, obtaining tools and completing a deed can be useful before producing income or skill gains. Movement, purchases, damage/healing and inventory churn alone do not prove progress.

## Layers

`server ↔ network ↔ world/perception → agent/planning → runtime/execution → network`

Execution outcomes update perception and memory. Observability spans every layer. Only `@gemwright/network` is a separate package; other boundaries remain modules inside AI until extraction serves a concrete purpose.

| Boundary | Owns | Must not own |
| --- | --- | --- |
| Network | Transport, framing, encoding/decoding, sessions, semantic commands/events, protocol correlation and timeouts | Resident goals, professions, spending policy, creature judgments or model decisions |
| World/perception | Character/entity state, observations, reference definitions, discovered knowledge, freshness and uncertainty | Choosing or performing work |
| Agent/planning | Goals, threat judgments, intent, memory, utility, assumptions and plans | Packet details or resource arbitration |
| Runtime/execution | Scheduling, resource ownership, interruption, execution, verification and recovery | Treating a sent command as a verified outcome |
| Observability | Structured events, metrics, tracing and recorded-state replay | Making gameplay decisions or inventing missing evidence |

The server is authoritative and may contain arbitrary customizations. Default ServUO files supply reference knowledge, not guaranteed shard truth. Residents use ordinary player interactions without privileged server access.

### Continuous perception and knowledge

Maintain an event-driven world model with periodic reconciliation. Relevant changes must reach urgent safety handling while a profession is working or awaiting a response. Do not rebuild the whole visible world each tick.

Track observation range, freshness and lost visibility. Approximately eighteen tiles is a reference default, not a universal rule. Losing sight of an entity does not prove its death. Unknown is a first-class state; names, bodies and notoriety alone cannot establish vendor role or hostile intent.

| Knowledge | Meaning |
| --- | --- |
| Reference | Versioned baseline definitions, such as a creature's usual stats and abilities |
| Observed | Server evidence tied to identity, time, context, skills, equipment and result |
| Inferred | A revisable estimate combining reference knowledge, observations and current capabilities |

Threat judgments consider actual aggression/damage, capabilities, resources, assets and escape routes, exposing reasons and uncertainty. An innocent can attack; a murderer can ignore the resident. Sparse defeats must not become permanent conclusions. Reassess as skills, equipment and context change, preserving the original observations.

Operational memory retains goals, needs, assumptions, encounters, discoveries, route failures and useful summaries. Full event history belongs in the journal. Persistence must not block perception or scheduling.

### Intent and decisions

Fast safety decisions interrupt or revise ongoing work. Strategic decisions select earning, training, supply, equipment and multi-step plans.

An intent carries its desired outcome, rationale, evidence and uncertainty, prerequisites, ordered steps, budget, risk allowance, completion criteria, interruption conditions and recovery choices. Failed assumptions change later choices; changed capabilities and new evidence permit reassessment. Multi-step work succeeds only after its valuable outcome is observed.

Model providers may choose among validated candidates. Local rules retain safety authority; a late, invalid or unavailable model response cannot authorize stale work. Scheduling and interruption remain independent of model latency.

### Execution

The lifecycle is `proposed → authorized → dispatched → observed → completed / failed / timed-out / interrupted / unconfirmed`.

One arbiter per session coordinates movement, targeting, inventory and interaction resources. Safety preempts routine work. Active conversations and trades reserve enough time to finish unless danger or a deadline intervenes. Check authorization again before dispatch and reject stale continuations.

Atomic operations retain ownership until their outcome is known or their bounded protocol deadline expires. Cancellation cannot undo an already sent request. Re-observe after uncertainty; never blindly replay purchases, transfers, trades or combat. Recover through a bounded alternative, replan or reconnect, recording the reason.

### Shared behavior policies

- **Banking:** carried-gold reserve is zero. Resolve newly acquired gold through reachable banking opportunities, including after sales, loot, rewards and gifts. Verify deposits. On this shard vendors can use bank funds; that rule is shard knowledge, not a protocol guarantee.
- **Travel:** distinguish walkable areas, islands, dungeon sections, gates, teleporters and Recall. Revalidate doors and route failures; vary routes or abandon blocked destinations instead of replaying the same approach.
- **Progress:** detect repeated steps, circling and stalled outcomes across turns. Invalidate failed approaches and choose bounded recovery without mistaking travel or inventory churn for gains.
- **Safety:** observe aggression and damage continuously, interrupt routine tasks and re-evaluate before resuming. Learning and optional work yield to survival.
- **Trade:** recognize changed offers, reserve the interaction, accept understood terms and verify ownership/payment after closure. A cancelled window is not a completed trade. Secure proceeds and gifts.

## Observability

Service logs and journal events share a versioned envelope: event ID, timestamp, component, level, type/result, actor, run/deployment/session and trace/intent/decision/action/parent IDs. Unknown identities or positions remain unknown.

Record relevant targets/owners, methods, quantities, positions, duration, attempts, supporting evidence, reasons, before/after values and recovery. Include travel, skills/items/spells, crafting/orders, commerce/banking, combat/death, discoveries, decisions and interruptions. A witnessed death is not a credited kill; a recent attacker is not a confirmed killer. Human messages render structured records. Exclude credentials and secrets.

Health records expose intent/deadlines, failures, latency, event-loop lag, queue pressure, commit acknowledgements, memory and disk. Metrics and replay memory are bounded. Life-event journals retain history; diagnostic traces rotate within 512 MiB and record explicit replay gaps; acknowledged batches are fsynced, while a crash may lose the unacknowledged tail. Legacy records, missing sequences and damaged tails prevent complete replay. Replay reconstructs recorded observations and causality without executing commands.

Operating commands and storage details are in [AI documentation](packages/ai/docs/README.md). Unvalidated in-game outcomes remain in [the roadmap](ROADMAP.md).

## Remaining boundary problems

These are existing dependencies to address, not a request to split every module into a package.

| Files | Problem and reason |
| --- | --- |
| `self.ts`, `appraise.ts`, `decisions.ts`, `work-evidence.ts` | Parallel interpretations read raw session state alongside perception. `selfNow` writes checkpoint summaries and substitutes defaults for missing observations; `appraise` reduces notoriety to a danger boolean outside the shared uncertainty model. These predate the shared world model. |
| `navigation.ts`, `bank-gold.ts`, `scavenge.ts`, `wander.ts` | Navigation triggers banking, pickups and social behavior. Convenience hooks embed agent policy inside movement and create dependency cycles. |
| `goal-turn.ts`, `life.ts`, `profession.ts`, `miner.ts`, `fighter.ts`, `lumberjack.ts` | Legacy activity loops still combine planning, scheduling and execution around the newer arbiter/controller. `goal-turn → side-trade → fisher → profession → goal-turn` is a concrete cycle. |
| `resident-goal.ts`, `plan-observations.ts`, `bank-gold.ts` | Goal selection also binds live sessions, manages execution permissions and spending reservations, and subscribes to server events. Policy and runtime adapters have not been separated. |
| `danger.ts`, `danger-calls.ts` | A threat query also updates memory and sends/hears calls. Interpretation and reaction are coupled. |
| `life-actions.ts`, `life-events.ts` | Telemetry wraps session methods and waits, enriches entities through resident terrain, and classifies outcomes separately from the arbiter. Cross-layer enrichment is an adapter; duplicate lifecycle ownership is the unresolved seam. |
| `decisions.ts` / `decision-report.ts`; `resurrection.ts` / `fighter-recovery.ts` | Reverse imports reuse helpers from their callers. The former re-exports its report; the latter gets healer-gump recognition from fighter recovery. Shared helpers lack an independent home. |

Composition roots (`runtime.ts`, `run-session.ts`) and telemetry adapters (`telemetry-perception.ts`, `telemetry-health.ts`) intentionally connect layers. Their imports alone are not violations. Offline catalog builders interpret baseline files; terrain reads client map formats, not live network packets.
