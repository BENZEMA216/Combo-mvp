import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api/client.js';

/** 固定会话的 401 与 403 是终态，不允许 React Query 自动重放。 */
export function shouldRetryRuntimeQuery(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return false;
  return failureCount < 1;
}

export function createRuntimeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: shouldRetryRuntimeQuery, refetchOnWindowFocus: false },
    },
  });
}
