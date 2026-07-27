// vitest 配置（jsdom + @testing-library/react）。
//
// 组件测试约定（前端合规清单）：
//   - environment=jsdom：组件可挂载、可断言 DOM。
//   - setupFiles：注入 @testing-library/jest-dom 匹配器 + 全局 EventSource mock（jsdom 不带）。
//   - JSX 使用 TypeScript 配置中的 react-jsx 转换，不加载开发期 Fast Refresh 插件。
//   - 无运行后端：API 用 fetch mock、SSE 用 MockEventSource，全部离线可跑。
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/main.tsx'],
    },
  },
});
