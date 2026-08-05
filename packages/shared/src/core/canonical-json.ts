/**
 * 把 JSON 值编码为稳定字符串。对象键按字典序排列，数组保持原顺序，供跨进程摘要计算。
 * 输入必须已经通过 Zod 边界，不接受 undefined、函数、循环引用或非 JSON 数值。
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonicalJson only accepts finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => {
        if (record[key] === undefined) {
          throw new TypeError('canonicalJson does not accept undefined values');
        }
        return `${JSON.stringify(key)}:${canonicalJson(record[key])}`;
      });
    return `{${entries.join(',')}}`;
  }
  throw new TypeError(`canonicalJson does not accept ${typeof value}`);
}
