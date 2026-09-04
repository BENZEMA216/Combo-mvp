# Delivery evidence contract

## Environment vocabulary

| Name         | Meaning                                              |
| ------------ | ---------------------------------------------------- |
| Local Review | Local process; may contain uncommitted code          |
| PR Preview   | Immutable environment built from a PR SHA            |
| Cloud Review | Shared cloud test environment serving a declared SHA |
| Production   | The public production environment                    |

Never use these names interchangeably.

## Claim-to-evidence mapping

| Claim                    | Minimum evidence                                             |
| ------------------------ | ------------------------------------------------------------ |
| Developed                | Repository, worktree, branch, changed files                  |
| Verified                 | Exact command, result, and HEAD SHA                          |
| Committed                | Commit SHA                                                   |
| Pushed                   | Remote branch and `ls-remote`/API SHA                        |
| PR created               | PR URL, base, head                                           |
| CI passed                | Checks for the same head SHA                                 |
| Merged                   | Merge/main SHA and ancestor proof                            |
| Review deployed          | Deployment ID, URL, served SHA                               |
| Production released      | Production URL, served SHA, smoke result                     |
| Complete flow reviewable | Entry, auth method, data mode, tested path, screenshots/logs |

## Deployment identity

Every reviewable environment should expose:

```json
{
  "environment": "cloud-review",
  "repo": "dangdang-tech/Combo",
  "branch": "main",
  "webSha": "...",
  "apiSha": "...",
  "runtimeSha": "...",
  "dirty": false,
  "dataMode": "real",
  "authMode": "real",
  "startedAt": "2026-08-03T12:00:00Z"
}
```

When the environment cannot provide component identity, it cannot be used as release evidence.
