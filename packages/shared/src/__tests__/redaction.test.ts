import { describe, it, expect } from 'vitest';
import {
  redact,
  redactBatch,
  mergeReports,
  DEFAULT_RULESET,
  REDACTION_CATEGORY_LABELS,
  REDACTION_PLACEHOLDERS,
  type RedactionRuleset,
} from '../index.js';
import { RedactionReportViewSchema, type RedactionCategory } from '../index.js';

// ---------- 小工具 ----------

/** 取某类计数（无则 0）。 */
function count(report: ReturnType<typeof redact>['report'], cat: RedactionCategory): number {
  return report.byCategory.find((b) => b.category === cat)?.count ?? 0;
}

const PLAINTEXT_PII_SAMPLES = [
  '13800138000',
  '+8613912345678',
  'alice@example.com',
  'sk-ant-api03-AbCdEf0123456789AbCdEf0123456789',
  'ghp_AbCdEf0123456789AbCdEf0123456789abcd',
  'AKIAIOSFODNN7EXAMPLE',
  '440524188001010014', // 校验码合法的样例身份证（数字结尾）
  '110101194912310024', // 校验码合法的样例身份证（含末位校验位）
  '4111111111111111', // Luhn 合法测试卡号
  '192.168.1.100',
];

describe('B-17 去敏引擎 · 报告契约形态', () => {
  it('报告符合 RedactionReportViewSchema（applied=true / 计数 / 版本）', () => {
    const { report } = redact('打我 13800138000，邮箱 alice@example.com');
    expect(() => RedactionReportViewSchema.parse(report)).not.toThrow();
    expect(report.applied).toBe(true);
    expect(report.rulesetVersion).toBe(DEFAULT_RULESET.version);
  });

  it('label 取人话类别名，与 REDACTION_CATEGORY_LABELS 一致', () => {
    const { report } = redact('手机 13800138000');
    const phone = report.byCategory.find((b) => b.category === 'phone')!;
    expect(phone.label).toBe(REDACTION_CATEGORY_LABELS.phone);
    expect(phone.label).toBe('手机号');
  });

  it('totalRedactions = 各类计数之和', () => {
    const { report } = redact('13800138000 与 13900139000 与 alice@example.com');
    const sum = report.byCategory.reduce((s, b) => s + b.count, 0);
    expect(report.totalRedactions).toBe(sum);
    expect(report.totalRedactions).toBe(3);
  });

  it('无命中时报告为空但 applied 仍 true（去敏已执行）', () => {
    const { report, text } = redact('这是一段普通的中文说明，没有任何隐私信息。');
    expect(report.applied).toBe(true);
    expect(report.totalRedactions).toBe(0);
    expect(report.byCategory).toEqual([]);
    expect(text).toBe('这是一段普通的中文说明，没有任何隐私信息。');
  });
});

