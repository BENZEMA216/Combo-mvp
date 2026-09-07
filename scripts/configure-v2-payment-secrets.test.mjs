import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { configureV2Payments } from './configure-v2-payment-secrets.mjs';

function fixture() {
  const values = {
    'combo-test/combo-env': {
      LESHOUYING_ENABLED: 'true',
      LESHOUYING_ENVIRONMENT: 'TEST',
      LESHOUYING_PRODUCTION_ENABLED: 'false',
      LESHOUYING_INSTITUTION_NO: 'test-institution',
      LESHOUYING_MERCHANT_NO: 'test-merchant',
      LESHOUYING_INSTITUTION_KEY: 'fixture-channel-key-only',
    },
    'combo-v2/combo-env': {
      BILLING_ADMIN_TOKEN: 'fixture-admin-key-only',
      BILLING_INTERNAL_TOKEN: 'fixture-old-shared-key',
      POSTGRES_PASSWORD: 'must-be-preserved',
    },
    'combo-v2/restart-life-credentials': {},
  };
  const writes = [];
  const io = {
    stopped: () => true,
    read: (ns, name) => structuredClone(values[`${ns}/${name}`]),
    write: (ns, name, data) => {
      writes.push(`${ns}/${name}`);
      Object.assign(values[`${ns}/${name}`], data);
    },
  };
  return { values, writes, io };
}

test('generates independent credentials, preserves other keys and reuses exact Agent identity', async () => {
  const { io, values, writes } = fixture();
  const originalSource = structuredClone(values['combo-test/combo-env']);
  const result = await configureV2Payments(io);
  const first = structuredClone(values['combo-v2/combo-env']);
  const agent = values['combo-v2/restart-life-credentials'];
  assert.equal(first.POSTGRES_PASSWORD, 'must-be-preserved');
  assert.notEqual(first.BILLING_INTERNAL_TOKEN, 'fixture-old-shared-key');
  assert.equal(
    JSON.parse(first.AUTHZ_AGENT_CREDENTIALS_JSON)[0].secretSha256,
    createHash('sha256').update(agent.COMBO_AGENT_CREDENTIAL_SECRET).digest('hex'),
  );
  assert.equal(
    first.AUTHZ_AGENT_CREDENTIALS_JSON.includes(agent.COMBO_AGENT_CREDENTIAL_SECRET),
    false,
  );
  assert.deepEqual(result, {
    namespace: 'combo-v2',
    configured: true,
    channel: 'TEST',
    reusedAgent: false,
  });
  await configureV2Payments(io);
  assert.deepEqual(values['combo-v2/combo-env'], first);
  assert.deepEqual(values['combo-test/combo-env'], originalSource);
  assert.deepEqual(writes, [
    'combo-v2/restart-life-credentials',
    'combo-v2/combo-env',
    'combo-v2/combo-env',
  ]);
});

test('fails before writes for live writers, unsafe channel and mismatched credential registry', async () => {
  for (const change of [
    (f) => {
      f.io.stopped = () => false;
    },
    (f) => {
      f.values['combo-test/combo-env'].LESHOUYING_ENVIRONMENT = 'PRODUCTION';
    },
    (f) => {
      f.values['combo-test/combo-env'].LESHOUYING_PRODUCTION_ENABLED = 'true';
    },
    (f) => {
      delete f.values['combo-test/combo-env'].LESHOUYING_PRODUCTION_ENABLED;
    },
    (f) => {
      f.values['combo-v2/combo-env'].PAYMENT_IDENTITY_VERSION = 'unexpected';
    },
    (f) => {
      f.values['combo-v2/combo-env'].AUTHZ_AGENT_CREDENTIALS_JSON = '{';
    },
  ]) {
    const f = fixture();
    change(f);
    await assert.rejects(configureV2Payments(f.io));
    assert.equal(f.writes.length, 0);
  }
  const f = fixture();
  await configureV2Payments(f.io);
  f.writes.length = 0;
  f.values['combo-v2/restart-life-credentials'].COMBO_AGENT_CREDENTIAL_SECRET =
    'changed-secret-'.repeat(3);
  await assert.rejects(configureV2Payments(f.io));
  assert.equal(f.writes.length, 0);
});
