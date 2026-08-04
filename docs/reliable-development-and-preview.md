# 稳健开发与 Preview 发布方法

本方法把“写了代码”“合入 main”“Preview 正在运行该代码”分成三类独立事实。任何一步缺少 SHA 或验收证据，都不能用下一步的 URL 代替。

## 1. 固定开发拓扑

- 权威仓库：`dangdang-tech/Combo`。
- 主控制检出只用于 fetch、创建和清理工作树，不编辑产品文件。
- 每个任务使用独立工作树、独立分支和独立 PR。
- macOS 工作树放在 `~/Developer` 等本地目录，不放在 `Documents`、`Desktop`、`Library/CloudStorage` 或 `Library/Mobile Documents`。这些目录可能由 FileProvider 托管，使 Git 的逐文件读取卡死。
- 不从损坏或来源不明的旧目录复制 `.git`、`node_modules` 或未审计改动。

建议的首次控制克隆：

```sh
mkdir -p "$HOME/Developer/Combo-worktrees"
git clone https://github.com/dangdang-tech/Combo.git "$HOME/Developer/Combo-control"
```

开始任务前先获取 `origin/main`，再通过守卫生成创建计划：

```sh
git -C "$HOME/Developer/Combo-control" fetch --prune origin
python3 "$HOME/Developer/Combo-control/.agents/skills/github-collaboration/scripts/worktree_guard.py" \
  plan-create \
  --repo "$HOME/Developer/Combo-control" \
  --base-remote origin \
  --push-remote origin \
  --type fix \
  --slug example-task \
  --path "$HOME/Developer/Combo-worktrees/example-task"
```

核对计划后执行它输出的 `git worktree add` 命令。进入干净的新工作树，先用不依赖 `node_modules` 的入口检查环境，再安装依赖：

```sh
bash scripts/dev-preflight.sh
pnpm install --frozen-lockfile
```

`dev-preflight.sh` 失败时不要开始编辑。它不自动安装依赖、删除文件或修复 Git；先处理明确的阻塞原因，再重新检查。依赖已经存在时，也可以使用等价的 `pnpm dev:preflight` 便捷命令。

## 2. 磁盘与缓存边界

最低可用磁盘为 20 GiB，完整构建与浏览器验收前建议至少 30 GiB。只清理经过大小和路径核对的可再生缓存。

可以考虑清理：旧的构建临时目录、包管理器下载缓存、Xcode DerivedData、Playwright 浏览器缓存和应用更新缓存。

禁止纳入自动清理：

- `~/.combo/uploads`：可能包含可续传上传快照。
- `~/.codex/sessions`、`archived_sessions` 和数据库：属于任务历史。
- 任何源码工作树、未提交文件、发布证据或用户文档。
- 未先列出精确路径和大小的递归目标。

## 3. 本地质量门禁

改动完成后先运行定向测试，再运行完整 PR 门禁：

```sh
pnpm -F @cb/shared build
pnpm format:check
pnpm lint
pnpm typecheck
pnpm typecheck:test
pnpm test:local
```

`test:local` 会运行应用测试、Preview 身份验证器测试和工作树守卫测试，但不运行依赖 Linux/GNU 主机语义的控制面契约；该部分必须由 GitHub Actions 在 Linux 上执行 `pnpm test:fast`。Main CD 的 `pnpm test` 也覆盖新增的守卫和验证器。不得为了让 macOS 通过而放宽生产部署脚本。

之后运行 `worktree_guard.py check-pr-ready`。工作树不干净、落后 `origin/main`、提交未推送或分支没有正确上游时，不创建 PR。

## 4. PR、main 与 Preview

1. 只提交本任务文件，推送任务分支并创建 PR。
2. 等待 PR CI 全部通过，解决未完成 review，再合入 `main`。
3. 记录 PR 的 merge SHA；分支 SHA 和 merge SHA 不能混用。
4. 等待 Main CD 成功并产出该 merge SHA 的不可变 release artifact。
5. 等待 Preview promotion 成功。
6. 复验线上发布身份：

```sh
pnpm release:verify:preview -- --expected-sha <main-merge-sha>
```

7. 在云端浏览器从真实入口完成本次用户链路，至少覆盖刷新、返回、重新进入和错误恢复。

最终交付必须同时给出：PR、merge SHA、Main CD run、Preview promotion run、`version.json` 对齐结果和浏览器验收结果。任一项缺失时，状态只能写“未完成”或“被阻塞”。
