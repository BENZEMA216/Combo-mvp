---
name: ship-with-proof
description: Use when starting, testing, previewing, committing, reviewing, merging, deploying, or releasing repository work, especially when product flows, code branches, worktrees, mocks, CI state, and deployed SHAs may diverge.
---

# Ship with Proof

Keep four facts aligned throughout development:

> Product source → code version → runtime environment → verification evidence

This skill prevents a reachable URL from being mistaken for the intended build, a partial mock from being described as a complete product flow, or a local commit from being described as merged and deployed.

## Trigger conditions

Use this skill whenever a task involves one or more of the following:

- starting a local, Preview, Review, staging, or Production environment;
- implementing or reviewing a multi-page user flow;
- handing off an experience URL;
- multiple branches, worktrees, dirty checkouts, or long-running development servers;
- Mock APIs, real APIs, authentication, Runtime, or mixed service modes;
- committing, pushing, opening a PR, merging, deploying, or releasing;
- diagnosing “the page is not the version we designed”;
- diagnosing 401, 502, expired sessions, missing tasks, or refresh recovery;
- claiming that a feature is complete, verified, merged, deployed, or ready to experience.

## Evidence hierarchy

Resolve conflicts in this order:

1. The user's current explicit instruction.
2. The single Product Flow Contract marked `Active`.
3. Live Git, process, service, deployment, and database evidence.
4. Test output and browser evidence from the exact build under review.
5. Historical designs, plans, and superseded documents.

A plan, prompt, design, route declaration, or passing build is not evidence that the user flow was executed.

If two active documents disagree in a way that changes pages, states, or transitions, stop implementation and report the conflict. Do not silently pick one.

## Mandatory workflow

### 1. Fix the task boundary

Before editing, record:

- objective;
- active Product Flow Contract;
- in-scope and out-of-scope behavior;
- target environment;
- data mode: `real`, `mock`, or `mixed`;
- authentication mode: `real` or `mock`;
- completion criteria.

If the mode is `mixed`, name every real and mocked component. Never use “Preview” as a synonym for “real.”

### 2. Audit the code source

Run and retain the result:

```bash
git rev-parse --show-toplevel
git branch --show-current
git rev-parse HEAD
git status --short
git fetch --prune origin
git rev-parse origin/main
git rev-list --left-right --count origin/main...HEAD
git worktree list --porcelain
```

Answer these questions before changing or starting anything:

- Is this the repository the user expects?
- Does this branch contain the intended product flow?
- Are important changes present only in a dirty checkout?
- Does another branch or worktree hold the actual implementation?
- Does the remote branch exist?
- What are the distinct Local, PR, main, Review, and Production SHAs?

Treat an existing dirty checkout as user-owned data. Never use `reset --hard`, `clean -fd`, or file replacement to make it disappear.

### 3. Use one task, one branch, one worktree

- Default branch name: `codex/<task-name>`.
- Create the worktree from an explicit, freshly verified remote SHA.
- Keep one stable worktree path for the task.
- Do not switch branches in a worktree with running services.
- After any code-version change, stop, rebuild, and restart the services.
- Do not let one port represent different branches without a restart.
- For large migrations, create a file, route, state, and test migration manifest first.

### 4. Run the runtime preflight

Before starting a review environment, inspect:

- repository absolute path;
- branch and HEAD SHA;
- current `origin/main` SHA;
- dirty and ahead/behind state;
- free disk space;
- listener PID, command, and cwd for every reused port;
- Web, API, and Runtime source versions;
- data and authentication modes;
- database, queue, identity, storage, and Runtime readiness.

Use the bundled script for the basic inventory:

```bash
bash .agents/skills/ship-with-proof/scripts/review-preflight.sh \
  --repo . \
  --port 4177
```

Disk cleanup may remove reproducible caches, stopped containers, and expired artifacts. It must not remove active worktrees, database volumes, the deployed image, diagnostic logs still in use, or the only copy of uncommitted work.

### 5. Make the environment identify itself

Every reviewable build must expose or visibly display:

```json
{
  "environment": "local-review | pr-preview | cloud-review | production",
  "repo": "/absolute/path",
  "branch": "codex/example",
  "webSha": "...",
  "apiSha": "...",
  "runtimeSha": "...",
  "dirty": false,
  "dataMode": "real | mock | mixed",
  "authMode": "real | mock",
  "startedAt": "..."
}
```

Prefer `/__meta/build` or `/version.json`, a compact non-production Build badge, and a generated runtime manifest. A URL is an entry point, not version evidence.

### 6. Maintain a page-state-transition matrix

For every page, record:

- user goal;
- actual URL;
- core entity IDs;
- preconditions;
- entry points;
- one primary action;
- exact success destination;
- refresh recovery;
- asynchronous recovery;
- error recovery;
- empty and permission states;
- real or mock data mode;
- verification evidence.

Use [the route-state template](templates/route-state-matrix.md). A route existing in source code does not prove the product flow exists. Every CTA must cause a real state transition, a real route transition, or a clearly labelled Mock transition.

### 7. Separate three validation layers