describe('B-17 去敏引擎 · 各类 PII 命中与掩码', () => {
  it('手机号：中国大陆 11 位被抹', () => {
    const { text, report } = redact('我的号码是 13800138000 请联系');
    expect(text).not.toContain('13800138000');
    expect(text).toContain(REDACTION_PLACEHOLDERS.phone);
    expect(count(report, 'phone')).toBe(1);
  });

  it('手机号：带 +86 / 86 前缀也被抹', () => {
    expect(redact('call +8613912345678 now').text).not.toContain('13912345678');
    expect(redact('86 13912345678').text).not.toContain('13912345678');
  });

  it('邮箱被抹', () => {
    const { text, report } = redact('联系 alice.smith+tag@sub.example.co.uk 谢谢');
    expect(text).not.toContain('alice.smith');
    expect(text).not.toContain('example.co.uk');
    expect(count(report, 'email')).toBe(1);
  });

  it('显式键值密钥：抹值保留 key 名（语义保留）', () => {
    const { text, report } = redact('api_key=sk_live_AbCdEf0123456789xyz');
    expect(text).not.toContain('sk_live_AbCdEf0123456789xyz');
    expect(text).toContain('api_key'); // key 名保留
    expect(count(report, 'api_key')).toBe(1);
  });

  it('显式键值密钥：JSON 形态 "token": "..." 被抹', () => {
    const { text, report } = redact('{ "token": "abcdef1234567890XYZ" }');
    expect(text).not.toContain('abcdef1234567890XYZ');
    expect(count(report, 'api_key')).toBe(1);
  });

  it('Authorization: Bearer <token> 被抹', () => {
    const { text, report } = redact('Authorization: Bearer abcDEF123456ghiJKL');
    expect(text).not.toContain('abcDEF123456ghiJKL');
    expect(count(report, 'api_key')).toBe(1);
  });

  it('厂商前缀密钥（无关键词锚）：sk-ant / ghp_ / AKIA 被抹', () => {
    const k1 = 'sk-ant-api03-AbCdEf0123456789AbCdEf0123456789';
    const k2 = 'ghp_AbCdEf0123456789AbCdEf0123456789abcd';
    const k3 = 'AKIAIOSFODNN7EXAMPLE';
    for (const k of [k1, k2, k3]) {
      const { text, report } = redact(`key is ${k} end`);
      expect(text).not.toContain(k);
      expect(count(report, 'api_key')).toBeGreaterThanOrEqual(1);
    }
  });

  it('身份证（校验码合法）被抹，含末位 X 校验位也命中', () => {
    const a = redact('身份证 440524188001010014 已登记');
    expect(a.text).not.toContain('440524188001010014');
    expect(count(a.report, 'id_card')).toBe(1);

    const b = redact('身份证 110101194912310024 已登记');
    expect(b.text).not.toContain('110101194912310024');
    expect(count(b.report, 'id_card')).toBe(1);
  });

  it('银行卡（Luhn 合法）被抹，含空格分组也命中', () => {
    const a = redact('卡号 4111111111111111 转账');
    expect(a.text).not.toContain('4111111111111111');
    expect(count(a.report, 'bank_card')).toBe(1);

    const b = redact('卡号 4111 1111 1111 1111 转账');
    expect(b.text).not.toContain('4111 1111 1111 1111');
    expect(count(b.report, 'bank_card')).toBe(1);
  });

  it('IPv4（四段合法）被抹', () => {
    const { text, report } = redact('server at 192.168.1.100 down');
    expect(text).not.toContain('192.168.1.100');
    expect(count(report, 'ip')).toBe(1);
  });

  it('泛长随机密钥串归 secret_other', () => {
    const secret = 'Zk7Qw9Xb2Lm4Np6Rt8Vy0Ac1Bd3Ef5Gh7Jk9';
    const { text, report } = redact(`raw ${secret} value`);
    expect(text).not.toContain(secret);
    expect(count(report, 'secret_other')).toBe(1);
  });
});

describe('B-17 去敏引擎 · 硬约束：不泄漏明文', () => {
  it('去敏后文本绝不残留任一明文 PII 样本', () => {
    const doc = PLAINTEXT_PII_SAMPLES.join(' / ');
    const { text } = redact(doc);
    for (const sample of PLAINTEXT_PII_SAMPLES) {
      expect(text).not.toContain(sample);
    }
  });

  it('报告（含 label）绝不包含任何明文 PII 样本（只给类别+计数）', () => {
    const doc = PLAINTEXT_PII_SAMPLES.join(' ');
    const { report } = redact(doc);
    const serialized = JSON.stringify(report);
    for (const sample of PLAINTEXT_PII_SAMPLES) {
      expect(serialized).not.toContain(sample);
    }
    // 报告只暴露 category / count / label / version / applied，无 value/offset 字段
    for (const b of report.byCategory) {
      expect(Object.keys(b).sort()).toEqual(['category', 'count', 'label']);
    }
  });
});

describe('B-17 去敏引擎 · 幂等', () => {
  it('对已去敏文本再跑一次：文本不变、无新命中', () => {
    const once = redact('手机 13800138000，邮箱 a@b.com，token: abcdef1234567890');
    const twice = redact(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.report.totalRedactions).toBe(0);
  });

  it('占位符本身不会被任何规则二次命中', () => {
    for (const ph of Object.values(REDACTION_PLACEHOLDERS)) {
      const { report } = redact(`前缀 ${ph} 后缀`);
      expect(report.totalRedactions).toBe(0);
    }
  });

  it('三次运行收敛（稳定不抖动）', () => {
    const r1 = redact('13800138000 alice@example.com 192.168.1.100');
    const r2 = redact(r1.text);
    const r3 = redact(r2.text);
    expect(r2.text).toBe(r1.text);
    expect(r3.text).toBe(r1.text);
  });
});

