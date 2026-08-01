-- 0009 · 共享 Agent 的内部计费与乐收赢充值账本。
--
-- 乐收赢只负责把外部付款变成充值订单；免费额度、钱包预留、使用结算与资金流水
-- 都由本库维护。金额一律使用 bigint 分，应用边界不得用浮点数。

-- 使用扣费同时保存 Session、Capability、使用者和 Turn。冗余唯一约束供复合外键
-- 校验这四个标识确实属于同一个消费上下文。
ALTER TABLE sessions
  ADD CONSTRAINT uq_sessions_billing_scope
  UNIQUE (id, capability_id, owner_user_id);

-- 用户的全局钱包。balance_cents 是可用余额，reserved_cents 是运行中 Turn 已预留、
-- 尚未结算的余额；二者之和才是资金流水当前净额。
CREATE TABLE billing_accounts (
  owner_user_id uuid        PRIMARY KEY REFERENCES users(id),
  balance_cents bigint      NOT NULL DEFAULT 0,
  reserved_cents bigint     NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_billing_account_amounts CHECK (
    balance_cents >= 0
    AND reserved_cents >= 0
  ),
  CONSTRAINT ck_billing_account_timestamps CHECK (updated_at >= created_at)
);

-- 免费额度按使用者与共享 Agent 隔离；钱包仍由 billing_accounts 全局共享。
-- 首次使用时保存策略快照，后续配置变化不会重算已经发生的使用。
CREATE TABLE billing_free_allowances (
  owner_user_id      uuid        NOT NULL REFERENCES billing_accounts(owner_user_id),
  capability_id      uuid        NOT NULL REFERENCES capabilities(id),
  policy_version     text        NOT NULL,
  free_limit_snapshot int        NOT NULL,
  free_used_count    int         NOT NULL DEFAULT 0,
  free_reserved_count int        NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, capability_id),
  CONSTRAINT ck_billing_free_policy_version CHECK (
    char_length(policy_version) BETWEEN 1 AND 128
    AND policy_version !~ '[[:cntrl:]]'
  ),
  CONSTRAINT ck_billing_free_counts CHECK (
    free_limit_snapshot >= 0
    AND free_used_count >= 0
    AND free_reserved_count >= 0
    AND free_used_count + free_reserved_count <= free_limit_snapshot
  ),
  CONSTRAINT ck_billing_free_timestamps CHECK (updated_at >= created_at)
);

