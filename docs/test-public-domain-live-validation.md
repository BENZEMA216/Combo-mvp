# Test 公网域名现场验证

本 PR 只用于冻结一个可审计的同仓库候选 SHA，以验证手工 Test 部署与持久公网入口。它不修改应用、计费或支付逻辑，也不用于 Preview 或 Production 晋级。

验证成功后，Web 应持续通过 `https://test.43-160-242-46.sslip.io` 访问，对象存储应持续通过 `https://test-s3.43-160-242-46.sslip.io` 访问。
