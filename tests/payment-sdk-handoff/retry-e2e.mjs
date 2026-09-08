// Run only against the dedicated local fixture database, with a verified installed SDK artifact.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import process from 'node:process';
import console from 'node:console';

const { fetch, Request } = globalThis;

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const database = new URL(process.env.DATABASE_URL || 'invalid:');
assert.equal(process.env.PAYMENT_RETRY_E2E, '1');
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.port, '35418');
assert.equal(database.pathname, '/combo_retry_test');
assert.equal(process.env.NODE_ENV, 'test');
const sdkRoot = process.env.PAYMENT_SDK_DIR;
const sdkHash = createHash('sha256')
  .update(readFileSync(process.env.PAYMENT_SDK_TGZ))
  .digest('hex');
assert.equal(sdkHash, process.env.PAYMENT_SDK_SHA256);
const sdk = await import(pathToFileURL(resolve(sdkRoot, 'dist/index.js')));
const moduleAt = (path) => import(pathToFileURL(resolve(root, path)));
const { Pool } = createRequire(resolve(root, 'apps/billing/package.json'))('pg');
const { buildApp: buildAuthz } = await moduleAt('apps/authz/dist/app.js');
const { createPgAuthzStore } = await moduleAt('apps/authz/dist/repo.js');
const { createAssertionSigner } = await moduleAt('apps/authz/dist/assertion.js');
const { createAgentAccessIssuer } = await moduleAt('apps/authz/dist/agent-access.js');
const { buildApp: buildBilling } = await moduleAt('apps/billing/dist/app.js');
const { createPgBillingStore } = await moduleAt('apps/billing/dist/repo.js');
const { createPgPaymentStore } = await moduleAt('apps/billing/dist/payment-repo.js');
const { createPaymentTokenCodec } = await moduleAt('apps/billing/dist/payment-service.js');
const { createPaymentUserAuthenticator } = await moduleAt('apps/billing/dist/payment-auth.js');
const { buildApp: buildGateway } = await moduleAt('apps/llm-gateway/dist/app.js');
const { createGatewayIdentityVerifier } = await moduleAt('apps/llm-gateway/dist/identity.js');
const { createFetchBillingClient } = await moduleAt('apps/llm-gateway/dist/billing.js');
const { createPaymentAdmissionClient } = await moduleAt(
  'apps/llm-gateway/dist/payment-admission.js',
);
const secret = () => randomBytes(32).toString('base64url');
function poolFor(role, password) {
  const url = new URL(database);
  url.username = role;
  url.password = password;
  return new Pool({ connectionString: url.toString() });
}
const adminPool = new Pool({ connectionString: database.toString() });
const authzPool = poolFor('combo_authz', process.env.POSTGRES_AUTHZ_PASSWORD);
const billingPool = poolFor('combo_billing', process.env.POSTGRES_BILLING_PASSWORD);
const servers = [];
const listen = async (server) => {
  servers.push(server);
  return server.listen({ port: 0, host: '127.0.0.1' });
};
const agentId = 'retry-e2e-agent';
const agentSecret = secret();
const credentialId = 'retry-e2e-credential';
const privateKey = generateKeyPairSync('ed25519')
  .privateKey.export({ type: 'pkcs8', format: 'der' })
  .toString('base64');
