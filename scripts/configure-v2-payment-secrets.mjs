#!/usr/bin/env node
// 仅在 tecent2 内存中配置获授权的 V2 TEST 凭据；不打印或落盘 Secret。
import { execFileSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const namespace = 'combo-v2';
const version = 'payment-v1';
const digest = (value) => createHash('sha256').update(value).digest('hex');
const fresh = () => randomBytes(32).toString('base64url');
const required = (values, key) => {
  const value = values[key];
  if (typeof value !== 'string' || !value) throw new Error(`missing required key: ${key}`);
  return value;
};

export async function configureV2Payments(io) {
  if (!(await io.stopped())) throw new Error('V2 deployments and writer Pods must be stopped');
  const source = await io.read('combo-test', 'combo-env');
  if (
    source.LESHOUYING_ENVIRONMENT !== 'TEST' ||
    source.LESHOUYING_ENABLED !== 'true' ||
    source.LESHOUYING_PRODUCTION_ENABLED !== 'false'
  ) {
    throw new Error('source must enable TEST and explicitly disable production payments');
  }
  const channel = Object.fromEntries(
    ['INSTITUTION_NO', 'MERCHANT_NO', 'INSTITUTION_KEY'].map((suffix) => [
      `BILLING_LESHOUYING_${suffix}`,
      required(source, `LESHOUYING_${suffix}`),
    ]),
  );
  if (
    !/^[\x21-\x7e]{1,32}$/.test(channel.BILLING_LESHOUYING_INSTITUTION_NO) ||
    !/^[\x21-\x7e]{1,64}$/.test(channel.BILLING_LESHOUYING_MERCHANT_NO) ||
    channel.BILLING_LESHOUYING_INSTITUTION_KEY.length < 16
  ) {
    throw new Error('invalid TEST channel configuration');
  }
  const platform = await io.read(namespace, 'combo-env');
  const admin = required(platform, 'BILLING_ADMIN_TOKEN');
  const oldInternal = required(platform, 'BILLING_INTERNAL_TOKEN');
  if (platform.PAYMENT_IDENTITY_VERSION && platform.PAYMENT_IDENTITY_VERSION !== version)
    throw new Error('unexpected V2 identity version');
  const existingAgent = await io.read(namespace, 'restart-life-credentials', true);
  let agent = existingAgent;
  if (!Object.keys(agent).length) {
    if (platform.PAYMENT_IDENTITY_VERSION)
      throw new Error('configured Agent credential is missing');
    agent = {
      COMBO_AGENT_CREDENTIAL_ID: `restart-life-${randomBytes(8).toString('hex')}`,
      COMBO_AGENT_CREDENTIAL_SECRET: fresh(),
    };
  }
  if (
    Object.keys(agent).sort().join(',') !==
      'COMBO_AGENT_CREDENTIAL_ID,COMBO_AGENT_CREDENTIAL_SECRET' ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(agent.COMBO_AGENT_CREDENTIAL_ID) ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(agent.COMBO_AGENT_CREDENTIAL_SECRET)
  )
    throw new Error('invalid existing Agent credential');
  let records;
  try {
    records = JSON.parse(platform.AUTHZ_AGENT_CREDENTIALS_JSON || '[]');
    if (
      !Array.isArray(records) ||
      records.some(
        (r) =>
          !r ||
          typeof r.agentId !== 'string' ||
          typeof r.credentialId !== 'string' ||
          !/^[0-9a-f]{64}$/.test(r.secretSha256),
      )
    )
      throw new Error();
  } catch {
    throw new Error('invalid Authz credential registry');
  }
  const record = {
    credentialId: agent.COMBO_AGENT_CREDENTIAL_ID,
    agentId: 'restart-life',
    secretSha256: digest(agent.COMBO_AGENT_CREDENTIAL_SECRET),
  };
  const existingRecord = records.find(
    (r) => r.agentId === 'restart-life' || r.credentialId === record.credentialId,
  );
  if (existingRecord && JSON.stringify(existingRecord) !== JSON.stringify(record))
    throw new Error('Agent and Authz credentials do not match');
  if (!existingRecord) records.push(record);
  const initialized = platform.PAYMENT_IDENTITY_VERSION === version;
  const keys = initialized
    ? {
        BILLING_INTERNAL_TOKEN: oldInternal,
        BILLING_PAYMENT_GATEWAY_TOKEN: required(platform, 'BILLING_PAYMENT_GATEWAY_TOKEN'),
        BILLING_PAYMENT_TOKEN_KEY: required(platform, 'BILLING_PAYMENT_TOKEN_KEY'),
      }
    : {
        BILLING_INTERNAL_TOKEN: fresh(),
        BILLING_PAYMENT_GATEWAY_TOKEN: fresh(),
        BILLING_PAYMENT_TOKEN_KEY: fresh(),
      };
  if (
    Object.values(keys).some((value) => value.length < 32) ||
    new Set([
      ...Object.values(keys),
      admin,
      channel.BILLING_LESHOUYING_INSTITUTION_KEY,
      agent.COMBO_AGENT_CREDENTIAL_SECRET,
    ]).size !== 6 ||
    (!initialized && keys.BILLING_INTERNAL_TOKEN === oldInternal)
  )
    throw new Error('credentials must be independent');
  if (!Object.keys(existingAgent).length)
    await io.write(namespace, 'restart-life-credentials', agent, true);
  await io.write(
    namespace,
    'combo-env',
    {
      ...channel,
      ...keys,
      AUTHZ_AGENT_CREDENTIALS_JSON: JSON.stringify(records),
      PAYMENT_IDENTITY_VERSION: version,
    },
    false,
  );
  return {
    namespace,
    configured: true,
    channel: 'TEST',
    reusedAgent: Boolean(Object.keys(existingAgent).length),
  };
}

function kubectl(args, input) {
  try {
    return execFileSync(
      '/usr/local/bin/kubectl',
      ['--kubeconfig=/home/xingzheng/.kube/config', '--request-timeout=30s', ...args],
      {
        encoding: 'utf8',
        input,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 35000,
        maxBuffer: 1024 * 1024,
      },
    );
  } catch {
    throw new Error('Kubernetes request failed; no credential details are logged');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (
    process.platform !== 'linux' ||
    process.argv.slice(2).join(' ') !== '--apply-v2-test --reuse-test-channel'
  ) {
    console.error(
      'usage on tecent2 only: configure-v2-payment-secrets.mjs --apply-v2-test --reuse-test-channel',
    );
    process.exitCode = 1;
  } else {
    configureV2Payments({
      stopped() {
        const deployments = JSON.parse(
          kubectl([
            '-n',
            namespace,
            'get',
            'deployments',
            'authz',
            'billing',
            'llm-gateway',
            'restart-life',
            '-o',
            'json',
          ]),
        );
        const pods = JSON.parse(
          kubectl([
            '-n',
            namespace,
            'get',
            'pods',
            '-l',
            'app in (authz,billing,llm-gateway,restart-life)',
            '-o',
            'json',
          ]),
        );
        return (
          deployments.items.length === 4 &&
          deployments.items.every((d) => d.spec.replicas === 0) &&
          pods.items.length === 0
        );
      },
      read(ns, name, optional = false) {
        const raw = kubectl([
          '-n',
          ns,
          'get',
          'secret',
          name,
          '-o',
          'json',
          ...(optional ? ['--ignore-not-found'] : []),
        ]);
        if (!raw.trim() && optional) return {};
        const data = JSON.parse(raw).data || {};
        return Object.fromEntries(
          Object.entries(data).map(([key, value]) => [
            key,
            Buffer.from(value, 'base64').toString('utf8'),
          ]),
        );
      },
      write(ns, name, stringData, create) {
        if (ns !== namespace || !['combo-env', 'restart-life-credentials'].includes(name))
          throw new Error('invalid write target');
        if (create)
          kubectl(
            ['create', '-f', '-'],
            JSON.stringify({
              apiVersion: 'v1',
              kind: 'Secret',
              metadata: { name, namespace: ns },
              type: 'Opaque',
              stringData,
            }),
          );
        else {
          // resourceVersion prevents a concurrent update from being overwritten. The entire
          // document stays in memory; kubectl consumes stdin directly, not a /dev/stdin file.
          const current = JSON.parse(kubectl(['-n', ns, 'get', 'secret', name, '-o', 'json']));
          current.data = {
            ...current.data,
            ...Object.fromEntries(
              Object.entries(stringData).map(([key, value]) => [
                key,
                Buffer.from(value).toString('base64'),
              ]),
            ),
          };
          kubectl(['replace', '-f', '-'], JSON.stringify(current));
        }
      },
    })
      .then((result) => console.log(JSON.stringify(result)))
      .catch(() => {
        console.error(
          'V2 credential setup stopped; inspect key presence and configuration without printing values',
        );
        process.exitCode = 1;
      });
  }
}
