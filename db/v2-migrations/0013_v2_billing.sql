-- 0013 · V2 支付中台验证期的计费侧结构：钱包四表（wallet / ledger / order / package）、
-- hold 预授权与 metering_event 计量事实源。user_id 跟随 0012 的 v2_users（uuid v7）。
-- 与 V1 计费相同的纪律：流水与计量事件只允许追加（触发器连所有者误操作也拒绝），
-- 应用角色只获得最小权限；金额一律 bigint 分。

-- 钱包。本金桶与赠送桶允许为负（便宜维度 fail-open 的透支），held_amount 不为负；
-- 负余额硬停阈值（-5 元）由应用在 hold 时执行，不落库约束。
CREATE TABLE v2_wallets (
  user_id           uuid        PRIMARY KEY REFERENCES v2_users(id),
  principal_balance bigint      NOT NULL DEFAULT 0,
  bonus_balance     bigint      NOT NULL DEFAULT 0,
  held_amount       bigint      NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_v2_wallet_held CHECK (held_amount >= 0),
  CONSTRAINT ck_v2_wallet_timestamps CHECK (updated_at >= created_at)
);

-- 资金流水，append-only。余额只是流水的推导结果，禁止无痕迹改余额；
-- 修正只能追加一条方向相反的补偿流水。idempotency_key 唯一约束保证回调与重放不重复入账。
CREATE TABLE v2_ledger (
  id              uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  user_id         uuid        NOT NULL REFERENCES v2_users(id),
  kind            text        NOT NULL,
  bucket          text,
  amount          bigint      NOT NULL,
  ref_id          text,
  idempotency_key text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_v2_ledger_idempotency UNIQUE (idempotency_key),
  CONSTRAINT ck_v2_ledger_kind CHECK (
    kind IN ('recharge', 'consume', 'refund', 'bonus', 'hold', 'release')
  ),
  CONSTRAINT ck_v2_ledger_bucket CHECK (
    bucket IS NULL OR bucket IN ('principal', 'bonus')
  ),
  -- 入账类为正、扣减为负且必须落桶；hold/release 只记录冻结动作，不落桶。
  CONSTRAINT ck_v2_ledger_shape CHECK (
    (kind IN ('recharge', 'bonus', 'refund') AND amount > 0 AND bucket IS NOT NULL)
    OR (kind = 'consume' AND amount < 0 AND bucket IS NOT NULL)
    OR (kind IN ('hold', 'release') AND amount > 0 AND bucket IS NULL)
  ),
  -- 退款只退本金桶。
  CONSTRAINT ck_v2_ledger_refund_bucket CHECK (
    kind <> 'refund' OR bucket = 'principal'
  ),
  CONSTRAINT ck_v2_ledger_ref CHECK (
    ref_id IS NULL OR (char_length(ref_id) BETWEEN 1 AND 128 AND ref_id !~ '[[:cntrl:]]')
  ),
  CONSTRAINT ck_v2_ledger_idempotency_key CHECK (
    char_length(idempotency_key) BETWEEN 1 AND 128
    AND idempotency_key !~ '[[:cntrl:]]'
  )
);

CREATE INDEX idx_v2_ledger_user_recent
  ON v2_ledger (user_id, created_at DESC, id);

-- 充值档位。1 元 = 1 额度，人民币计价，price / credit_amount / bonus_amount 都是分。
CREATE TABLE v2_packages (
  id            uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  name          text        NOT NULL,
  price         bigint      NOT NULL,
  credit_amount bigint      NOT NULL,
  bonus_amount  bigint      NOT NULL DEFAULT 0,
  status        text        NOT NULL DEFAULT 'active',
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_v2_package_name CHECK (
    char_length(name) BETWEEN 1 AND 128 AND name !~ '[[:cntrl:]]'
  ),
  CONSTRAINT ck_v2_package_price CHECK (price > 0),
  CONSTRAINT ck_v2_package_credit CHECK (credit_amount > 0),
  CONSTRAINT ck_v2_package_bonus CHECK (bonus_amount >= 0),
  CONSTRAINT ck_v2_package_status CHECK (status IN ('active', 'inactive'))
);

