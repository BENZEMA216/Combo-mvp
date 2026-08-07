# Agent Review V2 rollout

`codex/combo-v2-codex-first` is a Test-only feature candidate. Its functional contract is complete
for an isolated Test deployment, but the current diff must not be merged unchanged into the
Preview/Production promotion chain.

## Why direct promotion is unsafe

Preview and Production share `combo-foundation`, migrations run before application rollout, and
Authoring and Runtime roll independently.

1. Migration `0014` makes every new Release require Review columns. An old Production Authoring
   process still omits those columns, so once Preview migrates the shared database, Production
   publish requests fail until Production is upgraded.
2. The new Runtime adds `qualityStatus`, `canPublish`, and nullable `review` to strict Test response
   objects. An old Authoring process rejects those additive fields, so an old Authoring pod talking
   to a new Runtime returns a dependency-contract failure during a mixed rollout.

Test has its own foundation, so this candidate may be deployed there only with a quiet rollout
window and acceptance after every Authoring and Runtime pod reports the same candidate SHA. That
does not prove Preview/Production rollout safety.

## Required production sequence

Promotion requires three separately deployable revisions:

1. **Reader compatibility:** deploy Authoring everywhere with Test response readers that tolerate
   the future additive quality fields, while Runtime and the database still use the old contract.
2. **Expand and write:** add the nullable Review table/Release columns without the global hardening
   trigger; deploy the new Authoring and Runtime writers/readers through Preview and then Production.
   The new Authoring service must require a publishable Review even though old application versions
   remain schema-compatible during this phase.
3. **Enforce:** after both environments and every replica run the Review-aware application, apply a
   later migration that fails closed on a missing or non-publishable Review for every new Release.

Each phase needs its own immutable commit, CI evidence, Preview SHA verification, and Production
confirmation. Do not place all three migrations in one source revision because the migration runner
applies every pending file before application rollout.

## Acceptance gates

- Existing pre-Review Releases remain readable with null Review proof.
- Mixed-version contract probes pass in both directions before each rollout.
- New Review-aware Authoring rejects unreviewed publish before the database hardening phase.
- The final database trigger rejects a direct Release insert with null Review and accepts a passed
  Test bound to a publishable immutable Review.
- Preview and Production return the same promoted source SHA before the next phase starts.
