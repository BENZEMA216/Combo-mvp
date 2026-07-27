# Sandbox Tools 可选清单

这个目录提供 Runtime 模型工具的可选 Kubernetes 接线。根生产 kustomization 和生产部署脚本不引用这里。持续部署的 `rsync` 命令显式排除本目录并清理服务器旧残留。当前入口只用于静态渲染和获批后的独立维护，不会自动启用生产功能。

## 资源职责

- `kustomization.yaml` 组合 Runtime 快照、隔离命名空间、固定工作区、权限、资源配额、网络策略和 Runtime 补丁。
- `runtime-base.yaml` 保存现有 Runtime Service 与 Deployment 的本地快照。静态测试要求它除显式命名空间外与生产清单一致。
- `namespace.yaml` 创建 `combo-sandbox` 命名空间，并请求 restricted 等级的 Pod Security 策略。
- `workspace-slots.yaml` 创建一个不自动制备的 StorageClass，以及四组固定的 Local PV/PVC。每组声明容量为 1 GiB，并预绑定同编号槽位。PVC 上由 Runtime 写入的分配状态不属于声明式清单字段，重复应用清单不会把隔离状态重置为空闲。
- `rbac.yaml` 允许 Runtime ServiceAccount 读取、列出、创建、删除和修补沙箱 Pod，并读取和修补现有 PVC。Pod 修补只用于槽位 finalizer，PVC 修补只用于原子分配和隔离状态；Runtime 不能创建或删除 PVC。
- `resource-limits.yaml` 把普通容量限制为四个 Pod 和四个 PVC，并把单容器 CPU、内存和临时磁盘边界固定下来。
- `network-policy.yaml` 默认拒绝沙箱全部入站和出站网络，只允许 `combo` 命名空间中带 `app=runtime` 标签的 Pod 访问 sandboxd 的 8080 端口。
- `runtime-patch.yaml` 显式开启沙箱工具，并配置沙箱修订号、四槽容量、gVisor、摘要镜像、签名私钥、回收时间和三十分钟绝对生命周期。
- `maintenance/prepare-loopback-slots.sh` 在指定节点上把数据盘中的四个固定 ext4 镜像挂载到 Local PV 路径。脚本不调用 Kubernetes，也不重启 k3s。
- `maintenance/runtimeclass-gvisor.yaml` 只是未引用的 RuntimeClass 样例，不会安装 runsc。
- `render.test.mjs` 静态断言可选边界、Runtime 快照、四槽存储、资源配额、最小权限、网络策略、摘要镜像和第五槽隔离。

## 普通资源边界

普通入口只包含四个槽位。sandboxd 没有 Deployment，也没有预创建 Pod。Runtime 第一次收到已授权工具调用时才竞争固定名称并创建普通 Pod。

每个 Pod 使用以下边界：

- CPU 请求为 100m，上限为 500m。
- 内存请求和上限都是 384 MiB。
- `/workspace` 挂载同编号 PVC。PVC 对应数据盘上的 1 GiB ext4 loopback 块设备。
- `/tmp` 使用 256 MiB 的内存卷。
- sandboxd 把文件描述符上限设为 128，把用户进程软硬上限设为 256。
- Pod 空闲十五分钟后可以回收；动态 Pod 的 `activeDeadlineSeconds` 和 Runtime 清扫都把绝对生命周期限制在三十分钟内。

固定槽位会被不同 Session 依次复用。Runtime 在创建 Pod 前先用 PVC 资源版本写入 Session 和随机分配编号，Pod 创建完成后再绑定其 UID。每个新 Pod 的初始化容器必须先运行 `wipe-workspace`，清空挂载点后主容器才会启动。PVC 使用 Retain 策略，不会因为 Pod 删除而丢失块设备，因此清空步骤是跨 Session 隔离的一部分。

