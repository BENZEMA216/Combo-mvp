# Sandbox Tools 测试环境清单

这个目录只用于在 `combo-review` 测试 Runtime 上验证 PR #110，不会被生产根清单或持续部署引用。动态沙箱单独运行在 `combo-review-sandbox` 命名空间，避免与测试数据库、Redis、MinIO 和 Runtime 共享网络边界。

`kustomization.yaml` 只聚合沙箱命名空间、四组静态本地卷、最小权限、配额和网络策略。`runtime-patch.yaml` 单独保存测试 Runtime 的接线，默认保持 `SANDBOX_TOOLS_ENABLED=false`，不得和基础资源一起直接应用。

四个 PV 使用测试专用的 `combo-review-sandbox-loopback` StorageClass，节点固定为 `vm-0-12-opencloudos`。PVC 名仍使用 Runtime 代码要求的 `combo-sandbox-workspace-slot-0` 至 `combo-sandbox-workspace-slot-3`，但它们位于测试沙箱命名空间，因此不会与未来生产 PVC 冲突。物理路径是 `/var/lib/combo-sandbox-slots/slot-0` 至 `slot-3`，对应数据盘中的四个 1 GiB loopback 文件系统。

测试用 `sandboxd` 镜像从 PR #110 的提交 `edc1b3d72b2b91345a91330145e687b78f2d27eb` 构建，并已导入当前单节点 k3s。`runtime-patch.yaml` 使用不可变摘要 `sha256:23d4c64fdcdbba89b1d091bad59b1dd36b65d67c046046179ed8352a36728226`。这个摘要只保证当前节点本地镜像；节点清理或换节点后必须重新导入相同镜像。

部署顺序如下：

1. 先运行主机准备脚本，确认四个 loopback 挂载和 1 GiB 物理上限。
2. 渲染并应用这个目录，等待四个 PVC 全部 Bound。
3. 在 `combo-review` 创建独立 Ed25519 签名私钥 Secret。
4. 先把 PR Runtime 镜像部署到测试 namespace，保持沙箱功能关闭并确认健康。
5. 单独应用 `runtime-patch.yaml`，再开始单 Session 和四槽现场验收。

测试结束时先关闭功能，等待所有动态 Pod、runsc shim 和槽位分配状态收口，再决定保留或删除测试资源。状态不明确的槽位不得直接重用。