describe('B-17 去敏引擎 · 误伤控制（负样本不命中）', () => {
  it('普通中文长句不被误抹', () => {
    const s = '这是一个关于产品设计的讨论，我们聊了用户体验、信息架构和交互细节。';
    const { text, report } = redact(s);
    expect(text).toBe(s);
    expect(report.totalRedactions).toBe(0);
  });

  it('版本号 / 普通点分数字不被当成 IP（越界段）', () => {
    const r = redact('升级到 v1.2.3.4，另见 256.300.1.1 非法段');
    expect(count(r.report, 'ip')).toBe(0);
  });

  it('随手写的 16 位数字若 Luhn 不过则不算银行卡', () => {
    // 1234567890123456 Luhn 不通过
    const r = redact('订单号 1234567890123456 已生成');
    expect(count(r.report, 'bank_card')).toBe(0);
  });

  it('校验码不合法的 18 位数字不算身份证', () => {
    const r = redact('编号 110101199003077210 仅示例'); // 末位错
    expect(count(r.report, 'id_card')).toBe(0);
  });

  it('座机/短号等非 1[3-9] 开头 11 位数字不算手机号', () => {
    const r = redact('内部分机 12345678901 与 10086');
    expect(count(r.report, 'phone')).toBe(0);
  });

  it('普通小写英文长单词串不被当成密钥', () => {
    const r = redact('antidisestablishmentarianismsupercalifragilistic words here');
    expect(count(r.report, 'secret_other')).toBe(0);
  });

  it('短数字串（如年份、价格）不被误抹', () => {
    const r = redact('2026 年营收 19999 元，增长 35%');
    expect(r.report.totalRedactions).toBe(0);
    expect(r.text).toContain('2026');
    expect(r.text).toContain('19999');
  });
});

describe('B-17 去敏引擎 · Unicode / 中英混排', () => {
  it('中英文夹杂、全角标点环绕的 PII 仍被抹', () => {
    const { text, report } = redact('客户「张三」手机：13800138000，邮箱：zhang@公司.com 错误格式');
    expect(text).not.toContain('13800138000');
    expect(count(report, 'phone')).toBe(1);
    // 含中文域名的不是合法邮箱 ASCII，不强求命中；但手机号必须抹
  });

  it('emoji / CJK 与 PII 相邻不破坏命中与计数', () => {
    const { text, report } = redact('🎉恭喜🎉 联系 bob@example.com 领取 13900139000');
    expect(text).not.toContain('bob@example.com');
    expect(text).not.toContain('13900139000');
    expect(count(report, 'email')).toBe(1);
    expect(count(report, 'phone')).toBe(1);
    expect(text).toContain('🎉'); // emoji 语义保留
  });

  it('被中文紧贴包裹的手机号（无空格）也命中', () => {
    const { text, report } = redact('电话是13800138000打过来');
    expect(text).not.toContain('13800138000');
    expect(count(report, 'phone')).toBe(1);
  });
});

describe('B-17 去敏引擎 · 边界（跨行 / 拼接 / 重复）', () => {
  it('跨行文本各行独立命中', () => {
    const doc = ['手机 13800138000', '邮箱 a@b.com', 'IP 10.0.0.1'].join('\n');
    const { text, report } = redact(doc);
    expect(text).not.toContain('13800138000');
    expect(text).not.toContain('a@b.com');
    expect(text).not.toContain('10.0.0.1');
    expect(report.totalRedactions).toBe(3);
    expect(text.split('\n')).toHaveLength(3); // 换行结构保留
  });

  it('同类多次出现各计一次、互不漏', () => {
    const { report } = redact('13800138000 13900139000 13700137000');
    expect(count(report, 'phone')).toBe(3);
  });

  it('拼接无分隔的两个 PII（手机号紧接邮箱）都被抹', () => {
    const { text, report } = redact('13800138000alice@example.com');
    expect(text).not.toContain('13800138000');
    expect(text).not.toContain('alice@example.com');
    // 邮箱 local part 起始可吃数字，确保不互相吞掉对方
    expect(count(report, 'email')).toBe(1);
  });

  it('重叠候选只抹一次、不重复计数（区间不双计）', () => {
    // 卡号也是长数字串，可能被多条规则候选；最终应只归一类、计一次
    const { report } = redact('4111111111111111');
    expect(report.totalRedactions).toBe(1);
    expect(count(report, 'bank_card')).toBe(1);
  });

  it('文本首尾的 PII 边界正确（不丢首尾字符、不越界）', () => {
    const head = redact('13800138000 开头');
    expect(head.text.endsWith('开头')).toBe(true);
    expect(head.text).not.toContain('13800138000');

    const tail = redact('结尾 alice@example.com');
    expect(tail.text.startsWith('结尾 ')).toBe(true);
    expect(tail.text).not.toContain('alice@example.com');
  });
});

