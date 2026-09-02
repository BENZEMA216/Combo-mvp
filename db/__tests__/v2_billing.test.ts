import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const directory = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(resolve(directory, '..', 'v2-migrations', '0013_v2_billing.sql'), 'utf8');

describe('0013 V2 计费体系', () => {
  it('creates the wallet four tables plus hold and metering tables', () => {
    for (const table of [
      'v2_wallets',
      'v2_ledger',
      'v2_packages',
      'v2_orders',
      'v2_holds',
      'v2_metering_events',
    ]) {
      expect(sql).toContain(`CREATE TABLE ${table} (`);
    }
    // 计费表挂在 0012 的终端用户主表上，不引用 V1 创作者域。
    expect(sql).toContain('REFERENCES v2_users(id)');
    expect(sql).not.toMatch(/REFERENCES\s+(?!v2_)[a-z]/i);
  });

  it('wallet has the three buckets and ledger is append-only with a unique idempotency key', () => {
    const wallets = sql.match(/CREATE TABLE v2_wallets \(([\s\S]*?)\n\);/)?.[1] ?? '';
    for (const column of ['principal_balance', 'bonus_balance', 'held_amount']) {
      expect(wallets).toContain(column);
    }
    // 本金与赠送桶允许为负（fail-open 透支），冻结额不为负。
    expect(wallets).toContain('CHECK (held_amount >= 0)');
    expect(wallets).not.toMatch(/principal_balance\s+bigint\s+NOT NULL DEFAULT 0 CHECK/);

    const ledger = sql.match(/CREATE TABLE v2_ledger \(([\s\S]*?)\n\);/)?.[1] ?? '';
    expect(ledger).toContain('UNIQUE (idempotency_key)');
    expect(ledger).toContain(
      "kind IN ('recharge', 'consume', 'refund', 'bonus', 'hold', 'release')",
    );
    expect(ledger).toContain("bucket IN ('principal', 'bonus')");
    expect(ledger).toContain("kind <> 'refund' OR bucket = 'principal'");

    expect(sql).toContain('BEFORE UPDATE OR DELETE ON v2_ledger');
    expect(sql).toContain('BEFORE TRUNCATE ON v2_ledger');
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON v2_metering_events');
    expect(sql).toContain('BEFORE TRUNCATE ON v2_metering_events');
    expect(sql).toContain("USING ERRCODE = '55000'");
  });

  it('hold carries the spec state machine, turn idempotency, and five-minute TTL', () => {
    const holds = sql.match(/CREATE TABLE v2_holds \(([\s\S]*?)\n\);/)?.[1] ?? '';
    for (const column of ['user_id', 'agent_id', 'turn_id', 'estimated_amount', 'expires_at']) {
      expect(holds).toContain(column);
    }
    expect(holds).toContain('UNIQUE (agent_id, turn_id)');
    expect(holds).toContain("status IN ('held', 'settled', 'released', 'expired')");
    expect(holds).toContain("expires_at = created_at + interval '5 minutes'");
    // settled 与 actual_amount/settled_at 同生同灭。
    expect(holds).toContain(
      "(status = 'settled') = (actual_amount IS NOT NULL AND settled_at IS NOT NULL)",
    );

    const transition = sql.match(
      /CREATE FUNCTION enforce_v2_hold_transition\(\)([\s\S]*?)\$\$ LANGUAGE/,
    )?.[1];
    expect(transition).toContain("OLD.status = 'held'");
    expect(transition).toContain("NEW.status IN ('settled', 'released', 'expired')");
    expect(sql).toContain('BEFORE UPDATE OF status ON v2_holds');
  });

  it('metering events carry the spec dimensions and sources, estimated rows have no dimension', () => {
    const metering = sql.match(/CREATE TABLE v2_metering_events \(([\s\S]*?)\n\);/)?.[1] ?? '';
    for (const dimension of [
      'llm_token_in',
      'llm_token_out',
      'tts_char',
      'image_gen',
      'retrieval_call',
      'audio_second',
    ]) {
      expect(metering).toContain(`'${dimension}'`);
    }
    expect(metering).toContain("source IN ('gateway', 'agent_report', 'estimated')");
    expect(metering).toContain("(source = 'estimated') = (dimension IS NULL)");
    expect(metering).toContain('REFERENCES v2_holds(id)');
  });

  it('order and package follow the spec shapes without payment-channel shortcuts', () => {
    const orders = sql.match(/CREATE TABLE v2_orders \(([\s\S]*?)\n\);/)?.[1] ?? '';
    expect(orders).toContain("channel IN ('wechat_native', 'wechat_jsapi')");
    expect(orders).toContain("status IN ('created', 'paid', 'refunding', 'refunded', 'closed')");
    expect(orders).toContain('UNIQUE (idempotency_key)');

    const packages = sql.match(/CREATE TABLE v2_packages \(([\s\S]*?)\n\);/)?.[1] ?? '';
    for (const column of ['name', 'price', 'credit_amount', 'bonus_amount', 'status']) {
      expect(packages).toContain(column);
    }
  });

  it('creates a hardened billing role with append-only ledger and metering grants', () => {
    expect(sql).toContain('CREATE ROLE combo_billing NOLOGIN NOSUPERUSER');
    expect(sql).toContain('ALTER ROLE combo_billing NOLOGIN NOSUPERUSER');
    expect(sql).toContain('GRANT SELECT, INSERT ON v2_ledger TO combo_billing;');
    expect(sql).toContain('GRANT SELECT, INSERT ON v2_metering_events TO combo_billing;');
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE ON v2_wallets TO combo_billing;');
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE ON v2_holds TO combo_billing;');
    // 流水与计量事件对应用角色不开放改删。
    expect(sql).not.toMatch(
      /GRANT[^;]*(UPDATE|DELETE)[^;]*v2_(ledger|metering_events)[^;]*TO combo_billing/i,
    );
    expect(sql).not.toMatch(/GRANT[^;]*DELETE[^;]*TO combo_billing/i);
    // 其他应用角色对计费表零权限。
    expect(sql).not.toMatch(
      /GRANT[^;]*v2_(wallets|ledger|orders|packages|holds|metering_events)[^;]*TO combo_(api|worker|runtime|authz)/i,
    );
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION gen_uuid_v7() TO combo_billing;');
  });
});