每个动态 Pod 都带有 `sandbox.combo.dev/await-node-termination` finalizer。Runtime 发起删除前先把 PVC 标为隔离，再等待同一 UID 的主容器和初始化容器都由节点报告为终止，之后才移除 finalizer。原 UID 消失后，Runtime 才清除 PVC 分配标记。节点分区、对象被强制移除或终止状态缺失时，PVC 标记继续占用固定槽位，所有副本都会拒绝复用。Bash 由 Landlock 包装器启动，只能写 `/workspace`、`/tmp` 和 `/dev/null`，不能写 Kubernetes 的 `/dev/termination-log`。

## 数据盘准备

`workspace-slots.yaml` 中的节点名是故意不可调度的 `sandbox-node.invalid`。管理员必须在维护窗口选择真实数据盘和真实节点，先准备 loopback 槽位，再把所有 PV 的节点名改成已验证的 `kubernetes.io/hostname` 值。

数据目录必须位于独立挂载的数据盘，不能位于根文件系统。下面的脚本会创建四个恰好 1073741824 字节的 ext4 文件，为每个文件安装 systemd mount unit，并挂载到 `/var/lib/combo-sandbox-slots/slot-N`。脚本需要 root，但不会调用 `kubectl`，也不会停止或重启 k3s。

```sh
sudo infra/k8s/overlays/sandbox-tools/maintenance/prepare-loopback-slots.sh /mnt/data/combo-sandbox-images 4
```

脚本会核对数据目录确实位于独立挂载点，并核对每个 loop 设备的块大小和 backing file。它还会删除 ext4 初始化生成的 root 属主 `lost+found`，再把挂载根交给对应槽位 UID，保证非特权初始化容器能够完成首次擦除。清单中的 `requests.storage: 1Gi` 只用于 Kubernetes 绑定；真正的物理上限来自固定大小的 loopback 块设备。

## 第五槽门禁

`infra/k8s/overlays/sandbox-tools-fifth-slot/` 是独立维护入口。它增加第五组 PV/PVC，把配额调整为五，并同时把普通配置修订号从三递增到四，设置 `SANDBOX_CAPACITY=5` 和 `SANDBOX_FIFTH_SLOT_VALIDATED=true`。

只有四槽在真实节点完成 gVisor 调度、磁盘写满、跨 Session 擦除、PID、NetworkPolicy 和双 Runtime 竞争验证后，才允许准备第五个 loopback 文件并选择这个入口。准备第五槽时还必须显式设置脚本门禁：

```sh
sudo env SANDBOX_FIFTH_SLOT_LIVE_VALIDATED=true \
  infra/k8s/overlays/sandbox-tools/maintenance/prepare-loopback-slots.sh \
  /mnt/data/combo-sandbox-images 5
```

代码只识别最多五个固定名称，不会创建任意数量的槽位。

## 镜像和身份

sandboxd 镜像由 `infra/Dockerfile.sandboxd` 构建。`runtime-patch.yaml` 中的全零 SHA-256 摘要是不可运行的占位值，启用前必须替换为经过验证的不可变摘要。Runtime 会拒绝可变标签和 `gvisor` 以外的 RuntimeClass。当前四槽清单使用配置修订号三；后续轮换镜像、公钥、容量或安全规格时必须继续递增，不能只替换值。

普通可选入口当前使用配置修订号三，因为命令写入边界、PVC 原子分配和槽位终止证明都属于安全规格。`combo` 命名空间需要 `combo-sandbox-signing` Secret。私钥只进入 Runtime，sandboxd Pod 只获得运行时派生的公钥。`combo-sandbox` 命名空间还需要镜像拉取 Secret，但 sandboxd Pod 不挂载 ServiceAccount 令牌。

## 静态检查

```sh
kubectl kustomize infra/k8s/overlays/sandbox-tools >/tmp/combo-sandbox-tools.yaml
pnpm -F @cb/infra test
```

这些命令只读取和渲染本地文件，不连接或修改集群。静态通过不代表 gVisor、Local PV 调度、CNI NetworkPolicy 或 k3s 已经现场验证。未获批时不得应用清单、安装 runsc 或重启 k3s。