-- 充值订单。验证期没有真实微信支付回调，表按 spec 建好，状态机流转后续迭代接入。
CREATE TABLE v2_orders (
  id              uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  user_id         uuid        NOT NULL REFERENCES v2_users(id),
  package_id      uuid        NOT NULL REFERENCES v2_packages(id),
  amount          bigint      NOT NULL,
  channel         text        NOT NULL,
  channel_txn_id  text,
  status          text        NOT NULL DEFAULT 'created',
  invoice_status  text        NOT NULL DEFAULT 'none',
  idempotency_key text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  paid_at         timestamptz,
  CONSTRAINT uq_v2_order_idempotency UNIQUE (idempotency_key),
  CONSTRAINT ck_v2_order_amount CHECK (amount > 0),
  CONSTRAINT ck_v2_order_channel CHECK (channel IN ('wechat_native', 'wechat_jsapi')),
  CONSTRAINT ck_v2_order_status CHECK (
    status IN ('created', 'paid', 'refunding', 'refunded', 'closed')
  ),
  CONSTRAINT ck_v2_order_invoice_status CHECK (
    invoice_status IN ('none', 'requested', 'issued')
  ),
  CONSTRAINT ck_v2_order_paid CHECK (
    paid_at IS NULL OR status IN ('paid', 'refunding', 'refunded')
  )
);

CREATE INDEX idx_v2_orders_user_recent
  ON v2_orders (user_id, created_at DESC, id);

-- 预授权。同一 Agent 内 turn_id 唯一即幂等键：重复 hold 直接返回原行。
-- 状态机由触发器强制：held 只能落定 settled / released / expired，终态不可再改。
CREATE TABLE v2_holds (
  id               uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  user_id          uuid        NOT NULL REFERENCES v2_users(id),
  agent_id         text        NOT NULL,
  turn_id          text        NOT NULL,
  estimated_amount bigint      NOT NULL,
  actual_amount    bigint,
  status           text        NOT NULL DEFAULT 'held',
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  settled_at       timestamptz,
  CONSTRAINT uq_v2_hold_agent_turn UNIQUE (agent_id, turn_id),
  CONSTRAINT ck_v2_hold_agent CHECK (
    agent_id ~ '^[a-z0-9][a-z0-9-]{0,62}$'
  ),
  CONSTRAINT ck_v2_hold_turn CHECK (
    char_length(turn_id) BETWEEN 1 AND 128 AND turn_id !~ '[[:cntrl:]]'
  ),
  CONSTRAINT ck_v2_hold_estimated CHECK (estimated_amount > 0),
  CONSTRAINT ck_v2_hold_status CHECK (status IN ('held', 'settled', 'released', 'expired')),
  -- hold TTL 固定五分钟（spec 八），超时由清扫任务自动解冻。
  CONSTRAINT ck_v2_hold_ttl CHECK (expires_at = created_at + interval '5 minutes'),
  CONSTRAINT ck_v2_hold_settled CHECK (
    (status = 'settled') = (actual_amount IS NOT NULL AND settled_at IS NOT NULL)
  ),
  CONSTRAINT ck_v2_hold_actual CHECK (actual_amount IS NULL OR actual_amount >= 0)
);

CREATE INDEX idx_v2_holds_user_live
  ON v2_holds (user_id, created_at DESC)
  WHERE status = 'held';
CREATE INDEX idx_v2_holds_sweep
  ON v2_holds (expires_at)
  WHERE status = 'held';

-- 计量事件，事实源，append-only。source=estimated 是 settle 时真实用量缺失的兜底行，
-- 没有维度；真实上报（gateway / agent_report）必须带维度枚举。
CREATE TABLE v2_metering_events (
  id         uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  agent_id   text        NOT NULL,
  user_id    uuid        NOT NULL REFERENCES v2_users(id),
  turn_id    text        NOT NULL,
  hold_id    uuid        REFERENCES v2_holds(id),
  dimension  text,
  quantity   bigint      NOT NULL,
  model      text,
  unit_cost  bigint,
  source     text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_v2_metering_agent CHECK (
    agent_id ~ '^[a-z0-9][a-z0-9-]{0,62}$'
  ),
  CONSTRAINT ck_v2_metering_turn CHECK (
    char_length(turn_id) BETWEEN 1 AND 128 AND turn_id !~ '[[:cntrl:]]'
  ),
  CONSTRAINT ck_v2_metering_dimension CHECK (
    dimension IS NULL
    OR dimension IN (
      'llm_token_in', 'llm_token_out', 'tts_char',
      'image_gen', 'retrieval_call', 'audio_second'
    )
  ),
  CONSTRAINT ck_v2_metering_estimated CHECK (
    (source = 'estimated') = (dimension IS NULL)
  ),
  CONSTRAINT ck_v2_metering_quantity CHECK (quantity > 0),
  CONSTRAINT ck_v2_metering_unit_cost CHECK (unit_cost IS NULL OR unit_cost >= 0),
  CONSTRAINT ck_v2_metering_source CHECK (source IN ('gateway', 'agent_report', 'estimated')),
  CONSTRAINT ck_v2_metering_model CHECK (
    model IS NULL OR (char_length(model) BETWEEN 1 AND 128 AND model !~ '[[:cntrl:]]')
  )
);