-- 一次用户主动发送只产生一条扣费记录。同一 usage_id 的网络重试回读原记录；
-- request_fingerprint 不同则由应用报告幂等冲突。
CREATE TABLE usage_charges (
  id                  uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  owner_user_id       uuid        NOT NULL REFERENCES billing_accounts(owner_user_id),
  usage_id            uuid        NOT NULL,
  capability_id       uuid        NOT NULL,
  session_id          uuid        NOT NULL,
  turn_id             uuid        NOT NULL,
  request_fingerprint char(64)    NOT NULL,
  charge_source       text        NOT NULL,
  status              text        NOT NULL DEFAULT 'reserved',
  unit_price_cents    bigint      NOT NULL,
  free_limit_snapshot int         NOT NULL,
  reserved_cents      bigint      NOT NULL,
  settled_cents       bigint      NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  CONSTRAINT uq_usage_charge_owner_usage UNIQUE (owner_user_id, usage_id),
  CONSTRAINT uq_usage_charge_turn UNIQUE (turn_id),
  CONSTRAINT uq_usage_charge_id_owner UNIQUE (id, owner_user_id),
  CONSTRAINT fk_usage_charge_session_scope
    FOREIGN KEY (session_id, capability_id, owner_user_id)
    REFERENCES sessions (id, capability_id, owner_user_id),
  CONSTRAINT fk_usage_charge_turn_scope
    FOREIGN KEY (turn_id, session_id)
    REFERENCES turns (id, session_id),
  CONSTRAINT ck_usage_charge_fingerprint CHECK (
    request_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ck_usage_charge_source CHECK (
    charge_source IN ('owner', 'free', 'wallet')
  ),
  CONSTRAINT ck_usage_charge_status CHECK (
    status IN ('reserved', 'completed', 'released')
  ),
  CONSTRAINT ck_usage_charge_snapshots CHECK (
    unit_price_cents >= 0
    AND free_limit_snapshot >= 0
    AND reserved_cents >= 0
    AND settled_cents >= 0
  ),
  CONSTRAINT ck_usage_charge_source_amounts CHECK (
    (
      charge_source IN ('owner', 'free')
      AND reserved_cents = 0
      AND settled_cents = 0
    )
    OR (
      charge_source = 'wallet'
      AND unit_price_cents > 0
      AND reserved_cents = unit_price_cents
      AND settled_cents <= reserved_cents
    )
  ),
  CONSTRAINT ck_usage_charge_terminal CHECK (
    (
      status = 'reserved'
      AND settled_cents = 0
      AND finished_at IS NULL
    )
    OR (
      status = 'completed'
      AND finished_at IS NOT NULL
      AND (
        charge_source IN ('owner', 'free')
        OR settled_cents > 0
      )
    )
    OR (
      status = 'released'
      AND settled_cents = 0
      AND finished_at IS NOT NULL
    )
  ),
  CONSTRAINT ck_usage_charge_timestamps CHECK (
    updated_at >= created_at
    AND (finished_at IS NULL OR finished_at >= created_at)
  )
);

CREATE INDEX idx_usage_charges_owner_recent
  ON usage_charges (owner_user_id, created_at DESC);
CREATE INDEX idx_usage_charges_reserved
  ON usage_charges (created_at, id)
  WHERE status = 'reserved';

-- 内部充值订单保存定价、商户和支付流水快照。payment_status 表示外部交易，
-- credit_status 表示内部钱包是否已经幂等入账，两者刻意分开。
CREATE TABLE recharge_orders (
  id                     uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  order_no               text        NOT NULL UNIQUE,
  owner_user_id          uuid        NOT NULL REFERENCES users(id),
  client_idempotency_key text        NOT NULL,
  package_id             text        NOT NULL,
  amount_cents           bigint      NOT NULL,
  payment_method         text        NOT NULL,
  gateway_environment    text        NOT NULL,
  institution_no         text        NOT NULL,
  merchant_no            text        NOT NULL,
  pay_trace_no           text        NOT NULL,
  pay_time               char(14)    NOT NULL,
  payment_status         text        NOT NULL DEFAULT 'created',
  credit_status          text        NOT NULL DEFAULT 'uncredited',
  platform_trade_no      text,
  query_attempt_count    int         NOT NULL DEFAULT 0,
  next_query_at          timestamptz,
  query_lease_owner      text,
  query_lease_expires_at timestamptz,
  last_queried_at        timestamptz,
  paid_at                timestamptz,
  credited_at            timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_recharge_owner_idempotency
    UNIQUE (owner_user_id, client_idempotency_key),
  CONSTRAINT uq_recharge_gateway_trace UNIQUE (pay_trace_no, pay_time),
  CONSTRAINT uq_recharge_id_owner UNIQUE (id, owner_user_id),
  CONSTRAINT ck_recharge_order_text CHECK (
    char_length(order_no) BETWEEN 1 AND 128
    AND char_length(client_idempotency_key) BETWEEN 1 AND 128
    AND char_length(package_id) BETWEEN 1 AND 128
    AND char_length(institution_no) BETWEEN 1 AND 128
    AND char_length(merchant_no) BETWEEN 1 AND 128
    AND char_length(pay_trace_no) BETWEEN 1 AND 128
    AND order_no !~ '[[:cntrl:]]'
    AND client_idempotency_key !~ '[[:cntrl:]]'
    AND package_id !~ '[[:cntrl:]]'
    AND institution_no !~ '[[:cntrl:]]'
    AND merchant_no !~ '[[:cntrl:]]'
    AND pay_trace_no !~ '[[:cntrl:]]'
  ),
  CONSTRAINT ck_recharge_amount CHECK (amount_cents > 0),
  CONSTRAINT ck_recharge_payment_method CHECK (
    payment_method IN ('h5', 'aggregate_qr')
  ),
  CONSTRAINT ck_recharge_gateway_environment CHECK (
    gateway_environment IN ('test', 'production')
  ),
  CONSTRAINT ck_recharge_pay_time CHECK (pay_time ~ '^[0-9]{14}$'),
  CONSTRAINT ck_recharge_payment_status CHECK (
    payment_status IN ('created', 'pending', 'unknown', 'succeeded', 'failed', 'closed')
  ),
  CONSTRAINT ck_recharge_credit_status CHECK (
    credit_status IN ('uncredited', 'credited')
  ),
  CONSTRAINT ck_recharge_query_attempts CHECK (query_attempt_count >= 0),
  CONSTRAINT ck_recharge_query_lease CHECK (
    (
      query_lease_owner IS NULL
      AND query_lease_expires_at IS NULL
    )
    OR (
      query_lease_owner IS NOT NULL
      AND char_length(query_lease_owner) BETWEEN 1 AND 128
      AND query_lease_owner !~ '[[:cntrl:]]'
      AND query_lease_expires_at IS NOT NULL
    )
  ),
  CONSTRAINT ck_recharge_payment_terminal CHECK (
    (
      payment_status = 'succeeded'
      AND platform_trade_no IS NOT NULL
      AND paid_at IS NOT NULL
    )
    OR (
      payment_status <> 'succeeded'
      AND paid_at IS NULL
    )
  ),
  CONSTRAINT ck_recharge_credit_terminal CHECK (
    (
      credit_status = 'credited'
      AND payment_status = 'succeeded'
      AND credited_at IS NOT NULL
    )
    OR (
      credit_status = 'uncredited'
      AND credited_at IS NULL
    )
  ),
  CONSTRAINT ck_recharge_timestamps CHECK (
    updated_at >= created_at
    AND (last_queried_at IS NULL OR last_queried_at >= created_at)
    AND (credited_at IS NULL OR credited_at >= created_at)
  )
);

CREATE UNIQUE INDEX uq_recharge_platform_trade
  ON recharge_orders (
    gateway_environment,
    institution_no,
    merchant_no,
    platform_trade_no
  )
  WHERE platform_trade_no IS NOT NULL;
CREATE INDEX idx_recharge_owner_recent
  ON recharge_orders (owner_user_id, created_at DESC);
CREATE INDEX idx_recharge_query_due
  ON recharge_orders (next_query_at, created_at, id)
  WHERE payment_status IN ('created', 'pending', 'unknown')
    AND credit_status = 'uncredited';
CREATE INDEX idx_recharge_query_lease
  ON recharge_orders (query_lease_expires_at, id)
  WHERE payment_status IN ('created', 'pending', 'unknown')
    AND credit_status = 'uncredited';

-- 网关提交尝试保存固定请求指纹和低敏结果。action_value 仅供 API 回读短期支付
-- 动作，禁止写入业务日志；回调和主动查单仍是支付成功真源。
CREATE TABLE payment_attempts (
  id                  uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  recharge_order_id   uuid        NOT NULL REFERENCES recharge_orders(id),
  attempt_no          int         NOT NULL,
  status              text        NOT NULL DEFAULT 'submitting',
  request_fingerprint char(64)    NOT NULL,
  gateway_result_code text,
  platform_trade_no   text,
  action_kind         text,
  action_value        text,
  action_expires_at   timestamptz,
  started_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_payment_attempt_order_no UNIQUE (recharge_order_id, attempt_no),
  CONSTRAINT ck_payment_attempt_number CHECK (attempt_no > 0),
  CONSTRAINT ck_payment_attempt_status CHECK (
    status IN ('submitting', 'pending', 'unknown', 'succeeded', 'failed')
  ),
  CONSTRAINT ck_payment_attempt_fingerprint CHECK (
    request_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ck_payment_attempt_action CHECK (
    (
      action_kind IS NULL
      AND action_value IS NULL
      AND action_expires_at IS NULL
    )
    OR (
      action_kind IN ('redirect_url', 'code_url')
      AND action_value IS NOT NULL
      AND action_expires_at IS NOT NULL
      AND char_length(action_value) BETWEEN 1 AND 8192
    )
  ),
  CONSTRAINT ck_payment_attempt_terminal CHECK (
    (
      status IN ('succeeded', 'failed')
      AND completed_at IS NOT NULL
    )
    OR (
      status IN ('submitting', 'pending', 'unknown')
      AND completed_at IS NULL
    )
  ),
  CONSTRAINT ck_payment_attempt_timestamps CHECK (
    updated_at >= started_at
    AND (completed_at IS NULL OR completed_at >= started_at)
    AND (action_expires_at IS NULL OR action_expires_at >= started_at)
  )
);

CREATE INDEX idx_payment_attempts_order_recent
  ON payment_attempts (recharge_order_id, attempt_no DESC);
CREATE INDEX idx_payment_attempts_action_expiry
  ON payment_attempts (action_expires_at, id)
  WHERE action_value IS NOT NULL;

-- 回调只保存 SHA-256 指纹和经过挑选的低敏字段，不保存原始 JSON、签名或收银台 URL。
-- 验签失败或金额/归属不符可以记录 rejected，但永远不能进入 processed。
CREATE TABLE payment_callback_events (
  id                    uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  event_fingerprint     char(64)    NOT NULL UNIQUE,
  recharge_order_id     uuid        REFERENCES recharge_orders(id),
  signature_valid       boolean     NOT NULL,
  platform_trade_no     text,
  amount_cents          bigint,
  trade_status          text,
  processing_status     text        NOT NULL DEFAULT 'received',
  rejection_code        text,
  received_at           timestamptz NOT NULL DEFAULT now(),
  processed_at          timestamptz,
  CONSTRAINT ck_payment_callback_fingerprint CHECK (
    event_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ck_payment_callback_amount CHECK (
    amount_cents IS NULL OR amount_cents > 0
  ),
  CONSTRAINT ck_payment_callback_status CHECK (
    processing_status IN ('received', 'processed', 'rejected')
  ),
  CONSTRAINT ck_payment_callback_outcome CHECK (
    (
      processing_status = 'received'
      AND processed_at IS NULL
      AND rejection_code IS NULL
    )
    OR (
      processing_status = 'processed'
      AND signature_valid
      AND recharge_order_id IS NOT NULL
      AND platform_trade_no IS NOT NULL
      AND amount_cents IS NOT NULL
      AND trade_status IS NOT NULL
      AND rejection_code IS NULL
      AND processed_at IS NOT NULL
    )
    OR (
      processing_status = 'rejected'
      AND rejection_code IS NOT NULL
      AND char_length(rejection_code) BETWEEN 1 AND 128
      AND rejection_code !~ '[[:cntrl:]]'
      AND processed_at IS NOT NULL
    )
  ),
  CONSTRAINT ck_payment_callback_timestamps CHECK (
    processed_at IS NULL OR processed_at >= received_at
  )
);

CREATE INDEX idx_payment_callback_order_recent
  ON payment_callback_events (recharge_order_id, received_at DESC)
  WHERE recharge_order_id IS NOT NULL;
CREATE INDEX idx_payment_callback_rejected_retention
  ON payment_callback_events (received_at, id)
  WHERE processing_status = 'rejected';

-- 资金流水只追加。正数增加用户资金，负数减少用户资金；恰好一个强类型业务
-- 外键作为来源，复合外键同时防止把其他用户的订单或使用记录挂到账户上。
CREATE TABLE wallet_ledger (
  id                uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  owner_user_id     uuid        NOT NULL REFERENCES billing_accounts(owner_user_id),
  entry_type        text        NOT NULL,
  amount_cents      bigint      NOT NULL,
  recharge_order_id uuid,
  usage_charge_id   uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_wallet_ledger_recharge_owner
    FOREIGN KEY (recharge_order_id, owner_user_id)
    REFERENCES recharge_orders (id, owner_user_id),
  CONSTRAINT fk_wallet_ledger_usage_owner
    FOREIGN KEY (usage_charge_id, owner_user_id)
    REFERENCES usage_charges (id, owner_user_id),
  CONSTRAINT ck_wallet_ledger_entry_type CHECK (
    entry_type IN (
      'recharge_credit',
      'recharge_refund',
      'usage_debit',
      'usage_compensation'
    )
  ),
  CONSTRAINT ck_wallet_ledger_reference CHECK (
    (
      entry_type = 'recharge_credit'
      AND amount_cents > 0
      AND recharge_order_id IS NOT NULL
      AND usage_charge_id IS NULL
    )
    OR (
      entry_type = 'recharge_refund'
      AND amount_cents < 0
      AND recharge_order_id IS NOT NULL
      AND usage_charge_id IS NULL
    )
    OR (
      entry_type = 'usage_debit'
      AND amount_cents < 0
      AND recharge_order_id IS NULL
      AND usage_charge_id IS NOT NULL
    )
    OR (
      entry_type = 'usage_compensation'
      AND amount_cents > 0
      AND recharge_order_id IS NULL
      AND usage_charge_id IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX uq_wallet_ledger_recharge_entry
  ON wallet_ledger (entry_type, recharge_order_id)
  WHERE recharge_order_id IS NOT NULL;
CREATE UNIQUE INDEX uq_wallet_ledger_usage_entry
  ON wallet_ledger (entry_type, usage_charge_id)
  WHERE usage_charge_id IS NOT NULL;
CREATE INDEX idx_wallet_ledger_owner_recent
  ON wallet_ledger (owner_user_id, created_at DESC, id);

-- 所有应用角色本来就没有 UPDATE/DELETE；触发器再保护所有者误操作，修正只能追加
-- 一条方向相反、类型明确的补偿流水。
CREATE FUNCTION reject_wallet_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'wallet_ledger is append-only'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql
   SECURITY INVOKER
   SET search_path = pg_catalog, public;

CREATE TRIGGER trg_wallet_ledger_append_only
  BEFORE UPDATE OR DELETE ON wallet_ledger
  FOR EACH ROW EXECUTE FUNCTION reject_wallet_ledger_mutation();

CREATE TRIGGER trg_wallet_ledger_no_truncate
  BEFORE TRUNCATE ON wallet_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION reject_wallet_ledger_mutation();

-- 应用角色只能追加本进程职责内的原始流水。本轮没有第三方退款或扣款后补偿，
-- 因此这两类反向流水只保留结构，不向应用角色开放。
CREATE FUNCTION enforce_wallet_ledger_writer() RETURNS trigger AS $$
BEGIN
  IF current_user = 'combo_api' THEN
    IF NEW.entry_type <> 'recharge_credit' THEN
      RAISE EXCEPTION 'combo_api cannot append % wallet ledger entries', NEW.entry_type
        USING ERRCODE = '42501';
    END IF;
    PERFORM 1
      FROM public.recharge_orders
     WHERE id = NEW.recharge_order_id
     FOR UPDATE;
  ELSIF current_user = 'combo_runtime' THEN
    IF NEW.entry_type <> 'usage_debit' THEN
      RAISE EXCEPTION 'combo_runtime cannot append % wallet ledger entries', NEW.entry_type
        USING ERRCODE = '42501';
    END IF;
    PERFORM 1
      FROM public.usage_charges
     WHERE id = NEW.usage_charge_id
     FOR UPDATE;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql
   SECURITY INVOKER
   SET search_path = pg_catalog, public;

CREATE TRIGGER trg_wallet_ledger_writer
  BEFORE INSERT ON wallet_ledger
  FOR EACH ROW EXECUTE FUNCTION enforce_wallet_ledger_writer();

-- 预留只在可用余额与 reserved 之间移动资金；充值和结算则必须在同一事务追加
-- 等额流水。延迟到提交时校验，允许应用按任意安全顺序写相关表。numeric 避免
-- bigint 求和溢出；锁定账户行使同一钱包的并发提交串行化。
CREATE FUNCTION enforce_wallet_account_ledger_equation() RETURNS trigger AS $$
DECLARE
  affected_owner uuid;
  account_balance numeric;
  account_reserved numeric;
  ledger_total numeric;
  charge_reserved numeric;
BEGIN
  IF TG_TABLE_NAME = 'usage_charges' THEN
    IF TG_OP = 'DELETE' AND OLD.charge_source <> 'wallet' THEN
      RETURN OLD;
    ELSIF TG_OP = 'INSERT' AND NEW.charge_source <> 'wallet' THEN
      RETURN NEW;
    ELSIF TG_OP = 'UPDATE'
          AND OLD.charge_source <> 'wallet'
          AND NEW.charge_source <> 'wallet' THEN
      RETURN NEW;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    affected_owner := OLD.owner_user_id;
  ELSE
    affected_owner := NEW.owner_user_id;
  END IF;

  SELECT balance_cents::numeric, reserved_cents::numeric
    INTO account_balance, account_reserved
    FROM public.billing_accounts
   WHERE owner_user_id = affected_owner
   FOR UPDATE;
  IF account_balance IS NULL THEN
    RAISE EXCEPTION 'billing account disappeared for owner %', affected_owner
      USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(sum(amount_cents), 0::numeric)
    INTO ledger_total
    FROM public.wallet_ledger
   WHERE owner_user_id = affected_owner;
  SELECT COALESCE(sum(reserved_cents::numeric), 0::numeric)
    INTO charge_reserved
    FROM public.usage_charges
   WHERE owner_user_id = affected_owner
     AND charge_source = 'wallet'
     AND status = 'reserved';

  IF account_balance + account_reserved <> ledger_total THEN
    RAISE EXCEPTION 'wallet account and ledger totals diverged for owner %', affected_owner
      USING ERRCODE = '23514';
  END IF;
  IF account_reserved <> charge_reserved THEN
    RAISE EXCEPTION 'wallet reservation total diverged for owner %', affected_owner
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
   SECURITY INVOKER
   SET search_path = pg_catalog, public;

-- 支付成功、内部入账状态和充值流水必须双向一致；不能只改订单状态，也不能只写流水。
CREATE FUNCTION enforce_recharge_credit_equation() RETURNS trigger AS $$
DECLARE
  affected_order uuid;
  order_amount numeric;
  order_payment_status text;
  order_credit_status text;
  credit_count bigint;
  credit_total numeric;
BEGIN
  IF TG_TABLE_NAME = 'recharge_orders' THEN
    IF TG_OP = 'DELETE' THEN
      affected_order := OLD.id;
    ELSE
      affected_order := NEW.id;
    END IF;
  ELSE
    IF TG_OP = 'DELETE' THEN
      affected_order := OLD.recharge_order_id;
    ELSE
      affected_order := NEW.recharge_order_id;
    END IF;
  END IF;
  IF affected_order IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  SELECT amount_cents::numeric, payment_status, credit_status
    INTO order_amount, order_payment_status, order_credit_status
    FROM public.recharge_orders
   WHERE id = affected_order
   FOR UPDATE;
  SELECT count(*), COALESCE(sum(amount_cents), 0::numeric)
    INTO credit_count, credit_total
    FROM public.wallet_ledger
   WHERE recharge_order_id = affected_order
     AND entry_type = 'recharge_credit';

  IF order_amount IS NULL THEN
    IF credit_count <> 0 THEN
      RAISE EXCEPTION 'recharge credit references a missing order %', affected_order
        USING ERRCODE = '23514';
    END IF;
  ELSIF order_payment_status = 'succeeded' OR order_credit_status = 'credited' THEN
    IF order_payment_status <> 'succeeded'
       OR order_credit_status <> 'credited'
       OR credit_count <> 1
       OR credit_total <> order_amount THEN
      RAISE EXCEPTION 'recharge order and credit ledger diverged for order %', affected_order
        USING ERRCODE = '23514';
    END IF;
  ELSIF credit_count <> 0 THEN
    RAISE EXCEPTION 'unpaid recharge order has a credit ledger entry %', affected_order
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
   SECURITY INVOKER
   SET search_path = pg_catalog, public;

-- 钱包使用只有 completed 的 wallet charge 可以有一条精确等额的 debit 流水。
CREATE FUNCTION enforce_usage_debit_equation() RETURNS trigger AS $$
DECLARE
  affected_charge uuid;
  charge_source_value text;
  charge_status text;
  charge_settled numeric;
  debit_count bigint;
  debit_total numeric;
BEGIN
  IF TG_TABLE_NAME = 'usage_charges' THEN
    IF TG_OP = 'DELETE' THEN
      affected_charge := OLD.id;
    ELSE
      affected_charge := NEW.id;
    END IF;
  ELSE
    IF TG_OP = 'DELETE' THEN
      affected_charge := OLD.usage_charge_id;
    ELSE
      affected_charge := NEW.usage_charge_id;
    END IF;
  END IF;
  IF affected_charge IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  SELECT charge_source, status, settled_cents::numeric
    INTO charge_source_value, charge_status, charge_settled
    FROM public.usage_charges
   WHERE id = affected_charge
   FOR UPDATE;
  SELECT count(*), COALESCE(sum(amount_cents), 0::numeric)
    INTO debit_count, debit_total
    FROM public.wallet_ledger
   WHERE usage_charge_id = affected_charge
     AND entry_type = 'usage_debit';

  IF charge_source_value IS NULL THEN
    IF debit_count <> 0 THEN
      RAISE EXCEPTION 'usage debit references a missing charge %', affected_charge
        USING ERRCODE = '23514';
    END IF;
  ELSIF charge_source_value = 'wallet' AND charge_status = 'completed' THEN
    IF debit_count <> 1 OR charge_settled <= 0 OR debit_total <> -charge_settled THEN
      RAISE EXCEPTION 'completed wallet charge and debit ledger diverged for charge %', affected_charge
        USING ERRCODE = '23514';
    END IF;
  ELSIF debit_count <> 0 THEN
    RAISE EXCEPTION 'non-completed wallet charge has a debit ledger entry %', affected_charge
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
   SECURITY INVOKER
   SET search_path = pg_catalog, public;

-- 免费额度计数必须等于其强类型使用记录，避免预留、成功次数与 usageId 账本漂移。
CREATE FUNCTION enforce_free_allowance_equation() RETURNS trigger AS $$
DECLARE
  affected_owner uuid;
  affected_capability uuid;
  allowance_used bigint;
  allowance_reserved bigint;
  charge_used bigint;
  charge_reserved bigint;
BEGIN
  IF TG_TABLE_NAME = 'usage_charges' THEN
    IF TG_OP = 'DELETE' AND OLD.charge_source <> 'free' THEN
      RETURN OLD;
    ELSIF TG_OP = 'INSERT' AND NEW.charge_source <> 'free' THEN
      RETURN NEW;
    ELSIF TG_OP = 'UPDATE'
          AND OLD.charge_source <> 'free'
          AND NEW.charge_source <> 'free' THEN
      RETURN NEW;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    affected_owner := OLD.owner_user_id;
    affected_capability := OLD.capability_id;
  ELSE
    affected_owner := NEW.owner_user_id;
    affected_capability := NEW.capability_id;
  END IF;

  SELECT free_used_count::bigint, free_reserved_count::bigint
    INTO allowance_used, allowance_reserved
    FROM public.billing_free_allowances
   WHERE owner_user_id = affected_owner
     AND capability_id = affected_capability
   FOR UPDATE;
  SELECT
      count(*) FILTER (WHERE status = 'completed'),
      count(*) FILTER (WHERE status = 'reserved')
    INTO charge_used, charge_reserved
    FROM public.usage_charges
   WHERE owner_user_id = affected_owner
     AND capability_id = affected_capability
     AND charge_source = 'free';

  IF allowance_used IS NULL THEN
    IF charge_used <> 0 OR charge_reserved <> 0 THEN
      RAISE EXCEPTION 'free usage charge has no allowance for owner % and capability %',
        affected_owner, affected_capability USING ERRCODE = '23514';
    END IF;
  ELSIF allowance_used <> charge_used OR allowance_reserved <> charge_reserved THEN
    RAISE EXCEPTION 'free allowance and usage charges diverged for owner % and capability %',
      affected_owner, affected_capability USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
   SECURITY INVOKER
   SET search_path = pg_catalog, public;

CREATE CONSTRAINT TRIGGER trg_billing_account_ledger_equation
  AFTER INSERT OR UPDATE OR DELETE ON billing_accounts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_wallet_account_ledger_equation();

CREATE CONSTRAINT TRIGGER trg_wallet_ledger_account_equation
  AFTER INSERT OR UPDATE OR DELETE ON wallet_ledger
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_wallet_account_ledger_equation();

CREATE CONSTRAINT TRIGGER trg_usage_charge_account_equation
  AFTER INSERT OR UPDATE OR DELETE ON usage_charges
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_wallet_account_ledger_equation();

CREATE CONSTRAINT TRIGGER trg_recharge_order_credit_equation
  AFTER INSERT OR UPDATE OR DELETE ON recharge_orders
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_recharge_credit_equation();

CREATE CONSTRAINT TRIGGER trg_wallet_ledger_recharge_equation
  AFTER INSERT OR UPDATE OR DELETE ON wallet_ledger
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_recharge_credit_equation();

CREATE CONSTRAINT TRIGGER trg_usage_charge_debit_equation
  AFTER INSERT OR UPDATE OR DELETE ON usage_charges
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_usage_debit_equation();

CREATE CONSTRAINT TRIGGER trg_wallet_ledger_usage_equation
  AFTER INSERT OR UPDATE OR DELETE ON wallet_ledger
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_usage_debit_equation();

CREATE CONSTRAINT TRIGGER trg_billing_free_allowance_equation
  AFTER INSERT OR UPDATE OR DELETE ON billing_free_allowances
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_free_allowance_equation();

CREATE CONSTRAINT TRIGGER trg_usage_charge_free_equation
  AFTER INSERT OR UPDATE OR DELETE ON usage_charges
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_free_allowance_equation();

-- 新表创建后再次显式清空默认和既有应用权限，再按进程职责开放最小集合。
REVOKE ALL PRIVILEGES ON
  billing_accounts,
  billing_free_allowances,
  usage_charges,
  recharge_orders,
  payment_attempts,
  payment_callback_events,
  wallet_ledger
FROM PUBLIC, combo_api, combo_worker, combo_runtime;
REVOKE ALL PRIVILEGES ON FUNCTION reject_wallet_ledger_mutation()
  FROM PUBLIC, combo_api, combo_worker, combo_runtime;
REVOKE ALL PRIVILEGES ON FUNCTION enforce_wallet_ledger_writer()
  FROM PUBLIC, combo_api, combo_worker, combo_runtime;
REVOKE ALL PRIVILEGES ON FUNCTION enforce_wallet_account_ledger_equation()
  FROM PUBLIC, combo_api, combo_worker, combo_runtime;
REVOKE ALL PRIVILEGES ON FUNCTION enforce_recharge_credit_equation()
  FROM PUBLIC, combo_api, combo_worker, combo_runtime;
REVOKE ALL PRIVILEGES ON FUNCTION enforce_usage_debit_equation()
  FROM PUBLIC, combo_api, combo_worker, combo_runtime;
REVOKE ALL PRIVILEGES ON FUNCTION enforce_free_allowance_equation()
  FROM PUBLIC, combo_api, combo_worker, combo_runtime;

-- Authoring API 接收充值请求、回调与主动查单；它只能读取使用扣费，不能改免费额度。
GRANT SELECT, INSERT ON billing_accounts TO combo_api;
GRANT UPDATE (balance_cents, updated_at) ON billing_accounts TO combo_api;
GRANT SELECT ON billing_free_allowances, usage_charges TO combo_api;
GRANT SELECT, INSERT ON recharge_orders TO combo_api;
GRANT UPDATE (
  payment_status,
  credit_status,
  platform_trade_no,
  query_attempt_count,
  next_query_at,
  query_lease_owner,
  query_lease_expires_at,
  last_queried_at,
  paid_at,
  credited_at,
  updated_at
) ON recharge_orders TO combo_api;
GRANT SELECT, INSERT ON payment_attempts TO combo_api;
GRANT UPDATE (
  status,
  gateway_result_code,
  platform_trade_no,
  action_kind,
  action_value,
  action_expires_at,
  completed_at,
  updated_at
) ON payment_attempts TO combo_api;
GRANT SELECT, INSERT ON payment_callback_events TO combo_api;
GRANT UPDATE (
  recharge_order_id,
  signature_valid,
  platform_trade_no,
  amount_cents,
  trade_status,
  processing_status,
  rejection_code,
  processed_at
) ON payment_callback_events TO combo_api;
GRANT SELECT, INSERT ON wallet_ledger TO combo_api;

-- Runtime 只负责使用预留和 Turn 终态结算，看不到支付订单、网关动作或回调。
GRANT SELECT, INSERT ON billing_accounts TO combo_runtime;
GRANT UPDATE (balance_cents, reserved_cents, updated_at)
  ON billing_accounts TO combo_runtime;
GRANT SELECT, INSERT ON billing_free_allowances TO combo_runtime;
GRANT UPDATE (free_used_count, free_reserved_count, updated_at)
  ON billing_free_allowances TO combo_runtime;
GRANT SELECT, INSERT ON usage_charges TO combo_runtime;
GRANT UPDATE (status, settled_cents, updated_at, finished_at)
  ON usage_charges TO combo_runtime;
GRANT SELECT, INSERT ON wallet_ledger TO combo_runtime;

-- combo_worker 不参与支付或消费计费，保留上方 REVOKE 后的零权限。
