# 发布主机回环转发

本目录保存三环境的 Web 与 MinIO/S3 回环转发 systemd 单元模板。所有单元只监听 `127.0.0.1`，通过集群内 ClusterIP Service 转发流量，不使用 NodePort，也不负责读取或恢复 Secret。

六个单元：

| 单元                                  | 监听端口 | 目标 namespace / Service             |
| ------------------------------------- | -------- | ------------------------------------ |
| `combo-test-web-forward.service`      | `18083`  | `combo-test` / `web`                 |
| `combo-test-s3-forward.service`       | `19003`  | `combo-test` / `minio`               |
| `combo-preview-web-forward.service`   | `18081`  | `combo-preview` / `web`              |
| `combo-preview-minio-forward.service` | `19001`  | `combo-preview-foundation` / `minio` |
| `combo-prod-web-forward.service`      | `18082`  | `combo-prod` / `web`                 |
| `combo-prod-minio-forward.service`    | `19002`  | `combo-foundation` / `minio`         |

Preview 的 MinIO forwarder 指向独立的 `combo-preview-foundation`，Production 则指向 `combo-foundation`；两个环境不共享对象存储或其他 foundation 数据。

单元以 `User=xingzheng` 运行，使用 `~/.kube/config` 建立 `kubectl port-forward`。Preview 发布会在任何 k8s mutation 前验证 sudo、systemd unit 和端口归属；首次切换停止旧 forwarder 并缩容旧应用，失败时维持 502，不回接共享数据面。只有 unit 内容变化时才安装并重启。系统 Nginx 的 server 块（`test.43-160-242-46.sslip.io`、`review.43-160-242-46.sslip.io`、`agora.43-160-242-46.sslip.io` / `buildwithcombo.com`）把对应域名反代到这些 loopback 端口。
