# 发布主机回环转发

本目录保存 Preview 与 Production 的 Web、MinIO 回环转发 systemd 单元。四个单元只监听 `127.0.0.1`，通过集群内 ClusterIP Service 转发流量，不使用 NodePort，也不负责读取或恢复 Secret。

Web 单元从 `/etc/combo-release` 下的单行环境文件读取精确、SHA 隔离的 Web Service 名称。MinIO 使用环境共享的固定 release Service。`scripts/switch-release-traffic.sh` 校验仓库文件和已安装 unit 的摘要一致后才会重启服务，并确认每个端口只有对应主进程持有的一个 IPv4 loopback listener。

Production 的 canary Nginx 和正式域名 Nginx 是两个独立 CAS 目标。正式域名配置保留现有 TLS 指令，只把 `buildwithcombo.com`、`www.buildwithcombo.com` 和兼容 sslip 名称所在 server 块的四个获准 upstream 整体切到 Production Web forwarder。

每次切流前，控制器把两份 Nginx 配置、Web 环境文件和 systemd 单元快照写入由 root 拥有的持久检查点。这里保存的是配置与非敏感服务指针，不复制证书、私钥、Kubernetes 凭据或其他 Secret。Production 在六区验收完成前保留上一份 release；验收失败可以恢复检查点，验收通过并清理旧对象后才封存检查点。

切流控制器在专用主机锁内先把持久检查点从 `armed` 提交为 `activated`，再原子更新发布流量目录中的 `current.json`，最后原子写入调用方指定的流量证据。Production 部署把这份证据直接落到发布证据根目录的临时持久路径，并在延迟清理退出前把它复制到带摘要集合的激活目录。检查点还是 `armed` 但实时路由已经指向候选时，续跑会复验已有流量证据，或者通过同一切流事务补齐缺失证据，然后再推进本地 `post-cut` 状态。

Production 最终化把精确的清理目标和 UID 持久化在激活目录中，并在删除任何旧对象前把清理计划摘要写入发布侧 `finalizing` 检查点。随后主机控制器在流量锁内复验实时 Nginx、转发单元、监听器和候选身份，把同一清理计划摘要写入 root 所有的 `finalizing` 流量检查点；从这一刻起不再允许回滚。续跑始终使用同一份清理计划。清理完成后，控制器再次复验实时流量，把主机检查点推进到 `sealed`，清理证据、预清理流量证据和封存证据继续保存在激活目录中。

回滚事务恢复 Nginx、转发单元和实时旧版本后，依次提交 `rolled-back` 检查点、前一份 release 的 `current.json` 和回滚证据。首次接管前没有前一份 release 时，第二步会删除 `current.json`。部署控制器可以从这三个提交之间的中断继续恢复；检查点可以是 `activated` 或 `rolled-back`，其中 `activated` 状态还必须由激活目录中的流量证据及其摘要集合证明。已有 `current.json` 只能表示候选或前一份 release，未知状态会在任何持久写入前失败。候选对象只在最终回滚证据提交后清理。

主机检查点进入 `finalizing` 后不再提供流量回滚。`finalizing` 续跑会把封存检查点中的清理证据摘要与激活目录中的持久清理证据逐字匹配，复用已经完成的清理和封存结果，再继续提交最终发布证据与当前发布状态。
