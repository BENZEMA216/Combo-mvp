// typed client 测试：轻包络解包 / ErrorEnvelope 白名单重建 / 非契约响应兜底人话。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { installFetchMock, type FetchMock } from '../test/mockFetch.js';
import {
  ApiError,
  apiGet,
  apiGetEnvelope,
  apiPost,
  resetUnauthorizedRedirectForTest,
  sanitizeErrorBody,
  unauthorizedNavigation,
} from './client.js';

let fm: FetchMock | undefined;
afterEach(() => {
  fm?.restore();
  fm = undefined;
  resetUnauthorizedRedirectForTest();
  vi.restoreAllMocks();
});

describe('apiGet — 轻包络 { data, meta } 解包', () => {
  it('成功：解包 data；URL 拼 API_PREFIX + query；credentials include', async () => {
    fm = installFetchMock({ status: 200, json: { data: { ok: true }, meta: {} } });
    const data = await apiGet<{ ok: boolean }>('/tasks', { query: { cursor: 'c1', limit: 20 } });
    expect(data).toEqual({ ok: true });
    expect(fm.calls[0]?.url).toBe('/api/v1/tasks?cursor=c1&limit=20');
    expect(fm.calls[0]?.method).toBe('GET');
    expect(fm.calls[0]?.credentials).toBe('include');
  });

  it('undefined query 值不进 URL', async () => {
    fm = installFetchMock({ status: 200, json: { data: [] } });
    await apiGet('/capabilities', { query: { taskId: undefined } });
    expect(fm.calls[0]?.url).toBe('/api/v1/capabilities');
  });

  it('apiGetEnvelope：需要分页 meta 时拿完整包络', async () => {
    const page = { nextCursor: 'n1', hasMore: true, limit: 20, order: 'desc' };
    fm = installFetchMock({ status: 200, json: { data: [1, 2], meta: { page } } });
    const env = await apiGetEnvelope<number[]>('/tasks');
    expect(env.data).toEqual([1, 2]);
    expect(env.meta?.page).toEqual(page);
  });
});

describe('apiPost — JSON body', () => {
  it('序列化 body + Content-Type', async () => {
    fm = installFetchMock({ status: 201, json: { data: { id: 't1' } } });
    await apiPost('/tasks', { idempotencyKey: 'k-12345678' });
    expect(fm.calls[0]?.method).toBe('POST');
    expect(fm.calls[0]?.body).toEqual({ idempotencyKey: 'k-12345678' });
    expect(fm.calls[0]?.headers['Content-Type']).toBe('application/json');
  });

  it('无 body 的 POST（publish/retry）不带 Content-Type', async () => {
    fm = installFetchMock({ status: 200, json: { data: { id: 'c1' } } });
    await apiPost('/capabilities/c1/publish');
    expect(fm.calls[0]?.headers['Content-Type']).toBeUndefined();
  });
});