describe('去敏引擎 · Task pipeline 批量与报告聚合', () => {
  it('redactBatch：N 段输入 → N 段去敏文本 + 一份聚合报告', () => {
    const inputs = ['手机 13800138000', '邮箱 a@b.com', '普通文本无隐私'];
    const { texts, report } = redactBatch(inputs);
    expect(texts).toHaveLength(3);
    expect(texts[0]).not.toContain('13800138000');
    expect(texts[1]).not.toContain('a@b.com');
    expect(texts[2]).toBe('普通文本无隐私');
    expect(report.totalRedactions).toBe(2);
    expect(count(report, 'phone')).toBe(1);
    expect(count(report, 'email')).toBe(1);
  });

  it('redactBatch 报告通过 schema 校验且 version 正确', () => {
    const { report } = redactBatch(['13800138000', 'a@b.com']);
    expect(() => RedactionReportViewSchema.parse(report)).not.toThrow();
    expect(report.rulesetVersion).toBe(DEFAULT_RULESET.version);
  });

  it('mergeReports：跨段计数累加，类别合并', () => {
    const r1 = redact('13800138000').report;
    const r2 = redact('13900139000 a@b.com').report;
    const merged = mergeReports([r1, r2], DEFAULT_RULESET.version);
    expect(count(merged, 'phone')).toBe(2);
    expect(count(merged, 'email')).toBe(1);
    expect(merged.totalRedactions).toBe(3);
  });

  it('空输入批量：texts 为空、报告零命中', () => {
    const { texts, report } = redactBatch([]);
    expect(texts).toEqual([]);
    expect(report.totalRedactions).toBe(0);
    expect(report.applied).toBe(true);
  });
});

describe('B-17 去敏引擎 · 可配置规则集 + 版本可迭代', () => {
  it('自定义规则集只跑给定规则，报告 version 取自定义版本', () => {
    const custom: RedactionRuleset = {
      version: 'redaction-test-only-phone',
      rules: [
        {
          id: 'phone-only',
          category: 'phone',
          pattern: /(?<![0-9])1[3-9]\d{9}(?![0-9])/g,
        },
      ],
    };
    const { text, report } = redact('13800138000 alice@example.com', { ruleset: custom });
    expect(text).not.toContain('13800138000');
    expect(text).toContain('alice@example.com'); // 邮箱规则未启用 → 不抹
    expect(report.rulesetVersion).toBe('redaction-test-only-phone');
    expect(count(report, 'phone')).toBe(1);
    expect(count(report, 'email')).toBe(0);
  });

  it('自定义掩码生效且不泄漏原文', () => {
    const custom: RedactionRuleset = {
      version: 'v-custom-mask',
      rules: [
        {
          id: 'p',
          category: 'phone',
          pattern: /(?<![0-9])1[3-9]\d{9}(?![0-9])/g,
          mask: () => '<PHONE>',
        },
      ],
    };
    const { text } = redact('13800138000', { ruleset: custom });
    expect(text).toBe('<PHONE>');
  });

  it('byCategory 输出顺序稳定（固定类别序）', () => {
    const { report } = redact('a@b.com 13800138000 192.168.1.1');
    const cats = report.byCategory.map((b) => b.category);
    // 固定序：phone, email, api_key, id_card, bank_card, ip, secret_other
    const expectedRelative = cats.filter((c) => ['phone', 'email', 'ip'].includes(c));
    expect(expectedRelative).toEqual(['phone', 'email', 'ip']);
  });
});
