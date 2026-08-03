# Ship with Proof

Ship with Proof is a development and delivery guardrail for keeping product intent, code identity, runtime identity, and verification evidence aligned.

It is designed for work involving multiple pages, worktrees, Mock and real services, Preview/Review environments, CI/CD, and production releases.

Feishu backup: [Ship with Proof: Combo 开发与交付守门手册](https://zcndjgnt0026.feishu.cn/docx/WQg3d7MaKomhH6xBymVcD1p0nLc)

## Use

Invoke the skill when starting or handing off development work:

```text
Use $ship-with-proof to start this feature in a clean worktree and prepare a review environment.
```

```text
Use $ship-with-proof to verify whether this URL is the intended branch and whether the full flow is actually reviewable.
```

## Included resources

- `SKILL.md` — mandatory guardrail workflow and stop conditions.
- `references/combo-product-flow.md` — Combo's current default end-to-end profile.
- `references/evidence-contract.md` — claim-to-evidence rules.
- `templates/product-flow-contract.md` — active product-flow source template.
- `templates/route-state-matrix.md` — page, state, transition, and recovery inventory.
- `templates/delivery-card.md` — experience handoff contract.
- `templates/release-evidence.md` — Git/CI/deployment evidence record.
- `scripts/review-preflight.sh` — read-only repository, version, disk, and port inventory.
- `scripts/release-report.sh` — consistent delivery-card generator.

## Safety

The scripts do not clean, reset, commit, push, merge, deploy, or print secrets. They collect evidence. Mutating actions remain explicit steps performed only within the user's authorized scope.
