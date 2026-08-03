# Combo product-flow profile

Status: reference profile
Updated: 2026-08-03
Authority: an `Active` Product Flow Contract in the repository overrides this profile.

## Default end-to-end path

```text
Landing
→ Choose one of two equal-weight Context preparation methods
  ├─ Copy a task to a Coding Agent
  └─ Submit a public profile link or content
→ Upload or synchronize Context
→ Bind email and claim the anonymous Draft
→ Generate Agent
→ Repeatedly adjust content, behavior, and UI
→ Try the Agent on a real task
→ Satisfied, continue to pricing
→ Choose a pricing method
→ Name the link or subdomain
→ Confirm publication
→ Publication result and public page
```

Both Context preparation methods must create the same Agent Draft model and converge on the same adjustment, testing, pricing, naming, and publishing states.

## Required adjustment loop

```text
modify
→ save a new version
→ preview
→ run a real task
→ continue modifying OR proceed to pricing
```

Users must be able to leave, refresh, sign in again, and return to the same Draft, Agent, version, and stage.

## Navigation responsibilities

- Landing: explains the result and offers both Context methods with equal visual weight.
- Creation progress: owns uploads, extraction, generation, asynchronous work, failures, and resumability.
- My Agents: owns Agents that have already been formed.
- Current creation: persistent navigation entry for the most recent unfinished task.
- Agent Studio: owns repeated content, behavior, and UI changes plus preview and real-task testing.
- Pricing and publishing: starts only after explicit user acceptance of the tested version.

## Pricing baseline

The current product direction includes three choices:

1. per-use pricing;
2. margin pricing based on inference cost;
3. time-based pricing.

## Completion boundary

The experience is not complete merely because the Landing page, login, Agent list, or Runtime opens. It is complete only when the user can traverse the path from Landing to a public result without manually editing the URL, and can resume after interruption.
