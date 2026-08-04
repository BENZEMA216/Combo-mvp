-- 0010 · 乐收赢扫码通道改为 C2B 预支付（/v3/prepay）。
--
-- 聚合码通道 aggregate_qr 重命名为 qr；应用层现在要求 qr 通道必须携带
-- pay_type（300=支付宝，400=微信）。历史聚合码订单的值一并迁移。
-- 必须先删除旧 CHECK 再更新，否则新值会违反 IN ('h5','aggregate_qr') 约束。
-- 新增 pay_type 列持久化充值支付品牌，供恢复订单时展示正确的扫码应用。
-- 注意：本迁移上线后旧镜像不能再回滚（旧镜像仍写 aggregate_qr 会被新约束拒绝）。
ALTER TABLE recharge_orders
  DROP CONSTRAINT ck_recharge_payment_method;

UPDATE recharge_orders
   SET payment_method = 'qr'
 WHERE payment_method = 'aggregate_qr';

ALTER TABLE recharge_orders
  ADD CONSTRAINT ck_recharge_payment_method CHECK (
    payment_method IN ('h5', 'qr')
  );

ALTER TABLE recharge_orders
  ADD COLUMN pay_type text;

ALTER TABLE recharge_orders
  ADD CONSTRAINT ck_recharge_pay_type CHECK (
    pay_type IS NULL OR pay_type IN ('wechat', 'alipay')
  );
