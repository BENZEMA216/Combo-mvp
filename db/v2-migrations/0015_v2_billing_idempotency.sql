-- 0015 · 把 V2 hold、计量事件和幂等键绑定到同一 exact scope。
-- 0013 已在验证库执行，不得改写；本迁移只做可审计的增量收紧。

ALTER TABLE v2_holds
  ADD CONSTRAINT uq_v2_hold_exact_scope UNIQUE (id, user_id, agent_id, turn_id);

-- TypeScript/JSON 计费边界使用 number；所有可读写金额、数量及钱包推导值都必须保持在
-- IEEE-754 safe integer 范围内。升级遇到既有越界事实直接失败，不做有损收窄。
ALTER TABLE v2_wallets
  ADD CONSTRAINT ck_v2_wallet_safe_integer_range CHECK (
    principal_balance BETWEEN -9007199254740991 AND 9007199254740991
    AND bonus_balance BETWEEN -9007199254740991 AND 9007199254740991
    AND held_amount BETWEEN 0 AND 9007199254740991
    AND principal_balance::numeric + bonus_balance::numeric
      BETWEEN -9007199254740991 AND 9007199254740991
    AND principal_balance::numeric + bonus_balance::numeric - held_amount::numeric
      BETWEEN -9007199254740991 AND 9007199254740991
  );
ALTER TABLE v2_ledger
  ADD CONSTRAINT ck_v2_ledger_safe_integer_range CHECK (
    amount BETWEEN -9007199254740991 AND 9007199254740991
  );
ALTER TABLE v2_packages
  ADD CONSTRAINT ck_v2_packages_safe_integer_range CHECK (
    price <= 9007199254740991
    AND credit_amount <= 9007199254740991
    AND bonus_amount <= 9007199254740991
  );
ALTER TABLE v2_orders
  ADD CONSTRAINT ck_v2_orders_safe_integer_range CHECK (amount <= 9007199254740991);
ALTER TABLE v2_holds
  ADD CONSTRAINT ck_v2_holds_safe_integer_range CHECK (
    estimated_amount <= 9007199254740991
    AND (actual_amount IS NULL OR actual_amount <= 9007199254740991)
  );
ALTER TABLE v2_metering_events
  ADD CONSTRAINT ck_v2_metering_safe_integer_range CHECK (
    quantity <= 9007199254740991
    AND (unit_cost IS NULL OR unit_cost <= 9007199254740991)
  );

ALTER TABLE v2_metering_events
  ADD COLUMN idempotency_key text;

-- 0014 的充值流水直接保存调用方 key；先迁到 recharge 专属域，保证升级后同键重放
-- 仍能命中原账且不能与 hold/settle/release 系统键冲突。哈希契约与 service.ts 一致：
-- 小写 hex SHA-256(raw UTF-8 caller key)。
ALTER TABLE v2_ledger DISABLE TRIGGER trg_v2_ledger_append_only;
UPDATE v2_ledger
   SET idempotency_key = 'recharge:v1:' ||
       encode(digest(convert_to(idempotency_key, 'UTF8'), 'sha256'), 'hex')
 WHERE kind = 'recharge';
ALTER TABLE v2_ledger ENABLE TRIGGER trg_v2_ledger_append_only;

-- 旧事件没有调用方幂等键。迁移事务内暂时关闭行级 append-only trigger，按不可变
-- event id 生成唯一 legacy key，随即恢复；任何后续 UPDATE/DELETE 仍被拒绝。
ALTER TABLE v2_metering_events DISABLE TRIGGER trg_v2_metering_append_only;
UPDATE v2_metering_events
   SET idempotency_key = 'legacy:v0:' || id::text;
ALTER TABLE v2_metering_events ENABLE TRIGGER trg_v2_metering_append_only;

ALTER TABLE v2_metering_events
  ALTER COLUMN idempotency_key SET NOT NULL,
  ADD CONSTRAINT uq_v2_metering_idempotency UNIQUE (idempotency_key),
  ADD CONSTRAINT ck_v2_metering_idempotency_key CHECK (
    char_length(idempotency_key) BETWEEN 1 AND 128
    AND idempotency_key !~ '[[:cntrl:]]'
  );

-- Rolling writer compatibility: 0014 writer 仍提交 raw recharge key / NULL meter key；0015
-- writer 也提交调用方 raw key，由数据库在唯一约束前统一进入持久化域。estimated 是
-- settle 的系统域，不接受调用方预占。离线 host wrapper 仍是唯一受支持的升级入口，
-- 此触发器作为误操作时的最后一道防重复账保护。
CREATE FUNCTION normalize_v2_ledger_idempotency_key() RETURNS trigger AS $$
BEGIN
  IF NEW.kind = 'recharge' THEN
    NEW.idempotency_key := 'recharge:v1:' ||
      encode(digest(convert_to(NEW.idempotency_key, 'UTF8'), 'sha256'), 'hex');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
   SECURITY INVOKER
   SET search_path = pg_catalog, public;

