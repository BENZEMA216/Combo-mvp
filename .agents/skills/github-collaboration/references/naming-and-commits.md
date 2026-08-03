# GitHub 贡献命名、提交与拉取请求约定

## 任务短名

- 使用 ASCII 小写短横线形式：`resend-email-otp`。
- 使用领域和行为描述任务，不使用 `misc`、`changes`、`wip`、日期或智能体的临时对话编号。
- 有 Issue 时以十进制编号开头：`123-resend-email-otp`。
- 并行子任务必须有不同且稳定的短名，例如 `123-resend-email-otp-api` 与 `123-resend-email-otp-ui`；不要让两个智能体争用同一分支。

## 分支名

格式为 `<type>/<task-slug>`：

- `feat/123-resend-email-otp`
- `fix/pr-ci-merge-identity`
- `refactor/sandbox-state-store`
- `test/storage-guard-timer`
- `docs/local-agent-workflow`
- `ci/shellcheck-gate`
- `chore/worktree-collaboration-skill`

允许的类型为 `feat`、`fix`、`refactor`、`perf`、`test`、`docs`、`ci`、`build` 和 `chore`。不要使用人名作为主要分类；负责人记录在任务元数据中，分支名表达变更目的。

## 工作树路径

默认在主检出目录的同级目录使用 `<repo>-wt-<type>-<task-slug>`，并把 `/` 转为 `-`：

```text
/workspace/Combo
/workspace/Combo-wt-feat-123-resend-email-otp
```

路径不得位于仓库内部，不得指向已存在目录，也不得依赖未经解析的环境变量或通配符。路径过长时可压缩领域词，但分支和路径仍应能互相对应。

## 约定式提交

提交主题格式为 `<type>(<optional-scope>): <imperative-summary>`。常用类型与分支一致，另外可以使用 `revert`。示例：

```text
feat(auth): 增加邮件验证码重发流程
fix(ci): 验证拉取请求合并提交身份
test(storage): 覆盖周期性防护计时器
docs: 说明本地智能体工作树生命周期
```

- 主题使用祈使语气，说明改变了什么，不写过程日志。
- 一次提交只表达一个可复核的逻辑变化，并包含使该变化成立的测试或文档。
- 破坏性变更使用 `!` 和 `BREAKING CHANGE:` 脚注，并在拉取请求中解释迁移影响。
- 关联 Issue 使用 `Refs:`；只有拉取请求合并确实应该关闭 Issue 时才使用 `Closes:`。
- 不在提交信息中写密钥、客户数据、内部地址或对话转录。

## 拉取请求标题和正文

拉取请求标题沿用约定式提交格式，使压缩合并生成的最终提交可以直接使用。正文至少包含：

1. `问题`：用户或维护者为什么需要这项变化。
2. `方案`：核心行为和关键取舍。
3. `范围`：包含与明确不包含的内容。
4. `验证`：实际运行的命令、结果，以及未运行项与原因。
5. `版本`：创建工作树时的基准 SHA、当前提交 SHA；涉及运行体验时说明环境返回的组件 SHA。
6. `运行模式`：涉及可运行产品时说明 Real、Mock、Mixed 边界和实际体验范围。
7. `风险`：兼容性、迁移、权限、安全、性能和回滚关注点。
8. `关联`：Issue、依赖拉取请求、截图或其他可复核证据。

草稿拉取请求可以用于提前协作，但不能跳过本地门禁。准备好正式复核时移除草稿状态，并确保描述与当前提交一致。
