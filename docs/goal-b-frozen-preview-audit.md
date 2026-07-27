# Goal B 冻结 Preview 路径审计

固定输入为 `3fc5690f2dbd298d38e6b49a22861b7e1607e863`，共同基线为 `a970c93ba8628734a63d96be0b5ca87d716f8038`。本账本覆盖冻结线全部 256 个路径；冲突采用当前 main 架构后再迁移行为，自动新增也不默认保留。

合并分类：冲突 173 个，自动新增 66 个，自动合并 17 个。

| 路径                                                                         | 合并状态 | 产品区                | 结论          | 验证                                   |
| ---------------------------------------------------------------------------- | -------- | --------------------- | ------------- | -------------------------------------- |
| `.github/workflows/cloud-review.yml`                                         | 自动新增 | 发布与 Cloud Review   | 明确废弃      | legacy absence 与 render contract      |
| `apps/authoring/src/__tests__/auth-flow.test.ts`                             | 冲突     | Authoring             | main 等价替代 | Authoring 路由、OIDC 与上传测试        |
| `apps/authoring/src/__tests__/connect-script-brand.test.ts`                  | 自动新增 | Authoring             | 迁移行为      | Authoring 路由、OIDC 与上传测试        |
| `apps/authoring/src/__tests__/dashboard-fakes.ts`                            | 冲突     | Authoring             | 明确废弃      | legacy absence 与 render contract      |
| `apps/authoring/src/__tests__/dashboard-routes.test.ts`                      | 冲突     | Authoring             | 明确废弃      | legacy absence 与 render contract      |
| `apps/authoring/src/__tests__/extract-cluster.test.ts`                       | 冲突     | Authoring             | 明确废弃      | legacy absence 与 render contract      |
| `apps/authoring/src/__tests__/extract-fakes.ts`                              | 冲突     | Authoring             | 明确废弃      | legacy absence 与 render contract      |
| `apps/authoring/src/__tests__/extract-finalize-progress-order.test.ts`       | 冲突     | Authoring             | 明确废弃      | legacy absence 与 render contract      |
| `apps/authoring/src/__tests__/extract-job-handler.test.ts`                   | 冲突     | Authoring             | 明确废弃      | legacy absence 与 render contract      |
| `apps/authoring/src/__tests__/extract-routes-fakes.ts`                       | 冲突     | Authoring             | 明确废弃      | legacy absence 与 render contract      |
| `apps/authoring/src/__tests__/extract-routes.test.ts`                        | 冲突     | Authoring             | 明确废弃      | legacy absence 与 render contract      |
| `apps/authoring/src/__tests__/extract-seam.test.ts`                          | 冲突     | Authoring             | 明确废弃      | legacy absence 与 render contract      |
| `apps/authoring/src/__tests__/import-connect.test.ts`                        | 冲突     | Authoring             | 明确废弃      | legacy absence 与 render contract      |
| `apps/authoring/src/__tests__/import-job-handler.test.ts`                    | 冲突     | Authoring             | 明确废弃      | legacy absence 与 render contract      |
| `apps/authoring/src/__tests__/logto-oidc.test.ts`                            | 冲突     | Authoring             | 迁移行为      | Authoring 路由、OIDC 与上传测试        |
| `apps/authoring/src/__tests__/profile-fakes.ts`                              | 冲突     | Authoring             | 明确废弃      | legacy absence 与 render contract      |
| `apps/authoring/src/__tests__/profile-heatmap.test.ts`                       | 冲突     | Authoring             | 明确废弃      | legacy absence 与 render contract      |
| `apps/authoring/src/__tests__/profile-repo.test.ts`                          | 冲突     | Authoring             | 明确废弃      | legacy absence 与 render contract      |
| `apps/authoring/src/__tests__/profile-routes.test.ts`                        | 冲突     | Authoring             | 明确废弃      | legacy absence 与 render contract      |
| `apps/authoring/src/__tests__/publish-batch-fakes.ts`                        | 冲突     | Authoring             | 明确废弃      | legacy absence 与 render contract      |
| `apps/authoring/src/__tests__/publish-batch-repo.test.ts`                    | 冲突     | Authoring             | 明确废弃      | legacy absence 与 render contract      |
| `apps/authoring/src/__tests__/publish-batch-restructure.test.ts`             | 冲突     | Authoring             | 明确废弃      | legacy absence 与 render contract      |
| `apps/authoring/src/__tests__/publish-fakes.ts`                              | 冲突     | Authoring             | 明确废弃      | legacy absence 与 render contract      |
| `apps/authoring/src/__tests__/publish-gate.test.ts`                          | 冲突     | Authoring             | 明确废弃      | legacy absence 与 render contract      |
| `apps/authoring/src/__tests__/routes.test.ts`                                | 冲突     | Authoring             | 保留 main     | Authoring 路由、OIDC 与上传测试        |
| `apps/authoring/src/__tests__/structure-create-capability.test.ts`           | 冲突     | Authoring             | 明确废弃      | legacy absence 与 render contract      |
| `apps/authoring/src/__tests__/structure-fakes.ts`                            | 冲突     | Authoring             | 明确废弃      | legacy absence 与 render contract      |
| `apps/authoring/src/__tests__/structure-routes-fakes.ts`                     | 冲突     | Authoring             | 明确废弃      | legacy absence 与 render contract      |
| `apps/authoring/src/__tests__/structure-routes.test.ts`                      | 冲突     | Authoring             | 明确废弃      | legacy absence 与 render contract      |
| `apps/authoring/src/modules/account/handlers.ts`                             | 冲突     | Authoring             | 保留 main     | Authoring 路由、OIDC 与上传测试        |
| `apps/authoring/src/modules/dashboard/dashboard-view.ts`                     | 冲突     | Authoring             | 明确废弃      | legacy absence 与 render contract      |
| `apps/authoring/src/modules/dashboard/handlers.ts`                           | 冲突     | Authoring             | 明确废弃      | legacy absence 与 render contract      |
| `apps/authoring/src/modules/dashboard/repo.ts`                               | 冲突     | Authoring             | 明确废弃      | legacy absence 与 render contract      |
| `apps/authoring/src/modules/extract/cluster.ts`                              | 冲突     | Authoring             | 明确废弃      | legacy absence 与 render contract      |
| `apps/authoring/src/modules/extract/create-extract-job.ts`                   | 冲突     | Authoring             | 明确废弃      | legacy absence 与 render contract      |
| `apps/authoring/src/modules/extract/job.ts`                                  | 冲突     | Authoring             | 明确废弃      | legacy absence 与 render contract      |
| `apps/authoring/src/modules/import/connect-script.ts`                        | 冲突     | Authoring             | 明确废弃      | legacy absence 与 render contract      |
| `apps/authoring/src/modules/import/import-connect.ts`                        | 冲突     | Authoring             | 明确废弃      | legacy absence 与 render contract      |
| `apps/authoring/src/modules/import/job.ts`                                   | 冲突     | Authoring             | 明确废弃      | legacy absence 与 render contract      |
| `apps/authoring/src/modules/import/pairings-repo.ts`                         | 冲突     | Authoring             | 明确废弃      | legacy absence 与 render contract      |
| `apps/authoring/src/modules/profile/handlers.ts`                             | 冲突     | Authoring             | 明确废弃      | legacy absence 与 render contract      |
| `apps/authoring/src/modules/profile/heatmap.ts`                              | 冲突     | Authoring             | 明确废弃      | legacy absence 与 render contract      |
| `apps/authoring/src/modules/profile/repo.ts`                                 | 冲突     | Authoring             | 明确废弃      | legacy absence 与 render contract      |
| `apps/authoring/src/modules/profile/routes.ts`                               | 冲突     | Authoring             | 明确废弃      | legacy absence 与 render contract      |
| `apps/authoring/src/modules/publish/batch-repo.ts`                           | 冲突     | Authoring             | 明确废弃      | legacy absence 与 render contract      |
| `apps/authoring/src/modules/publish/job.ts`                                  | 冲突     | Authoring             | 明确废弃      | legacy absence 与 render contract      |
| `apps/authoring/src/modules/publish/publish-one.ts`                          | 冲突     | Authoring             | 明确废弃      | legacy absence 与 render contract      |
| `apps/authoring/src/modules/publish/repo.ts`                                 | 冲突     | Authoring             | 明确废弃      | legacy absence 与 render contract      |
| `apps/authoring/src/modules/structure/candidate-draft-prep.ts`               | 冲突     | Authoring             | 明确废弃      | legacy absence 与 render contract      |
| `apps/authoring/src/modules/structure/create-capability.ts`                  | 冲突     | Authoring             | 明确废弃      | legacy absence 与 render contract      |
| `apps/authoring/src/modules/structure/generate.ts`                           | 冲突     | Authoring             | 明确废弃      | legacy absence 与 render contract      |
| `apps/authoring/src/modules/structure/repo.ts`                               | 冲突     | Authoring             | 明确废弃      | legacy absence 与 render contract      |
| `apps/authoring/src/platform/infra/logto-oidc.ts`                            | 自动合并 | Authoring             | 迁移行为      | Authoring 路由、OIDC 与上传测试        |
| `apps/authoring/src/platform/text/session-noise.ts`                          | 自动合并 | Authoring             | 保留 main     | Authoring 路由、OIDC 与上传测试        |
| `apps/runtime-web/index.html`                                                | 自动合并 | Studio 与试用         | 保留 main     | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime-web/package.json`                                              | 冲突     | Studio 与试用         | 保留 main     | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime-web/src/api/useAguiSession.test.tsx`                           | 自动新增 | Studio 与试用         | 明确废弃      | legacy absence 与 render contract      |
| `apps/runtime-web/src/api/useAguiSession.ts`                                 | 冲突     | Studio 与试用         | 明确废弃      | legacy absence 与 render contract      |
| `apps/runtime-web/src/api/useStudioSession.test.tsx`                         | 自动新增 | Studio 与试用         | 明确废弃      | legacy absence 与 render contract      |
| `apps/runtime-web/src/api/useStudioSession.ts`                               | 自动新增 | Studio 与试用         | 明确废弃      | legacy absence 与 render contract      |
| `apps/runtime-web/src/components/ArtifactPanel.tsx`                          | 冲突     | Studio 与试用         | 明确废弃      | legacy absence 与 render contract      |
| `apps/runtime-web/src/components/ArtifactRenderer.test.tsx`                  | 冲突     | Studio 与试用         | 迁移行为      | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime-web/src/components/ArtifactRenderer.tsx`                       | 冲突     | Studio 与试用         | 迁移行为      | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime-web/src/components/ChatThread.test.tsx`                        | 冲突     | Studio 与试用         | 迁移行为      | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime-web/src/components/ChatThread.tsx`                             | 冲突     | Studio 与试用         | 迁移行为      | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime-web/src/components/ComboBrand.tsx`                             | 冲突     | Studio 与试用         | 保留 main     | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime-web/src/components/DesignAgentPanel.test.tsx`                  | 自动新增 | Studio 与试用         | 明确废弃      | legacy absence 与 render contract      |
| `apps/runtime-web/src/components/DesignAgentPanel.tsx`                       | 自动新增 | Studio 与试用         | 明确废弃      | legacy absence 与 render contract      |
| `apps/runtime-web/src/components/GeneratingPageSkeleton.test.tsx`            | 冲突     | Studio 与试用         | 保留 main     | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime-web/src/components/GeneratingPageSkeleton.tsx`                 | 冲突     | Studio 与试用         | 保留 main     | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime-web/src/components/InputComposer.tsx`                          | 冲突     | Studio 与试用         | 明确废弃      | legacy absence 与 render contract      |
| `apps/runtime-web/src/components/SessionSidebar.tsx`                         | 冲突     | Studio 与试用         | 迁移行为      | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime-web/src/design-claude.css`                                     | 冲突     | Studio 与试用         | 保留 main     | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime-web/src/lib/studioAnnotation.test.ts`                          | 自动新增 | Studio 与试用         | 迁移行为      | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime-web/src/lib/studioAnnotation.ts`                               | 自动新增 | Studio 与试用         | 迁移行为      | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime-web/src/lib/studioDesignOperations.test.ts`                    | 自动新增 | Studio 与试用         | 迁移行为      | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime-web/src/lib/studioDesignOperations.ts`                         | 自动新增 | Studio 与试用         | 迁移行为      | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime-web/src/main.tsx`                                              | 冲突     | Studio 与试用         | 保留 main     | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime-web/src/pages/ChatPage.tsx`                                    | 冲突     | Studio 与试用         | 迁移行为      | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime-web/src/pages/MarketPage.tsx`                                  | 冲突     | Studio 与试用         | 保留 main     | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime-web/src/shell/AppShell.tsx`                                    | 冲突     | Studio 与试用         | 保留 main     | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime-web/src/shell/AuthGate.tsx`                                    | 冲突     | Studio 与试用         | 保留 main     | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime-web/src/shell/CloudReviewBar.tsx`                              | 自动新增 | Studio 与试用         | 明确废弃      | legacy absence 与 render contract      |
| `apps/runtime-web/src/studio.css`                                            | 自动新增 | Studio 与试用         | main 等价替代 | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime-web/src/styles.css`                                            | 冲突     | Studio 与试用         | 保留 main     | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime-web/src/test/setup.ts`                                         | 自动合并 | Studio 与试用         | 保留 main     | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime-web/src/theme/ThemeProvider.tsx`                               | 冲突     | Studio 与试用         | 保留 main     | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime-web/tsconfig.json`                                             | 冲突     | Studio 与试用         | 保留 main     | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime-web/tsconfig.vitest.json`                                      | 冲突     | Studio 与试用         | 保留 main     | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime-web/vitest.config.ts`                                          | 自动合并 | Studio 与试用         | 保留 main     | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime/scripts/seed-capability.ts`                                    | 冲突     | Runtime 数据面        | main 等价替代 | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime/src/bootstrap/app.ts`                                          | 冲突     | Runtime 数据面        | 保留 main     | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime/src/bootstrap/context.ts`                                      | 冲突     | Runtime 数据面        | main 等价替代 | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime/src/modules/agent/agui-run.test.ts`                            | 自动新增 | Runtime 数据面        | 明确废弃      | legacy absence 与 render contract      |
| `apps/runtime/src/modules/agent/agui-run.ts`                                 | 冲突     | Runtime 数据面        | 明确废弃      | legacy absence 与 render contract      |
| `apps/runtime/src/modules/agent/compose-prompt.test.ts`                      | 自动新增 | Runtime 数据面        | main 等价替代 | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime/src/modules/agent/compose-prompt.ts`                           | 冲突     | Runtime 数据面        | main 等价替代 | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime/src/modules/agent/design-studio-prompt.test.ts`                | 自动新增 | Runtime 数据面        | 迁移行为      | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime/src/modules/agent/design-studio-prompt.ts`                     | 自动新增 | Runtime 数据面        | 迁移行为      | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime/src/modules/agent/design-visual-profile.test.ts`               | 自动新增 | Runtime 数据面        | 迁移行为      | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime/src/modules/agent/design-visual-profile.ts`                    | 自动新增 | Runtime 数据面        | 迁移行为      | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime/src/modules/artifact/artifact-tool.test.ts`                    | 自动新增 | Runtime 数据面        | main 等价替代 | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime/src/modules/artifact/artifact-tool.ts`                         | 冲突     | Runtime 数据面        | main 等价替代 | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime/src/modules/artifact/repo.test.ts`                             | 自动新增 | Runtime 数据面        | 迁移行为      | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime/src/modules/artifact/repo.ts`                                  | 冲突     | Runtime 数据面        | 迁移行为      | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime/src/modules/artifact/safety.test.ts`                           | 自动新增 | Runtime 数据面        | main 等价替代 | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime/src/modules/artifact/safety.ts`                                | 自动新增 | Runtime 数据面        | main 等价替代 | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime/src/modules/capability/list.test.ts`                           | 自动新增 | Runtime 数据面        | main 等价替代 | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime/src/modules/capability/list.ts`                                | 冲突     | Runtime 数据面        | main 等价替代 | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime/src/modules/capability/loader.test.ts`                         | 冲突     | Runtime 数据面        | main 等价替代 | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime/src/modules/capability/loader.ts`                              | 冲突     | Runtime 数据面        | 保留 main     | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime/src/modules/session/detail-access.test.ts`                     | 自动新增 | Runtime 数据面        | main 等价替代 | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime/src/modules/session/detail-access.ts`                          | 自动新增 | Runtime 数据面        | main 等价替代 | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime/src/modules/session/repo.test.ts`                              | 冲突     | Runtime 数据面        | main 等价替代 | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime/src/modules/session/repo.ts`                                   | 冲突     | Runtime 数据面        | 保留 main     | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime/src/modules/session/routes.test.ts`                            | 自动新增 | Runtime 数据面        | 迁移行为      | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime/src/modules/session/routes.ts`                                 | 冲突     | Runtime 数据面        | 迁移行为      | Runtime / Runtime Web 单元与集成测试   |
| `apps/runtime/src/modules/studio/repo.test.ts`                               | 自动新增 | Runtime 数据面        | 明确废弃      | legacy absence 与 render contract      |
| `apps/runtime/src/modules/studio/repo.ts`                                    | 自动新增 | Runtime 数据面        | 明确废弃      | legacy absence 与 render contract      |
| `apps/runtime/src/modules/studio/routes.ts`                                  | 自动新增 | Runtime 数据面        | 明确废弃      | legacy absence 与 render contract      |
| `apps/web/index.html`                                                        | 冲突     | Creation / Preview UI | 保留 main     | Web UI、returnTo 与身份闸测试          |
| `apps/web/public/combo-color-card.html`                                      | 自动合并 | Creation / Preview UI | 保留 main     | Web UI、returnTo 与身份闸测试          |
| `apps/web/public/combo-design-language.html`                                 | 自动合并 | Creation / Preview UI | 保留 main     | Web UI、returnTo 与身份闸测试          |
| `apps/web/src/App.test.tsx`                                                  | 冲突     | Creation / Preview UI | main 等价替代 | Web UI、returnTo 与身份闸测试          |
| `apps/web/src/components/charts/DensityBar.tsx`                              | 冲突     | Creation / Preview UI | main 等价替代 | Web UI、returnTo 与身份闸测试          |
| `apps/web/src/components/charts/MiniSparkline.tsx`                           | 冲突     | Creation / Preview UI | main 等价替代 | Web UI、returnTo 与身份闸测试          |
| `apps/web/src/components/charts/SessionHeatmap.tsx`                          | 冲突     | Creation / Preview UI | main 等价替代 | Web UI、returnTo 与身份闸测试          |
| `apps/web/src/components/charts/TokenTrendChart.tsx`                         | 冲突     | Creation / Preview UI | main 等价替代 | Web UI、returnTo 与身份闸测试          |
| `apps/web/src/components/charts/options/densityBarOption.ts`                 | 冲突     | Creation / Preview UI | main 等价替代 | Web UI、returnTo 与身份闸测试          |
| `apps/web/src/components/charts/options/heatmapOption.ts`                    | 冲突     | Creation / Preview UI | main 等价替代 | Web UI、returnTo 与身份闸测试          |
| `apps/web/src/components/charts/options/sparklineOption.ts`                  | 冲突     | Creation / Preview UI | main 等价替代 | Web UI、returnTo 与身份闸测试          |
| `apps/web/src/components/charts/options/tokenTrendOption.ts`                 | 冲突     | Creation / Preview UI | main 等价替代 | Web UI、returnTo 与身份闸测试          |
| `apps/web/src/components/charts/theme.test.ts`                               | 自动新增 | Creation / Preview UI | main 等价替代 | Web UI、returnTo 与身份闸测试          |
| `apps/web/src/components/charts/theme.ts`                                    | 冲突     | Creation / Preview UI | main 等价替代 | Web UI、returnTo 与身份闸测试          |
| `apps/web/src/design-claude.css`                                             | 冲突     | Creation / Preview UI | 保留 main     | Web UI、returnTo 与身份闸测试          |
| `apps/web/src/main.tsx`                                                      | 冲突     | Creation / Preview UI | 保留 main     | Web UI、returnTo 与身份闸测试          |
| `apps/web/src/pages/LoginPage.test.tsx`                                      | 自动新增 | Creation / Preview UI | main 等价替代 | Web UI、returnTo 与身份闸测试          |
| `apps/web/src/pages/capabilities/CapabilitiesPage.test.tsx`                  | 冲突     | Creation / Preview UI | 保留 main     | Web UI、returnTo 与身份闸测试          |
| `apps/web/src/pages/capabilities/CapabilitiesPage.tsx`                       | 冲突     | Creation / Preview UI | 保留 main     | Web UI、returnTo 与身份闸测试          |
| `apps/web/src/pages/dashboard/CapabilityTable.test.tsx`                      | 冲突     | Creation / Preview UI | 明确废弃      | legacy absence 与 render contract      |
| `apps/web/src/pages/dashboard/CapabilityTable.tsx`                           | 冲突     | Creation / Preview UI | 明确废弃      | legacy absence 与 render contract      |
| `apps/web/src/pages/dashboard/DashboardPage.test.tsx`                        | 冲突     | Creation / Preview UI | 明确废弃      | legacy absence 与 render contract      |
| `apps/web/src/pages/dashboard/DashboardPage.tsx`                             | 冲突     | Creation / Preview UI | 明确废弃      | legacy absence 与 render contract      |
| `apps/web/src/pages/dashboard/DraftStrip.test.tsx`                           | 冲突     | Creation / Preview UI | 明确废弃      | legacy absence 与 render contract      |
| `apps/web/src/pages/dashboard/DraftStrip.tsx`                                | 冲突     | Creation / Preview UI | 明确废弃      | legacy absence 与 render contract      |
| `apps/web/src/pages/dashboard/SummaryHeader.test.tsx`                        | 冲突     | Creation / Preview UI | 明确废弃      | legacy absence 与 render contract      |
| `apps/web/src/pages/dashboard/SummaryHeader.tsx`                             | 冲突     | Creation / Preview UI | 明确废弃      | legacy absence 与 render contract      |
| `apps/web/src/pages/dashboard/hooks.test.tsx`                                | 冲突     | Creation / Preview UI | 明确废弃      | legacy absence 与 render contract      |
| `apps/web/src/pages/dashboard/hooks.ts`                                      | 冲突     | Creation / Preview UI | 明确废弃      | legacy absence 与 render contract      |
| `apps/web/src/pages/dashboard/index.ts`                                      | 冲突     | Creation / Preview UI | 明确废弃      | legacy absence 与 render contract      |
| `apps/web/src/pages/index.tsx`                                               | 冲突     | Creation / Preview UI | 保留 main     | Web UI、returnTo 与身份闸测试          |
| `apps/web/src/pages/profile/api.ts`                                          | 冲突     | Creation / Preview UI | main 等价替代 | Web UI、returnTo 与身份闸测试          |
| `apps/web/src/pages/profile/sections/HeroSection.tsx`                        | 冲突     | Creation / Preview UI | main 等价替代 | Web UI、returnTo 与身份闸测试          |
| `apps/web/src/pages/public/PublicCapabilityPage.test.tsx`                    | 冲突     | Creation / Preview UI | main 等价替代 | Web UI、returnTo 与身份闸测试          |
| `apps/web/src/pages/public/PublicCapabilityPage.tsx`                         | 冲突     | Creation / Preview UI | 保留 main     | Web UI、returnTo 与身份闸测试          |
| `apps/web/src/pages/public/PublicCreatorPage.test.tsx`                       | 自动新增 | Creation / Preview UI | main 等价替代 | Web UI、returnTo 与身份闸测试          |
| `apps/web/src/pages/public/PublicCreatorPage.tsx`                            | 冲突     | Creation / Preview UI | 保留 main     | Web UI、returnTo 与身份闸测试          |
| `apps/web/src/pages/revenue/RevenuePage.test.tsx`                            | 冲突     | Creation / Preview UI | main 等价替代 | Web UI、returnTo 与身份闸测试          |
| `apps/web/src/pages/upload/step1-import/CommandBox.test.tsx`                 | 冲突     | Creation / Preview UI | 明确废弃      | legacy absence 与 render contract      |
| `apps/web/src/pages/upload/step1-import/CommandBox.tsx`                      | 冲突     | Creation / Preview UI | 明确废弃      | legacy absence 与 render contract      |
| `apps/web/src/pages/upload/step1-import/ImportComplete.test.tsx`             | 冲突     | Creation / Preview UI | 明确废弃      | legacy absence 与 render contract      |
| `apps/web/src/pages/upload/step1-import/ImportComplete.tsx`                  | 冲突     | Creation / Preview UI | 明确废弃      | legacy absence 与 render contract      |
| `apps/web/src/pages/upload/step1-import/ImportEmptyState.test.tsx`           | 冲突     | Creation / Preview UI | 明确废弃      | legacy absence 与 render contract      |
| `apps/web/src/pages/upload/step1-import/ImportEmptyState.tsx`                | 冲突     | Creation / Preview UI | 明确废弃      | legacy absence 与 render contract      |
| `apps/web/src/pages/upload/step1-import/ImportStepPage.test.tsx`             | 冲突     | Creation / Preview UI | 明确废弃      | legacy absence 与 render contract      |
| `apps/web/src/pages/upload/step1-import/ImportStepPage.tsx`                  | 冲突     | Creation / Preview UI | 明确废弃      | legacy absence 与 render contract      |
| `apps/web/src/pages/upload/step1-import/usePairPolling.ts`                   | 冲突     | Creation / Preview UI | 明确废弃      | legacy absence 与 render contract      |
| `apps/web/src/pages/upload/step2-capabilities/CapabilitiesStepPage.test.tsx` | 冲突     | Creation / Preview UI | 明确废弃      | legacy absence 与 render contract      |
| `apps/web/src/pages/upload/step2-capabilities/CapabilitiesStepPage.tsx`      | 冲突     | Creation / Preview UI | 明确废弃      | legacy absence 与 render contract      |
| `apps/web/src/pages/upload/step2-capabilities/trialApi.test.ts`              | 自动新增 | Creation / Preview UI | 明确废弃      | legacy absence 与 render contract      |
| `apps/web/src/pages/upload/step2-capabilities/trialApi.ts`                   | 冲突     | Creation / Preview UI | 明确废弃      | legacy absence 与 render contract      |
| `apps/web/src/pages/upload/step2-extract/ExtractLoading.test.tsx`            | 冲突     | Creation / Preview UI | 明确废弃      | legacy absence 与 render contract      |
| `apps/web/src/pages/wizard/CreationJourney.tsx`                              | 自动新增 | Creation / Preview UI | 明确废弃      | legacy absence 与 render contract      |
| `apps/web/src/pages/wizard/WizardContext.test.tsx`                           | 冲突     | Creation / Preview UI | 明确废弃      | legacy absence 与 render contract      |
| `apps/web/src/pages/wizard/WizardContext.tsx`                                | 冲突     | Creation / Preview UI | 明确废弃      | legacy absence 与 render contract      |
| `apps/web/src/pages/wizard/WizardShell.test.tsx`                             | 冲突     | Creation / Preview UI | 明确废弃      | legacy absence 与 render contract      |
| `apps/web/src/pages/wizard/WizardShell.tsx`                                  | 冲突     | Creation / Preview UI | 明确废弃      | legacy absence 与 render contract      |
| `apps/web/src/pages/wizard/draftBootstrapFlow.test.tsx`                      | 冲突     | Creation / Preview UI | 明确废弃      | legacy absence 与 render contract      |
| `apps/web/src/pages/wizard/useBootstrapDraft.test.tsx`                       | 冲突     | Creation / Preview UI | 明确废弃      | legacy absence 与 render contract      |
| `apps/web/src/pages/wizard/useBootstrapDraft.ts`                             | 冲突     | Creation / Preview UI | 明确废弃      | legacy absence 与 render contract      |
| `apps/web/src/pages/wizard/useSaveDraft.test.tsx`                            | 冲突     | Creation / Preview UI | 明确废弃      | legacy absence 与 render contract      |
| `apps/web/src/pages/wizard/useSaveDraft.ts`                                  | 冲突     | Creation / Preview UI | 明确废弃      | legacy absence 与 render contract      |
| `apps/web/src/pages/wizard/wizardMachine.test.ts`                            | 冲突     | Creation / Preview UI | 明确废弃      | legacy absence 与 render contract      |
| `apps/web/src/shell/CloudReviewBar.test.tsx`                                 | 自动新增 | Creation / Preview UI | 明确废弃      | legacy absence 与 render contract      |
| `apps/web/src/shell/CloudReviewBar.tsx`                                      | 自动新增 | Creation / Preview UI | 明确废弃      | legacy absence 与 render contract      |
| `apps/web/src/shell/PublicLayout.tsx`                                        | 冲突     | Creation / Preview UI | 保留 main     | Web UI、returnTo 与身份闸测试          |
| `apps/web/src/shell/Shell.test.tsx`                                          | 冲突     | Creation / Preview UI | 保留 main     | Web UI、returnTo 与身份闸测试          |
| `apps/web/src/shell/Shell.tsx`                                               | 冲突     | Creation / Preview UI | 保留 main     | Web UI、returnTo 与身份闸测试          |
| `apps/web/src/shell/auth.test.tsx`                                           | 冲突     | Creation / Preview UI | 迁移行为      | Web UI、returnTo 与身份闸测试          |
| `apps/web/src/shell/auth.tsx`                                                | 冲突     | Creation / Preview UI | 迁移行为      | Web UI、returnTo 与身份闸测试          |
| `apps/web/src/shell/brand.tsx`                                               | 冲突     | Creation / Preview UI | 保留 main     | Web UI、returnTo 与身份闸测试          |
| `apps/web/src/shell/routes.test.ts`                                          | 冲突     | Creation / Preview UI | 保留 main     | Web UI、returnTo 与身份闸测试          |
| `apps/web/src/shell/routes.ts`                                               | 冲突     | Creation / Preview UI | 保留 main     | Web UI、returnTo 与身份闸测试          |
| `apps/web/src/styles.css`                                                    | 冲突     | Creation / Preview UI | 保留 main     | Web UI、returnTo 与身份闸测试          |
| `apps/web/src/test/setup.ts`                                                 | 冲突     | Creation / Preview UI | 保留 main     | Web UI、returnTo 与身份闸测试          |
| `apps/web/src/theme/ThemeProvider.test.tsx`                                  | 冲突     | Creation / Preview UI | 保留 main     | Web UI、returnTo 与身份闸测试          |
| `apps/web/src/theme/ThemeProvider.tsx`                                       | 冲突     | Creation / Preview UI | 保留 main     | Web UI、returnTo 与身份闸测试          |
| `apps/web/vite.config.ts`                                                    | 自动合并 | Creation / Preview UI | 保留 main     | Web UI、returnTo 与身份闸测试          |
| `db/__tests__/migrations.test.ts`                                            | 自动合并 | 数据模型与契约        | 保留 main     | migration runner 与 shared schema 测试 |
| `db/migrations/0017_backfill_creator_profiles_for_publishers.sql`            | 自动新增 | 数据模型与契约        | 明确废弃      | legacy absence 与 render contract      |
| `db/migrations/0018_studio_revisions_and_tests.sql`                          | 自动新增 | 数据模型与契约        | 明确废弃      | legacy absence 与 render contract      |
| `docs/03-验收覆盖矩阵.md`                                                    | 冲突     | 文档与仓库契约        | main 等价替代 | 完整 CI 与审计完整性测试               |
| `docs/cloud-review.md`                                                       | 自动新增 | 文档与仓库契约        | 明确废弃      | legacy absence 与 render contract      |
| `docs/contracts/60-dashboard-profile.md`                                     | 冲突     | 文档与仓库契约        | main 等价替代 | 完整 CI 与审计完整性测试               |
| `infra/Dockerfile.web`                                                       | 冲突     | 发布与 Cloud Review   | 保留 main     | release、Web asset 与部署渲染契约      |
| `infra/docker-compose.yml`                                                   | 冲突     | 发布与 Cloud Review   | 保留 main     | release、Web asset 与部署渲染契约      |
| `infra/k8s/README.md`                                                        | 冲突     | 发布与 Cloud Review   | 保留 main     | release、Web asset 与部署渲染契约      |
| `infra/k8s/api.yaml`                                                         | 冲突     | 发布与 Cloud Review   | 保留 main     | release、Web asset 与部署渲染契约      |
| `infra/k8s/job-migrate.yaml`                                                 | 自动合并 | 发布与 Cloud Review   | 保留 main     | release、Web asset 与部署渲染契约      |
| `infra/k8s/job-minio-init.yaml`                                              | 冲突     | 发布与 Cloud Review   | 保留 main     | release、Web asset 与部署渲染契约      |
| `infra/k8s/kustomization.yaml`                                               | 自动合并 | 发布与 Cloud Review   | 保留 main     | release、Web asset 与部署渲染契约      |
| `infra/k8s/minio.yaml`                                                       | 冲突     | 发布与 Cloud Review   | 保留 main     | release、Web asset 与部署渲染契约      |
| `infra/k8s/namespace.yaml`                                                   | 自动合并 | 发布与 Cloud Review   | 保留 main     | release、Web asset 与部署渲染契约      |
| `infra/k8s/overlays/cloud-review/apps/api.patch.yaml`                        | 自动新增 | 发布与 Cloud Review   | 明确废弃      | legacy absence 与 render contract      |
| `infra/k8s/overlays/cloud-review/apps/consumer.yaml`                         | 自动新增 | 发布与 Cloud Review   | 明确废弃      | legacy absence 与 render contract      |
| `infra/k8s/overlays/cloud-review/apps/kustomization.yaml`                    | 自动新增 | 发布与 Cloud Review   | 明确废弃      | legacy absence 与 render contract      |
| `infra/k8s/overlays/cloud-review/apps/review-access.html`                    | 自动新增 | 发布与 Cloud Review   | 明确废弃      | legacy absence 与 render contract      |
| `infra/k8s/overlays/cloud-review/apps/review-bootstrap.html`                 | 自动新增 | 发布与 Cloud Review   | 明确废弃      | legacy absence 与 render contract      |
| `infra/k8s/overlays/cloud-review/apps/review-nginx.conf`                     | 自动新增 | 发布与 Cloud Review   | 明确废弃      | legacy absence 与 render contract      |
| `infra/k8s/overlays/cloud-review/apps/runtime.patch.yaml`                    | 自动新增 | 发布与 Cloud Review   | 明确废弃      | legacy absence 与 render contract      |
| `infra/k8s/overlays/cloud-review/apps/sweeper.yaml`                          | 自动新增 | 发布与 Cloud Review   | 明确废弃      | legacy absence 与 render contract      |
| `infra/k8s/overlays/cloud-review/apps/web.patch.yaml`                        | 自动新增 | 发布与 Cloud Review   | 明确废弃      | legacy absence 与 render contract      |
| `infra/k8s/overlays/cloud-review/apps/worker.patch.yaml`                     | 自动新增 | 发布与 Cloud Review   | 明确废弃      | legacy absence 与 render contract      |
| `infra/k8s/overlays/cloud-review/kustomization.yaml`                         | 自动新增 | 发布与 Cloud Review   | 明确废弃      | legacy absence 与 render contract      |
| `infra/k8s/overlays/cloud-review/migrate/kustomization.yaml`                 | 自动新增 | 发布与 Cloud Review   | 明确废弃      | legacy absence 与 render contract      |
| `infra/k8s/overlays/cloud-review/migrate/migrate.patch.yaml`                 | 自动新增 | 发布与 Cloud Review   | 明确废弃      | legacy absence 与 render contract      |
| `infra/k8s/overlays/cloud-review/platform/kustomization.yaml`                | 自动新增 | 发布与 Cloud Review   | 明确废弃      | legacy absence 与 render contract      |
| `infra/k8s/overlays/cloud-review/platform/minio-init.patch.yaml`             | 自动新增 | 发布与 Cloud Review   | 明确废弃      | legacy absence 与 render contract      |
| `infra/k8s/overlays/cloud-review/platform/minio.patch.yaml`                  | 自动新增 | 发布与 Cloud Review   | 明确废弃      | legacy absence 与 render contract      |
| `infra/k8s/overlays/cloud-review/platform/namespace.yaml`                    | 自动新增 | 发布与 Cloud Review   | 明确废弃      | legacy absence 与 render contract      |
| `infra/k8s/overlays/cloud-review/platform/postgres.patch.yaml`               | 自动新增 | 发布与 Cloud Review   | 明确废弃      | legacy absence 与 render contract      |
| `infra/k8s/overlays/cloud-review/platform/redis-hot.patch.yaml`              | 自动新增 | 发布与 Cloud Review   | 明确废弃      | legacy absence 与 render contract      |
| `infra/k8s/overlays/cloud-review/platform/redis-queue.patch.yaml`            | 自动新增 | 发布与 Cloud Review   | 明确废弃      | legacy absence 与 render contract      |
| `infra/k8s/postgres.yaml`                                                    | 自动合并 | 发布与 Cloud Review   | 保留 main     | release、Web asset 与部署渲染契约      |
| `infra/k8s/redis-hot.yaml`                                                   | 自动合并 | 发布与 Cloud Review   | 保留 main     | release、Web asset 与部署渲染契约      |
| `infra/k8s/redis-queue.yaml`                                                 | 自动合并 | 发布与 Cloud Review   | 保留 main     | release、Web asset 与部署渲染契约      |
| `infra/k8s/runtime.yaml`                                                     | 冲突     | 发布与 Cloud Review   | 保留 main     | release、Web asset 与部署渲染契约      |
| `infra/k8s/web.yaml`                                                         | 自动合并 | 发布与 Cloud Review   | 保留 main     | release、Web asset 与部署渲染契约      |
| `infra/k8s/worker.yaml`                                                      | 冲突     | 发布与 Cloud Review   | 保留 main     | release、Web asset 与部署渲染契约      |
| `infra/nginx.conf`                                                           | 冲突     | 发布与 Cloud Review   | 保留 main     | release、Web asset 与部署渲染契约      |
| `infra/nginx/cloud-review-host.conf`                                         | 自动新增 | 发布与 Cloud Review   | 明确废弃      | legacy absence 与 render contract      |
| `packages/shared/src/__tests__/artifact-selection.test.ts`                   | 自动新增 | 数据模型与契约        | main 等价替代 | migration runner 与 shared schema 测试 |
| `packages/shared/src/__tests__/shared.test.ts`                               | 冲突     | 数据模型与契约        | 保留 main     | migration runner 与 shared schema 测试 |
| `packages/shared/src/domains/dashboard.ts`                                   | 冲突     | 数据模型与契约        | main 等价替代 | migration runner 与 shared schema 测试 |
| `packages/shared/src/domains/import.ts`                                      | 冲突     | 数据模型与契约        | main 等价替代 | migration runner 与 shared schema 测试 |
| `packages/shared/src/domains/runtime-api.ts`                                 | 冲突     | 数据模型与契约        | main 等价替代 | migration runner 与 shared schema 测试 |
| `packages/shared/src/domains/skill-package.ts`                               | 冲突     | 数据模型与契约        | main 等价替代 | migration runner 与 shared schema 测试 |
| `pnpm-lock.yaml`                                                             | 冲突     | 文档与仓库契约        | 保留 main     | 完整 CI 与审计完整性测试               |
| `scripts/cloud-review-smoke.sh`                                              | 自动新增 | 发布与 Cloud Review   | 明确废弃      | legacy absence 与 render contract      |
| `scripts/deploy-cloud-review.sh`                                             | 自动新增 | 发布与 Cloud Review   | 明确废弃      | legacy absence 与 render contract      |
| `scripts/recover-cloud-review-secrets.sh`                                    | 自动新增 | 发布与 Cloud Review   | 明确废弃      | legacy absence 与 render contract      |
| `scripts/release-cloud-review-nodeports.sh`                                  | 自动新增 | 发布与 Cloud Review   | 明确废弃      | legacy absence 与 render contract      |
| `tools/agora-import/main.go`                                                 | 冲突     | 文档与仓库契约        | 明确废弃      | legacy absence 与 render contract      |
| `tools/agora-import/make-fixture-home.sh`                                    | 冲突     | 文档与仓库契约        | 明确废弃      | legacy absence 与 render contract      |
| `tools/agora-import/ui.go`                                                   | 冲突     | 文档与仓库契约        | 明确废弃      | legacy absence 与 render contract      |
| `tools/agora-import/ui_test.go`                                              | 自动合并 | 文档与仓库契约        | 明确废弃      | legacy absence 与 render contract      |

## 六区结论

- Creation Journey 以当前 `/tasks`、Task 上传状态、Capability 发布和 Trial 入口为实现真源。冻结线的 Wizard、draft、snapshot、batch 和旧 import 页面均明确废弃；只迁移终态进度、刷新恢复、失败重试与返回原 Task 的行为。
- Studio 与可视化编辑以当前 Session、Turn、Message、Artifact、Redis SSE、Sandbox 和 `combo:run` 为实现真源。冻结线的 DesignAgentPanel、旧 session hook 和 AG-UI emitter 整体实现均明确废弃；元素选择、多轮草稿语义和视觉连续性按当前架构迁移。
- Authoring 以当前 `/connect/prepare`、`/connect/upload`、Task pipeline、认证和 owner 隔离为实现真源。冻结线的 dashboard、extract job、import、profile、publish batch 和 structure 模块均明确废弃；只迁移慢 OIDC 等待和安全回跳体验。
- Runtime 与数据模型严格保留当前九张业务表加迁移账本、Redis 事件回放和 Turn fencing。Artifact 来源 Turn、active Turn、revision 历史和 current UI 作为当前模型扩展；冻结线的 `0017`、`0018`、`rt_chat_*`、`rt_studio_*` 与旧 bridge 均明确废弃。
- Preview UI 与访问闸以运行时发布身份、完整 SHA、releaseId、Web asset digest 和 SHA-scoped gate 为真源。冻结线的构建期 `VITE_*` 身份、匿名 `rt_uid` 和旧 CloudReviewBar 实现均明确废弃；本区只修改源码与契约，不构成 Preview 部署。
- Cloud Review 与发布架构完整保留 main 的一次构建、四业务面、digest pin、release manifest 和同 artifact 晋级。冻结线的 cloud-review workflow、overlay、六业务面、NodePort、Secret recovery 与重复构建脚本均明确废弃。
