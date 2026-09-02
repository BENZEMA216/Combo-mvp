import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// repo.ts 的 SQL 文本守护：挑出现场真实炸过的形态——同一个绑定参数在多个
// 类型上下文里重复使用会被 PG 拒绝（inconsistent types deduced）。
const directory = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(directory, '..', 'repo.ts'), 'utf8');

describe('repo SQL parameter discipline', () => {
  it('increments challenge attempts atomically without reusing a bound parameter', () => {
    expect(source).toContain('SET attempt_count = attempt_count + 1');
    expect(source).toContain('WHEN attempt_count + 1 >= max_attempts THEN now()');
    // 失败分支 UPDATE 只绑定挑战主键一个参数。
    const failureUpdate = source.match(
      /UPDATE v2_auth_challenges[\s\S]*?WHERE id = \$1`,\s*\n\s*\[challenge\.id\]/,
    );
    expect(failureUpdate).not.toBeNull();
  });
});