describe('401 fixed session semantics', () => {
  it('surfaces 401 metadata and navigates once without refresh or GET replay', async () => {
    window.history.replaceState({}, '', '/tasks?cursor=expired');
    const navigate = vi.spyOn(unauthorizedNavigation, 'assign').mockImplementation(() => undefined);
    fm = installFetchMock({
      status: 401,
      json: {
        error: {
          userMessage: '请先登录。',
          retriable: false,
          action: 'escalate',
          traceId: 'trace-401',
        },
      },
    });

    const error = (await apiGet('/tasks').catch((cause: unknown) => cause)) as ApiError;
    expect(error.userMessage).toBe('请先登录。');
    expect(error.retriable).toBe(false);
    expect(error.httpStatus).toBe(401);
    expect(error.envelope.error).not.toHaveProperty('status');
    expect(Object.keys(error)).not.toContain('httpStatus');
    expect(fm.calls.map((call) => call.url)).toEqual(['/api/v1/tasks']);
    expect(navigate).toHaveBeenCalledWith('/login?returnTo=%2Ftasks%3Fcursor%3Dexpired');

    await expect(apiGet('/capabilities')).rejects.toBeInstanceOf(ApiError);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('never replays a state-changing POST after a 401', async () => {
    const navigate = vi.spyOn(unauthorizedNavigation, 'assign').mockImplementation(() => undefined);
    fm = installFetchMock({
      status: 401,
      json: {
        error: {
          userMessage: '请先登录。',
          retriable: false,
          action: 'escalate',
          traceId: 'trace-post-401',
        },
      },
    });
    const body = { idempotencyKey: 'key-12345678' };

    await expect(apiPost('/tasks', body)).rejects.toBeInstanceOf(ApiError);
    expect(fm.calls).toHaveLength(1);
    expect(fm.calls[0]?.body).toEqual(body);
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});

describe('非 2xx — ErrorEnvelope 白名单重建，绝不裸露错误码', () => {
  it('契约信封 → ApiError（userMessage/action/retriable/traceId）', async () => {
    fm = installFetchMock({
      status: 409,
      json: {
        error: {
          userMessage: '当前状态不允许这个操作，刷新看看最新状态。',
          retriable: false,
          action: 'change_input',
          traceId: 'trace-409',
        },
      },
    });
    const err = await apiGet('/tasks/t1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.userMessage).toBe('当前状态不允许这个操作，刷新看看最新状态。');
    expect(apiErr.action).toBe('change_input');
    expect(apiErr.retriable).toBe(false);
    expect(apiErr.traceId).toBe('trace-409');
  });

  it('信封夹带 code/status/stack → 白名单重建后全部剔除', async () => {
    fm = installFetchMock({
      status: 500,
      json: {
        error: {
          userMessage: '服务开小差了，请重试。',
          retriable: true,
          action: 'retry',
          traceId: 't-500',
          code: 'INTERNAL',
          status: 500,
          stack: 'Error: boom',
        },
      },
    });
    const err = (await apiGet('/tasks').catch((e: unknown) => e)) as ApiError;
    expect(err.envelope.error).toEqual({
      userMessage: '服务开小差了，请重试。',
      retriable: true,
      action: 'retry',
      traceId: 't-500',
    });
  });

  it('非契约 JSON（无 userMessage）→ 兜底人话', async () => {
    fm = installFetchMock({ status: 502, json: { message: 'Bad Gateway' } });
    const err = (await apiGet('/tasks').catch((e: unknown) => e)) as ApiError;
    expect(err.userMessage).toBe('服务开小差了，请稍后重试。');
    expect(err.action).toBe('retry');
  });

  it('非 JSON 错误页 → 兜底人话', async () => {
    fm = installFetchMock({ status: 503, notJson: true });
    const err = (await apiGet('/tasks').catch((e: unknown) => e)) as ApiError;
    expect(err.userMessage).toBe('服务暂时没有正确响应，请稍后重试。');
  });

  it('网络断 → 兜底人话（retriable）', async () => {
    fm = installFetchMock({ networkError: true });
    const err = (await apiGet('/tasks').catch((e: unknown) => e)) as ApiError;
    expect(err.userMessage).toBe('网络好像不太稳，检查连接后重试。');
    expect(err.retriable).toBe(true);
  });
});

describe('sanitizeErrorBody — 任意输入收敛为可展示 ErrorBody', () => {
  it('合法 ErrorBody 原样保留安全字段（含 failureId/details）', () => {
    const body = sanitizeErrorBody({
      userMessage: '配对码不对，检查后重新输入。',
      retriable: false,
      action: 'change_input',
      traceId: 't1',
      failureId: 'f1',
      details: { hint: 'x' },
    });
    expect(body).toEqual({
      userMessage: '配对码不对，检查后重新输入。',
      retriable: false,
      action: 'change_input',
      traceId: 't1',
      failureId: 'f1',
      details: { hint: 'x' },
    });
  });

  it('非法 action 归一为 retry；垃圾输入 → 兜底人话', () => {
    expect(sanitizeErrorBody({ userMessage: 'x', action: 'DROP TABLE' }).action).toBe('retry');
    expect(sanitizeErrorBody('boom').userMessage).toBe('服务开小差了，请稍后重试。');
    expect(sanitizeErrorBody(null).userMessage).toBe('服务开小差了，请稍后重试。');
  });
});
