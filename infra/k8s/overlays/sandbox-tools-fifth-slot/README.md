# 第五个 Sandbox 槽位

这个目录在普通 `sandbox-tools` 可选清单之上增加第五个固定工作区。它不被根生产 kustomization、生产部署脚本、持续部署工作流或普通四槽入口引用。

- `kustomization.yaml` 引用普通四槽入口，并组合第五槽资源与两个补丁。
- `workspace-slot-4.yaml` 定义第五组 1 GiB Local PV/PVC。节点名仍是不可调度占位值，启用前必须改为完成现场验证的节点。
- `runtime-capacity-patch.yaml` 把普通四槽配置修订号从三递增到四，把 Runtime 容量设为五，并显式记录第五槽已经完成真实验证。
- `quota-capacity-patch.yaml` 把 Pod、PVC、存储、CPU、内存和临时磁盘总配额调整为五槽数值。

只有普通四槽已经完成 gVisor 调度、数据盘写满、擦除复用、PVC 隔离、节点终止 finalizer、Landlock 写入白名单、PID、网络策略和双 Runtime 竞争验证后，管理员才能选择这个入口。准备第五个 loopback 文件时还必须设置 `SANDBOX_FIFTH_SLOT_LIVE_VALIDATED=true`。如果现场使用的四槽配置修订号已经高于三，管理员还必须把本补丁改成更大的下一个整数，不能回退修订号。本目录本身不会应用资源，也不会修改节点。
