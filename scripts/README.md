# 发布与运维脚本

本目录保存仓库级的本地验证、环境部署和运维脚本。脚本不得读取或提交环境密钥；需要凭据的部署步骤由受保护的 GitHub Environment 注入，并在调用脚本前完成来源与产物校验。

`release-manifest.mjs` 创建和校验不可变发布清单。清单固定记录源码提交、发布编号、API、Runtime、Web 三个镜像摘要、数据库迁移头、构建时间和 Web 静态资源清单摘要。校验只接受指定 GHCR 仓库的 `repository@sha256:digest`，并拒绝可移动标签、额外字段、符号链接和非规范 JSON。

`web-asset-manifest.mjs` 为 Web 与 Runtime Web 的构建产物生成确定性的内容摘要清单。发布流水线从 Web 镜像读取这份清单，将其摘要写入发布清单和运行时版本信息。

`combo-dev-*` 脚本管理共享 Test 环境。`deploy-k8s.sh` 与 `smoke.sh` 管理 Production 的 Kubernetes 更新和基础冒烟。Preview 使用独立的 `combo-review` 命名空间、凭据和部署入口，不得调用 Test 的重置、存储或端口迁移脚本。