const signing = { privateKey, kid: 'retry-e2e-key', issuer: 'retry-e2e' };
const cache = new Map();
const sessionCache = {
  async get(key) {
    return cache.get(key.toString('hex')) ?? null;
  },
  async set(value, key) {
    cache.set(key.toString('hex'), value);
  },
  async del(key) {
    cache.delete(key.toString('hex'));
  },
};
let dispatches = 0;
let providerMode = 'invalid';
try {
  const authzUrl = await listen(
    await buildAuthz({
      store: createPgAuthzStore(authzPool),
      cache: sessionCache,
      signer: createAssertionSigner(signing),
      hmacSecret: secret(),
      devOtpCode: '123456',
      sessionCookieSecure: false,
      otpRateLimiter: {
        async consume() {
          return { allowed: true, retryAfterSeconds: 0 };
        },
      },
      agentAccess: {
        issuer: createAgentAccessIssuer({
          ...signing,
          credentials: [
            {
              credentialId,
              agentId,
              secretSha256: createHash('sha256').update(agentSecret).digest('hex'),
            },
          ],
        }),
        allowRequest: async () => true,
      },
    }),
  );
  const billing = createPgBillingStore(billingPool);
  const payments = createPgPaymentStore(billingPool, {
    tokens: createPaymentTokenCodec(secret()),
    checkoutBaseUrl: 'https://checkout.retry.test',
  });
  const internalToken = secret();
  const adminToken = secret();
  const admissionToken = secret();
  const hostOrigin = 'https://host.retry.test';
  const authenticateUser = createPaymentUserAuthenticator({
    authzBaseUrl: authzUrl,
    jwksUrl: authzUrl + '/.well-known/jwks.json',
    issuer: signing.issuer,
    trustedOrigins: [hostOrigin],
    allowHttpForTest: true,
  });
  const billingUrl = await listen(
    await buildBilling({
      store: billing,
      internalToken,
      adminToken,
      overdraftHardLimitCents: 500,
      payments: {
        store: payments,
        authenticateUser,
        authenticateGateway: async (req) =>
          req.headers.authorization === `Bearer ${admissionToken}`,
      },
    }),
  );
  const gatewayUrl = await listen(
    await buildGateway({
      billing: createFetchBillingClient({
        baseUrl: billingUrl,
        token: internalToken,
        timeoutMs: 3000,
      }),
      paymentAdmission: createPaymentAdmissionClient({
        baseUrl: billingUrl,
        token: admissionToken,
        timeoutMs: 3000,
      }),
      identityVerifier: createGatewayIdentityVerifier({
        issuer: signing.issuer,
        jwksUrl: authzUrl + '/.well-known/jwks.json',
        allowHttpForTest: true,
      }),
      pricing: { default: { input: 20, output: 80 } },
      holdFixedCostCents: 1,
      defaultMaxTokens: 4096,
      provider: {
        async chatCompletion() {
          dispatches++;
          if (providerMode === 'network') throw new Error('simulated transport uncertainty');
          return providerMode === 'invalid'
            ? {
                status: 200,
                json: { choices: [{ message: { role: 'assistant', content: null } }] },
              }
            : {
                status: 200,
                json: {
                  choices: [
                    { message: { role: 'assistant', content: 'Recovered original operation.' } },
                  ],
                  usage: { prompt_tokens: 3, completion_tokens: 4 },
                },
              };
        },
        async chatCompletionStream() {
          throw new Error('not used');
        },
      },
    }),
  );
  Object.assign(process.env, {
    COMBO_AGENT_ID: agentId,
    COMBO_AGENT_CREDENTIAL_ID: credentialId,
    COMBO_AGENT_CREDENTIAL_SECRET: agentSecret,
    COMBO_AUTHZ_URL: authzUrl,
    COMBO_JWKS_URL: authzUrl + '/.well-known/jwks.json',
    COMBO_LLM_GATEWAY_URL: gatewayUrl,
    COMBO_ASSERTION_ISSUER: signing.issuer,
    COMBO_ALLOW_HTTP_FOR_TEST: 'true',
    COMBO_LLM_MODEL: 'retry-model',
  });
  // The caller copies these unmodified business example files out of the verified SDK package.
  const handler = await import(
    pathToFileURL(resolve(process.env.PAYMENT_REFERENCE_LIB, 'operation-handler.ts'))
  );
  const { operationStore } = await import(
    pathToFileURL(resolve(process.env.PAYMENT_REFERENCE_LIB, 'operation-store.ts'))
  );
  async function login() {
    const email = `retry-${randomUUID()}@example.test`;
    const challenge = await fetch(authzUrl + '/authz/otp/challenges', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    assert.equal(challenge.status, 202);
    const response = await fetch(authzUrl + '/authz/otp/verifications', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, code: '123456' }),
    });
    assert.equal(response.status, 200);
    return {
      cookie: response.headers.get('set-cookie').split(';')[0],
      userId: (await response.json()).data.user.id,
    };
  }
  async function businessRequest(user, body) {
    const asserted = await fetch(authzUrl + '/authz/assert?agent_id=' + agentId, {
      headers: { cookie: user.cookie },
    });
    assert.equal(asserted.status, 200);
    return new Request('https://agent.retry.test/api/chat', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-combo-assertion': asserted.headers.get('x-combo-assertion'),
      },
      body: JSON.stringify(body),
    });
  }
  const user = await login();
  const body = {
    operationId: 'operation-' + randomUUID(),
    messages: [{ role: 'user', content: 'An isolated retry test.' }],
  };
  const first = await handler.handleNewOperation(await businessRequest(user, body));
  assert.equal(first.status, 402);
  assert.equal(dispatches, 0);
  const message = sdk.parsePaymentHostMessage(await first.json());
  const original = await operationStore.get(user.userId, body.operationId);
  let createRequests = 0;
  const paymentClient = sdk.createPaymentClient({
    paymentUrl: billingUrl,
    auth: { kind: 'browser-session' },
    fetchImpl: async (url, init) => {
      const response = await fetch(url, {
        ...init,
        headers: { ...init.headers, cookie: user.cookie, origin: hostOrigin },
      });
      if (init.method === 'POST') {
        createRequests++;
        await response.body?.cancel();
        throw new Error('simulated lost create acknowledgement');
      }
      return response;
    },
  });
  const key = 'host-' + body.operationId;
  const lost = await paymentClient
    .create({ paymentToken: message.paymentToken, requestKey: key })
    .catch((e) => e);
  assert.ok(lost instanceof sdk.PaymentResultUnknownError);
  assert.equal(createRequests, 1);
  const payment = await paymentClient.findByRequestKey(key);
  assert.equal(payment.status, 'waiting');
  const confirmation = {
    paymentRequestId: payment.paymentRequestId,
    amountCents: Number(payment.amount.amountCents),
    channelTransactionId: randomUUID(),
  };
  await payments.confirmPayment(confirmation);
  await payments.confirmPayment(confirmation);
  await paymentClient.waitForCompletion(payment.paymentRequestId, {
    timeoutMs: 3000,
    pollIntervalMs: 10,
  });
  const failed = await handler.handleResumeOperation(
    await businessRequest(user, body),
    body.operationId,
  );
  assert.equal(failed.status, 503);
  assert.equal((await failed.json()).error, 'model_failed_without_charge');
  assert.equal((await operationStore.get(user.userId, body.operationId)).status, 'ready');
  assert.equal(
    (await billing.readWallet(user.userId)).principalBalance,
    Number(payment.amount.amountCents),
  );
  providerMode = 'success';
  const responses = await Promise.all([
    handler.handleResumeOperation(await businessRequest(user, body), body.operationId),
    handler.handleResumeOperation(await businessRequest(user, body), body.operationId),
  ]);
  assert.equal(responses[0].status, 200);
  assert.equal(responses[1].status, 200);
  assert.deepEqual(await responses[0].json(), await responses[1].json());
  assert.equal(dispatches, 2);
  const completed = await operationStore.get(user.userId, body.operationId);
  assert.equal(completed.callId, original.callId);
  assert.equal(completed.status, 'completed');
  const attempts = await adminPool.query(
    `SELECT a.state FROM v2_call_attempts a JOIN v2_billable_calls c ON c.id=a.call_ref WHERE c.user_id=$1 ORDER BY attempt_no`,
    [user.userId],
  );
  assert.deepEqual(
    attempts.rows.map((r) => r.state),
    ['failed_no_charge', 'succeeded'],
  );
  const ledger = await adminPool.query(
    'SELECT kind,count(*)::int AS count FROM v2_ledger WHERE user_id=$1 GROUP BY kind',
    [user.userId],
  );
  assert.equal(ledger.rows.find((r) => r.kind === 'recharge').count, 1);
  assert.equal(ledger.rows.find((r) => r.kind === 'consume').count, 1);
  const other = await login();
  assert.equal(
    (await handler.handleResumeOperation(await businessRequest(other, body), body.operationId))
      .status,
    404,
  );
  const foreign = await fetch(billingUrl + '/v1/payments/' + payment.paymentRequestId, {
    headers: { cookie: other.cookie },
  });
  assert.equal(foreign.status, 404);
  await billing.adminRecharge({ userId: other.userId, amount: 2, idempotencyKey: randomUUID() });
  providerMode = 'network';
  const unknownBody = { ...body, operationId: 'unknown-' + randomUUID() };
  assert.equal(
    (await handler.handleNewOperation(await businessRequest(other, unknownBody))).status,
    502,
  );
  const before = dispatches;
  assert.equal(
    (
      await handler.handleResumeOperation(
        await businessRequest(other, unknownBody),
        unknownBody.operationId,
      )
    ).status,
    409,
  );
  assert.equal(dispatches, before);
  console.log(
    JSON.stringify({
      result: 'PASS',
      sdkVersion: JSON.parse(readFileSync(resolve(sdkRoot, 'package.json'), 'utf8')).version,
      sdkSha256: sdkHash,
      scope: 'isolated_http_postgresql_reference_agent',
      mockComponents: [
        'OTP delivery',
        'payment channel confirmation',
        'model response and fault injection',
        'business example memory storage',
      ],
      checks: [
        'signed Agent and user identity',
        '402 before dispatch',
        'lost create original-key recovery',
        'single payment credit',
        'paid call invalid response',
        'same operation and call retry',
        'concurrent resume saved result',
        'one successful debit',
        'cross-user denial',
        'unknown outcome does not redispatch',
      ],
      realPayments: 0,
    }),
  );
} finally {
  for (const server of servers.reverse()) await server.close();
  await Promise.all([adminPool.end(), authzPool.end(), billingPool.end()]);
}