#### Static visual review

Use it for layout, copy, responsive behavior, theme, and component states.

#### Mock complete-flow review

Use it to exercise every page, state, and transition. A Mock must be visibly labelled, share the real API schema, use reproducible fixtures, and survive refresh/re-entry. Mock login and Mock publishing are not real-service proof.

#### Cloud Review real-flow validation

Use it to verify real authentication, APIs, persistence, asynchronous jobs, Runtime behavior, publishing, and the public result.

None of these validation layers substitutes for another.

### 8. Verify the complete product path

“Complete flow is ready to experience” is allowed only when:

- the user starts at the public entry and never edits the URL manually;
- every supported creation method reaches the same Draft/Agent model;
- authentication returns to and claims the original anonymous work;
- refresh and browser back do not lose the current task;
- asynchronous work can be resumed from a persistent progress surface;
- content, behavior, and UI can be edited repeatedly;
- saving, refreshing, previewing, testing, and editing again all work;
- the product has a clear transition from iteration to pricing;
- pricing, naming, confirmation, result, and public page are connected;
- a published Agent can create a new editable version;
- at least one success path and the critical recovery paths were exercised;
- screenshots, URLs, SHAs, logs, and test results are retained.

If only the Landing page, login, a list, or part of Runtime was tested, report “partial pages are reviewable.”

### 9. Guard the product expression

- Each page needs one clear primary action.
- Use user-goal language, not internal implementation language.
- Do not expose terms such as Runtime, Artifact, internal Revision IDs, or Review infrastructure unless the audience is technical.
- Do not show unavailable menu actions or dead buttons.
- Generating states must show the actual stage, what is preserved, whether the user may leave, and how to return.
- Keep useful page context visible instead of replacing the entire page with an uninformative loading card.
- Separate completed Agents from in-progress creation tasks.
- Give in-progress work a persistent “continue” entry.
- Error states must explain what happened, whether data is safe, and the next recovery action.

Prefer goal-specific labels:

- `Edit UI` → `Modify page`
- `Test` → `Try Agent`
- `Finish editing` → `Satisfied, continue to pricing`
- `View` → `Open page`, `View test result`, or `View version`

### 10. Require actionable observability

Follow three invariants:

- never show a bare spinner;
- never expose internal error codes;
- never discard generated content.

Every user-visible failure must communicate:

```text
what happened
whether generated data is preserved
what the user can do now
whether to retry, sign in, or change input
the traceId for support
```

Web, API, and Runtime logs should include `traceId`, environment, build SHA, user/session/draft/job identifiers, and dependency readiness. A 401, 502, or expired connection without traceable evidence blocks real-flow acceptance.

### 11. Use precise Git and release language

The standard sequence is:

```text
develop
→ verify locally
→ commit
→ push
→ pull request
→ CI passes
→ merge to main
→ deploy Cloud Review
→ post-deploy E2E
→ release Production
```

Each claim requires evidence:

| Claim                    | Required evidence                                 |
| ------------------------ | ------------------------------------------------- |
| Developed                | Worktree and changed files                        |
| Verified                 | Commands, results, and tested SHA                 |
| Committed                | Commit SHA                                        |
| Pushed                   | Remote branch and remote SHA                      |
| PR created               | PR URL                                            |
| CI passed                | Check results for the same SHA                    |
| Merged to main           | Main SHA and ancestor proof                       |
| Review deployed          | URL, deployment ID, served SHA                    |
| Production released      | Production URL, served SHA, smoke result          |
| Complete flow reviewable | Entry, auth method, path, modes, and E2E evidence |

Never collapse these states. Prefer promotion of one immutable artifact from Review to Production rather than rebuilding separately.

## Hard-stop conditions

Continue diagnosing, but stop claiming “ready,” “complete,” or “released” when:

- the running process cwd, branch, or SHA is unknown;
- active product sources conflict;
- Web, API, and Runtime unexpectedly mix versions;
- a reused port still belongs to an old worktree;
- a dirty user checkout conflicts with the migration scope;
- real authentication is unavailable for a real-flow test;
- 401, 502, and job failures lack logs or trace IDs;
- PR, main, and deployed SHAs cannot be reconciled;
- manual URL editing is required to continue;
- refresh or re-entry loses the current Draft, Agent, or stage.

## Five red lines

1. Unknown directory, branch, or SHA: do not provide an experience URL.
2. The path was not exercised from entry to result: do not call it complete.
3. Remote main and served SHA were not verified: do not call it merged and released.
4. Mock and real boundaries are unclear: do not begin product acceptance.
5. Product sources conflict: do not keep adding pages.

## Output contract

Every handoff must use [the delivery card](templates/delivery-card.md). Use [the release evidence template](templates/release-evidence.md) for GitHub and deployment claims.

If no shareable environment exists, say exactly:

> There is currently no shareable experience environment.

Do not substitute local success for that statement.

## Combo profile

When this skill is used in Combo, read [the current Combo flow profile](references/combo-product-flow.md) after this file. The Product Flow Contract marked `Active` in the repository still overrides that profile.
