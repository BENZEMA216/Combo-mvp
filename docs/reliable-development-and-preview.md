# 稳健开发与 Preview 发布方法

本方法把“写了代码”“合入 main”“Preview 正在运行该代码”分成三类独立事实。任何一步缺少 SHA 或验收证据，都不能用下一步的 URL 代替。

按当前任务读取相关章节。首次配置环境使用第 1、2 节，准备 PR 使用第 3 节；第 4 节只适用于本次已经包含 Preview 发布的任务。开发完成、PR 就绪、合并和部署分别报告，不以未授权的后续阶段阻塞本次交付。

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

下面示例用于拥有规范仓库写权限的协作者。外部 fork 贡献者使用已核对的 `upstream` 默认分支作为基线、`origin` 作为推送远端；相应替换示例参数。`dev-preflight.sh` 默认沿用守卫的远端解析，也支持显式传入这三个参数，不要求 fork 的 `origin` 指向官方仓库。

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

测试命令以根 `package.json` 和 `.github/workflows/pr-ci.yml` 为准。目前 `test:local` 与 `test:fast` 是同一条命令：排除 `@cb/scripts` 的工作区测试，再执行 `test:workflow-contracts`，其中包括 Preview 身份验证器和工作树守卫。CI 在 Linux 上设置 `COMBO_RUN_CONTAINER_CONTRACTS=0` 执行 `test:fast`；相同命令不证明不同系统或环境变量下的实际执行范围相同，应报告条件跳过项。Release build 的 `pnpm test` 还执行 `@cb/scripts`。不得为了本地通过而放宽生产部署脚本。

之后运行 `worktree_guard.py check-pr-ready`。工作树不干净、落后 `origin/main`、提交未推送或分支没有正确上游时，不创建 PR。

## 4. PR、main 与 Preview

本节的执行与完成条件仅适用于用户已经授权 Preview 发布的任务；单独的本地修复、PR 或合并按各自范围交付。

1. 只提交本任务文件，推送任务分支并创建 PR。
2. 等待 PR checks 全部通过，解决未完成 review，再合入 `main`。
3. 记录 PR 的 merge SHA；分支 SHA 和 merge SHA 不能混用。
4. 等待 Release build 成功并产出该 merge SHA 的不可变 `combo-build-<SHA>` 构建清单。
5. 等待 Deploy 将同一 SHA 自动部署到 Preview 成功。
6. 复验线上发布身份：

```sh
pnpm release:verify:preview -- --expected-sha <main-merge-sha>
```

Preview 发布完成时必须同时给出：PR、merge SHA、Release build run、Deploy run 和 `version.json` 对齐结果。缺少任一项时，Preview 发布阶段尚未完成；此前已验证的开发、PR 或合并阶段仍按事实独立报告。
