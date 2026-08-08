-- 0011 · 充值通道只保留扫码（qr）。
--
-- 应用层已移除 H5「手机收银台」渠道，创建订单的 schema 只接受 qr。
-- 历史 h5 订单迁到 qr 后收紧 CHECK 约束为只允许 qr，防止旧镜像或外部调用
-- 再写入 h5。pay_type 列不受影响，历史订单仍能提示正确的扫码应用。
-- 注意：本迁移上线后旧镜像不能再回滚（旧镜像仍写 h5 会被新约束拒绝）。
UPDATE recharge_orders
   SET payment_method = 'qr'
 WHERE payment_method <> 'qr';

-- UPDATE 使 0009 定义的延迟约束触发器挂起；必须先立即触发，
-- 同一事务内才能继续 ALTER TABLE（PostgreSQL 限制）。
SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE recharge_orders
  DROP CONSTRAINT ck_recharge_payment_method;

ALTER TABLE recharge_orders
  ADD CONSTRAINT ck_recharge_payment_method CHECK (
    payment_method IN ('qr')
  );