CREATE TRIGGER trg_v2_ledger_idempotency_domain
  BEFORE INSERT ON v2_ledger
  FOR EACH ROW EXECUTE FUNCTION normalize_v2_ledger_idempotency_key();

CREATE FUNCTION normalize_v2_metering_idempotency_key() RETURNS trigger AS $$
BEGIN
  IF NEW.source = 'estimated' THEN
    IF NEW.hold_id IS NULL THEN
      RAISE EXCEPTION 'estimated metering requires hold_id'
        USING ERRCODE = '23514';
    END IF;
    NEW.idempotency_key := 'meter:estimated:v1:' || NEW.hold_id::text;
  ELSIF NEW.idempotency_key IS NULL THEN
    NEW.idempotency_key := 'legacy:v0:' || NEW.id::text;
  ELSE
    NEW.idempotency_key := 'meter-reported:v1:' ||
      encode(digest(convert_to(NEW.idempotency_key, 'UTF8'), 'sha256'), 'hex');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
   SECURITY INVOKER
   SET search_path = pg_catalog, public;

CREATE TRIGGER trg_v2_metering_idempotency_domain
  BEFORE INSERT ON v2_metering_events
  FOR EACH ROW EXECUTE FUNCTION normalize_v2_metering_idempotency_key();

ALTER TABLE v2_metering_events
  DROP CONSTRAINT v2_metering_events_hold_id_fkey,
  ADD CONSTRAINT fk_v2_metering_exact_hold
    FOREIGN KEY (hold_id, user_id, agent_id, turn_id)
    REFERENCES v2_holds (id, user_id, agent_id, turn_id)
    NOT VALID;

-- 历史错 scope 事件必须阻断升级，不能静默重写 append-only 事实。
ALTER TABLE v2_metering_events VALIDATE CONSTRAINT fk_v2_metering_exact_hold;

ALTER TABLE v2_holds DROP CONSTRAINT ck_v2_hold_settled;
ALTER TABLE v2_holds
  ADD CONSTRAINT ck_v2_hold_settled CHECK (
    (
      status = 'settled'
      AND actual_amount IS NOT NULL
      AND settled_at IS NOT NULL
    )
    OR (
      status <> 'settled'
      AND actual_amount IS NULL
      AND settled_at IS NULL
    )
  );

CREATE FUNCTION enforce_v2_hold_immutability() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'held' THEN
    RAISE EXCEPTION 'terminal v2_holds are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
     OR NEW.turn_id IS DISTINCT FROM OLD.turn_id
     OR NEW.estimated_amount IS DISTINCT FROM OLD.estimated_amount
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'v2_holds request identity is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.status = 'settled' THEN
    IF NEW.actual_amount IS NULL OR NEW.settled_at IS NULL THEN
      RAISE EXCEPTION 'settled v2_holds require exact settlement fields'
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.actual_amount IS NOT NULL OR NEW.settled_at IS NOT NULL THEN
    RAISE EXCEPTION 'non-settled v2_holds cannot carry settlement fields'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
   SECURITY INVOKER
   SET search_path = pg_catalog, public;

CREATE TRIGGER trg_v2_holds_immutable
  BEFORE UPDATE ON v2_holds
  FOR EACH ROW EXECUTE FUNCTION enforce_v2_hold_immutability();

-- 对带 hold 的新计量事实先锁定并核对 exact scope。它与 settle 的 FOR UPDATE 使用
-- 同一行锁：先到的计量会被 settle 看见，先完成的 settle 会拒绝晚到新事件。
CREATE FUNCTION enforce_v2_metering_active_hold() RETURNS trigger AS $$
DECLARE
  bound_status text;
BEGIN
  IF NEW.hold_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT status
    INTO bound_status
    FROM v2_holds
   WHERE id = NEW.hold_id
     AND user_id = NEW.user_id
     AND agent_id = NEW.agent_id
     AND turn_id = NEW.turn_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'metering event hold scope mismatch'
      USING ERRCODE = '23503';
  END IF;
  IF bound_status <> 'held' THEN
    RAISE EXCEPTION 'metering event hold is not active'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
   SECURITY INVOKER
   SET search_path = pg_catalog, public;

CREATE TRIGGER trg_v2_metering_active_hold
  BEFORE INSERT ON v2_metering_events
  FOR EACH ROW EXECUTE FUNCTION enforce_v2_metering_active_hold();

REVOKE UPDATE ON v2_holds FROM combo_billing;
GRANT UPDATE (status, actual_amount, settled_at) ON v2_holds TO combo_billing;
GRANT SELECT (id) ON v2_users TO combo_billing;