CREATE INDEX idx_v2_metering_agent_recent
  ON v2_metering_events (agent_id, created_at DESC, id);
CREATE INDEX idx_v2_metering_user_recent
  ON v2_metering_events (user_id, created_at DESC, id);
CREATE INDEX idx_v2_metering_turn ON v2_metering_events (turn_id);
CREATE INDEX idx_v2_metering_hold
  ON v2_metering_events (hold_id)
  WHERE hold_id IS NOT NULL;

-- 流水与计量事件 append-only：应用角色本来就没有 UPDATE/DELETE，
-- 触发器再保护所有者误操作（与 0009 wallet_ledger 同一纪律）。
CREATE FUNCTION reject_v2_append_only_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql
   SECURITY INVOKER
   SET search_path = pg_catalog, public;

CREATE TRIGGER trg_v2_ledger_append_only
  BEFORE UPDATE OR DELETE ON v2_ledger
  FOR EACH ROW EXECUTE FUNCTION reject_v2_append_only_mutation();
CREATE TRIGGER trg_v2_ledger_no_truncate
  BEFORE TRUNCATE ON v2_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION reject_v2_append_only_mutation();
CREATE TRIGGER trg_v2_metering_append_only
  BEFORE UPDATE OR DELETE ON v2_metering_events
  FOR EACH ROW EXECUTE FUNCTION reject_v2_append_only_mutation();
CREATE TRIGGER trg_v2_metering_no_truncate
  BEFORE TRUNCATE ON v2_metering_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_v2_append_only_mutation();

-- hold 状态机：held 只能落定三种终态，终态不可再流转。
CREATE FUNCTION enforce_v2_hold_transition() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'held' AND NEW.status IN ('settled', 'released', 'expired') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'illegal v2_holds status transition % -> %', OLD.status, NEW.status
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql
   SECURITY INVOKER
   SET search_path = pg_catalog, public;

CREATE TRIGGER trg_v2_holds_transition
  BEFORE UPDATE OF status ON v2_holds
  FOR EACH ROW EXECUTE FUNCTION enforce_v2_hold_transition();

-- billing 进程使用独立登录角色，密码由迁移 runner 通过 POSTGRES_BILLING_PASSWORD 设置。
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'combo_billing') THEN
    EXECUTE 'CREATE ROLE combo_billing NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;
END
$roles$;

ALTER ROLE combo_billing NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

GRANT USAGE ON SCHEMA public TO combo_billing;

-- 计费表只对 combo_billing 开放；其余应用角色与 PUBLIC 零权限。
REVOKE ALL PRIVILEGES ON
  v2_wallets,
  v2_ledger,
  v2_orders,
  v2_packages,
  v2_holds,
  v2_metering_events
  FROM PUBLIC, combo_api, combo_worker, combo_runtime, combo_authz, combo_billing;

-- 流水与计量事件只允许查询和追加；其余表按读写最小集授权。
GRANT SELECT, INSERT, UPDATE ON v2_wallets TO combo_billing;
GRANT SELECT, INSERT ON v2_ledger TO combo_billing;
GRANT SELECT, INSERT, UPDATE ON v2_orders, v2_packages TO combo_billing;
GRANT SELECT, INSERT, UPDATE ON v2_holds TO combo_billing;
GRANT SELECT, INSERT ON v2_metering_events TO combo_billing;

GRANT EXECUTE ON FUNCTION gen_uuid_v7() TO combo_billing;
