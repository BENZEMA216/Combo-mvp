import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = (letter) => `${letter}`.repeat(64);
const POSTGRES_IMAGE =
  'postgres@sha256:7c688148e5e156d0e86df7ba8ae5a05a2386aaec1e2ad8e6d11bdf10504b1fb7';
const REDIS_IMAGE = 'redis@sha256:bb186d083732f669da90be8b0f975a37812b15e913465bb14d845db72a4e3e08';
const MINIO_IMAGE =
  'minio/minio@sha256:d249d1fb6966de4d8ad26c04754b545205ff15a62e4fd19ebd0f26fa5baacbc0';
const MINIO_MC_IMAGE =
  'minio/mc@sha256:fb8f773eac8ef9d6da0486d5dec2f42f219358bcb8de579d1623d518c9ebd4cc';
const dockerAvailable = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
const imageArgs = [
  '--api-image',
  `ghcr.io/dangdang-tech/combo-api@sha256:${digest('a')}`,
  '--runtime-image',
  `ghcr.io/dangdang-tech/combo-runtime@sha256:${digest('b')}`,
  '--web-image',
  `ghcr.io/dangdang-tech/combo-web@sha256:${digest('c')}`,
];
const RELEASE_SHA = 'd'.repeat(40);
const RELEASE_MANIFEST = {
  schemaVersion: 1,
  sourceSha: RELEASE_SHA,
  releaseId: `release-${RELEASE_SHA}`,
  images: {
    api: imageArgs[1],
    runtime: imageArgs[3],
    web: imageArgs[5],
  },
  migrationHead: '0006_one_running_turn_per_session.sql',
  builtAt: '2026-07-24T08:00:00.000Z',
  webAssetManifest: `sha256:${digest('e')}`,
};

function text(path) {
  return readFileSync(join(repo, path), 'utf8');
}

function writeReleaseFixture(root, releaseManifest = RELEASE_MANIFEST) {
  const manifest = join(root, 'release.json');
  const digestFile = join(root, 'release-manifest-digest.txt');
  const serialized = `${JSON.stringify(releaseManifest, null, 2)}\n`;
  writeFileSync(manifest, serialized);
  writeFileSync(digestFile, `sha256:${sha(serialized)}\n`);
  return [
    '--revision',
    RELEASE_SHA,
    '--release-manifest',
    manifest,
    '--release-manifest-digest-file',
    digestFile,
  ];
}

function render(root = repo) {
  const work = mkdtempSync(join(tmpdir(), 'combo-dev-render-'));
  const output = join(work, 'rendered.yaml');
  const releaseArgs = writeReleaseFixture(work);
  try {
    execFileSync(
      'bash',
      [
        join(root, 'scripts/combo-dev-deploy.sh'),
        '--render-only',
        '--output',
        output,
        ...imageArgs,
        ...releaseArgs,
      ],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return readFileSync(output, 'utf8');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'combo-dev-fixture-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'infra/k8s/overlays'), { recursive: true });
  cpSync(join(repo, 'scripts/combo-dev-deploy.sh'), join(root, 'scripts/combo-dev-deploy.sh'));
  cpSync(join(repo, 'infra/k8s/overlays/combo-dev'), join(root, 'infra/k8s/overlays/combo-dev'), {
    recursive: true,
  });
  return root;
}

function expectRenderFailure(root, marker) {
  const output = join(root, 'out.yaml');
  const releaseArgs = writeReleaseFixture(root);
  const result = spawnSync(
    'bash',
    [
      join(root, 'scripts/combo-dev-deploy.sh'),
      '--render-only',
      '--output',
      output,
      ...imageArgs,
      ...releaseArgs,
    ],
    { cwd: root, encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, marker);
}

function documents(rendered) {
  return rendered.split(/^---\s*$/m).filter((value) => value.trim());
}

function identity(document) {
  return {
    kind: document.match(/^kind:\s*(\S+)/m)?.[1],
    name: document.match(/^metadata:\n(?:^(?: {2}.*)?\n)*?^ {2}name:\s*(\S+)/m)?.[1],
  };
}

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

function regexEscape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const rendered = render();
const renderedDocuments = documents(rendered);

function documentFor(kind, name) {
  const found = renderedDocuments.find((document) => {
    const value = identity(document);
    return value.kind === kind && value.name === name;
  });
  assert.ok(found, `${kind}/${name} must exist`);
  return found;
}

test('stage-only render mounts only the three prebound static claims', () => {
  assert.equal(renderedDocuments.length, 40);
  assert.equal(rendered.includes('hostPath:'), false);
  assert.equal(
    renderedDocuments.some((document) =>
      ['StorageClass', 'PersistentVolume', 'PersistentVolumeClaim'].includes(
        identity(document).kind,
      ),
    ),
    false,
  );
  const claims = {
    postgres: 'data-postgres-0',
    'redis-queue': 'data-redis-queue-0',
    minio: 'data-minio-0',
  };
  for (const [name, claim] of Object.entries(claims)) {
    const document = documentFor('StatefulSet', name);
    assert.match(
      document,
      new RegExp(`^ {6}- name: data\n {8}persistentVolumeClaim:\n {10}claimName: ${claim}$`, 'm'),
    );
    assert.match(
      document,
      /mountPath: \/combo-dev-volume-marker[\s\S]*subPath: \.combo-dev-volume/,
    );
    assert.match(
      document,
      /mountPath: (?:\/data|\/var\/lib\/postgresql\/data)[\s\S]*subPath: data/,
    );
    assert.match(document, new RegExp(`combo-dev-static-volume=${name}:v1`));
    assert.doesNotMatch(document, /volumeClaimTemplates:|persistentVolumeClaimRetentionPolicy:/);
  }

  const root = fixture();
  try {
    const sourcePath = join(root, 'infra/k8s/overlays/combo-dev/foundation/resources.yaml');
    const source = readFileSync(sourcePath, 'utf8');
    writeFileSync(
      sourcePath,
      source.replace('            claimName: data-postgres-0', '            claimName: other'),
    );
    expectRenderFailure(root, /guard:static-pvc-mount/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Test apps share one exact immutable release identity without Secret expansion', () => {
  const metadataName = `combo-release-meta-${RELEASE_SHA.slice(0, 12)}`;
  const metadata = documentFor('ConfigMap', metadataName);
  const expected = {
    COMBO_ENVIRONMENT: 'test',
    COMBO_SOURCE_SHA: RELEASE_SHA,
    COMBO_RELEASE_ID: `release-${RELEASE_SHA}`,
    COMBO_BUILT_AT: RELEASE_MANIFEST.builtAt,
    COMBO_RELEASE_MANIFEST_DIGEST: `sha256:${sha(
      `${JSON.stringify(RELEASE_MANIFEST, null, 2)}\n`,
    )}`,
    COMBO_WEB_ASSET_MANIFEST: RELEASE_MANIFEST.webAssetManifest,
  };
  for (const [key, value] of Object.entries(expected)) {
    assert.match(metadata, new RegExp(`^ {2}${key}: ["']?${regexEscape(value)}["']?$`, 'm'));
  }
  assert.equal((metadata.match(/^ {2}COMBO_[A-Z_]+:/gm) ?? []).length, 6);
  assert.equal((metadata.match(/^immutable: true$/gm) ?? []).length, 1);
  assert.doesNotMatch(metadata, /0{40}|sha256:0{64}/);

  for (const name of ['api', 'runtime', 'web', 'worker']) {
    const workload = documentFor('Deployment', name);
    assert.match(
      workload,
      new RegExp(`^ {8}envFrom:\n {8}- configMapRef:\n {12}name: ${metadataName}$`, 'm'),
    );
    assert.equal((workload.match(/envFrom:/g) ?? []).length, 1);
    assert.doesNotMatch(workload, /^\s*-\s*secretRef:/m);
  }

  const web = documentFor('Deployment', 'web');
  const nginx = text('infra/k8s/overlays/combo-dev/apps/nginx-dev.conf');
  const runtimeConfig = text('infra/web-runtime-config.sh');
  assert.match(web, /readOnlyRootFilesystem: true/);
  assert.match(web, /mountPath: \/var\/run[\s\S]*name: nginx-run/);
  assert.doesNotMatch(
    runtimeConfig,
    />"?\/usr\/share\/nginx\/html\/(?:try\/)?(?:runtime-config|version)\.json/,
  );
  for (const [endpoint, file] of [
    ['/runtime-config.json', 'runtime-config.json'],
    ['/version.json', 'version.json'],
    ['/try/runtime-config.json', 'try-runtime-config.json'],
  ]) {
    assert.match(
      nginx,
      new RegExp(
        `location = ${endpoint.replaceAll('/', '\\/')} \\{[\\s\\S]*?alias \\/var\\/run\\/combo-web\\/${file};`,
      ),
    );
  }
  assert.match(nginx, /alias \/usr\/share\/nginx\/html\/try\//);
  assert.doesNotMatch(nginx, /alias \/usr\/share\/nginx\/try\//);

  const root = fixture();
  try {
    const deploy = join(root, 'scripts/combo-dev-deploy.sh');
    const source = readFileSync(deploy, 'utf8');
    assert.equal((source.match(/^immutable: true$/gm) ?? []).length, 1);
    writeFileSync(deploy, source.replace(/^immutable: true$/m, 'immutable: false'));
    expectRenderFailure(root, /guard:release-metadata-immutable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('root-side release validation rejects a boolean schema version', () => {
  const root = fixture();
  try {
    const output = join(root, 'out.yaml');
    const invalid = clone(RELEASE_MANIFEST);
    invalid.schemaVersion = true;
    const releaseArgs = writeReleaseFixture(root, invalid);
    const result = spawnSync(
      'bash',
      [
        join(root, 'scripts/combo-dev-deploy.sh'),
        '--render-only',
        '--output',
        output,
        ...imageArgs,
        ...releaseArgs,
      ],
      { cwd: root, encoding: 'utf8' },
    );
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /render-only 发布清单校验失败/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Restricted combo-preview workloads reject every hostPath injection', () => {
  const namespace = text('infra/k8s/overlays/combo-dev/platform/namespace.yaml');
  const deploy = text('scripts/combo-dev-deploy.sh');
  const smoke = text('scripts/combo-dev-smoke.sh');
  const jobProbe = deploy.slice(
    deploy.indexOf('server_preflight() {'),
    deploy.indexOf('apply_and_wait_foundation() {'),
  );
  const networkCanary = smoke.slice(
    smoke.indexOf('run_network_canary() {'),
    smoke.indexOf('check_logs_fail_closed() {'),
  );
  assert.match(namespace, /pod-security\.kubernetes\.io\/enforce: restricted/);
  assert.equal(rendered.includes('hostPath:'), false);
  assert.doesNotMatch(jobProbe, /^\s+hostPath:/m);
  assert.doesNotMatch(networkCanary, /^\s+hostPath:/m);

  const root = fixture();
  try {
    const resources = join(root, 'infra/k8s/overlays/combo-dev/apps/resources.yaml');
    const source = readFileSync(resources, 'utf8');
    writeFileSync(
      resources,
      source.replace(
        '      volumes:\n        - configMap:\n            name: combo-dev-nginx',
        '      volumes:\n        - hostPath:\n            path: /tmp\n            type: Directory\n          name: forbidden-host\n        - configMap:\n            name: combo-dev-nginx',
      ),
    );
    expectRenderFailure(root, /guard:(?:forbidden|workload-hostpath)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PostgreSQL migration supports fresh, legacy, repeat, and fail-closed partial starts', () => {
  const postgres = documentFor('StatefulSet', 'postgres');
  const migration = text('infra/k8s/overlays/combo-dev/foundation/postgres-entrypoint.sh');
  assert.match(postgres, /name: PGDATA\n\s+value: \/var\/lib\/postgresql\/data\/pgdata/);
  assert.match(postgres, /\/opt\/combo-dev\/postgres-entrypoint\.sh/);
  assert.match(postgres, /runAsUser: 70/);
  assert.match(postgres, /runAsGroup: 70/);
  assert.match(migration, /\.combo-dev-pgdata-migration/);
  assert.doesNotMatch(migration, /-printf|-print0|read\s+-[^\n]*d/);
  assert.ok(
    migration.indexOf('"$mover" -- "$root/PG_VERSION"') > migration.indexOf('for source in'),
  );
  assert.match(migration, /\[\[ ! -e "\$state" \]\] \|\| block/);

  const work = mkdtempSync(join(tmpdir(), 'combo-dev-postgres-'));
  try {
    const entrypoint = join(work, 'entrypoint');
    const mover = join(work, 'mover');
    const count = join(work, 'move-count');
    writeFileSync(entrypoint, '#!/usr/bin/env bash\nexit 0\n');
    writeFileSync(
      mover,
      `#!/usr/bin/env bash
set -eu
n=0
[[ ! -f "$MOVE_COUNT" ]] || n=$(cat "$MOVE_COUNT")
n=$((n+1))
printf '%s\\n' "$n" >"$MOVE_COUNT"
(( n != 2 )) || exit 9
exec mv "$@"
`,
    );
    chmodSync(entrypoint, 0o755);
    chmodSync(mover, 0o755);
    const script = join(repo, 'infra/k8s/overlays/combo-dev/foundation/postgres-entrypoint.sh');
    const run = (root, selectedMover = '/bin/mv', extra = {}) =>
      spawnSync('bash', [script], {
        env: {
          ...process.env,
          COMBO_DEV_POSTGRES_DATA_ROOT: root,
          PGDATA: join(root, 'pgdata'),
          COMBO_DEV_POSTGRES_ENTRYPOINT: entrypoint,
          COMBO_DEV_POSTGRES_MOVER: selectedMover,
          COMBO_DEV_POSTGRES_TEST_MODE: '1',
          ...extra,
        },
        stdio: 'ignore',
      });

    const freshRoot = join(work, 'fresh');
    mkdirSync(freshRoot);
    assert.equal(run(freshRoot).status, 0);
    assert.equal(run(freshRoot).status, 0);

    const legacyRoot = join(work, 'legacy');
    mkdirSync(join(legacyRoot, 'base'), { recursive: true });
    writeFileSync(join(legacyRoot, 'PG_VERSION'), '16\n');
    writeFileSync(join(legacyRoot, 'base', 'record'), 'one');
    writeFileSync(join(legacyRoot, '.hidden'), 'two');
    assert.equal(run(legacyRoot).status, 0);
    assert.equal(readFileSync(join(legacyRoot, 'pgdata', 'PG_VERSION'), 'utf8'), '16\n');
    assert.equal(readFileSync(join(legacyRoot, 'pgdata', 'base', 'record'), 'utf8'), 'one');
    assert.equal(readFileSync(join(legacyRoot, 'pgdata', '.hidden'), 'utf8'), 'two');
    assert.equal(run(legacyRoot).status, 0);

    const failedRoot = join(work, 'failed');
    mkdirSync(failedRoot);
    writeFileSync(join(failedRoot, 'PG_VERSION'), '16\n');
    writeFileSync(join(failedRoot, 'first'), 'one');
    writeFileSync(join(failedRoot, 'second'), 'two');
    const failed = run(failedRoot, mover, { MOVE_COUNT: count });
    assert.notEqual(failed.status, 0);
    assert.equal(readFileSync(count, 'utf8').trim(), '2');
    assert.equal(readFileSync(join(failedRoot, 'PG_VERSION'), 'utf8'), '16\n');
    assert.equal(
      readFileSync(join(failedRoot, '.combo-dev-pgdata-migration'), 'utf8'),
      'state=in-progress\n',
    );
    assert.equal(run(failedRoot, mover, { MOVE_COUNT: count }).status, 2);
    assert.equal(readFileSync(count, 'utf8').trim(), '2');

    const nonemptyRoot = join(work, 'nonempty-child');
    mkdirSync(join(nonemptyRoot, 'pgdata'), { recursive: true });
    writeFileSync(join(nonemptyRoot, 'PG_VERSION'), '16\n');
    writeFileSync(join(nonemptyRoot, 'pgdata', 'partial'), 'partial');
    assert.equal(run(nonemptyRoot).status, 2);
    assert.equal(readFileSync(join(nonemptyRoot, 'PG_VERSION'), 'utf8'), '16\n');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('static local PV bindings are complete, canonical, and cannot fall back outside the mount', () => {
  const storage = text('infra/k8s/overlays/combo-dev/platform/storage-volumes.yaml');
  const storageClass = text('infra/k8s/overlays/combo-dev/platform/storage-class.yaml');
  const bootstrap = text('scripts/combo-dev-bootstrap.sh');
  const guard = text('scripts/combo-dev-storage-guard.sh');
  const hostReadme = text('infra/host/combo-dev/README.md');

  const validateStorage = (source) => {
    const docs = documents(source);
    const pvs = docs.filter((document) => identity(document).kind === 'PersistentVolume');
    const pvcs = docs.filter((document) => identity(document).kind === 'PersistentVolumeClaim');
    assert.deepEqual(pvs.map((document) => identity(document).name).sort(), [
      'combo-dev-minio',
      'combo-dev-postgres',
      'combo-dev-redis-queue',
    ]);
    assert.deepEqual(pvcs.map((document) => identity(document).name).sort(), [
      'data-minio-0',
      'data-postgres-0',
      'data-redis-queue-0',
    ]);
    const expected = {
      'combo-dev-postgres': ['data-postgres-0', '8Gi', '/home/xingzheng/data/combo-dev/postgres'],
      'combo-dev-redis-queue': [
        'data-redis-queue-0',
        '2Gi',
        '/home/xingzheng/data/combo-dev/redis-queue',
      ],
      'combo-dev-minio': ['data-minio-0', '6Gi', '/home/xingzheng/data/combo-dev/minio'],
    };
    for (const document of pvs) {
      const name = identity(document).name;
      const [claim, size, localPath] = expected[name];
      assert.match(document, new RegExp(`^    storage: ${size}$`, 'm'));
      assert.match(document, /^ {2}persistentVolumeReclaimPolicy: Retain$/m);
      assert.match(document, new RegExp(`^    name: ${claim}$`, 'm'));
      assert.match(document, new RegExp(`^    path: ${localPath.replaceAll('/', '\\/')}$`, 'm'));
      assert.match(
        document,
        /key: kubernetes\.io\/hostname[\s\S]*operator: In[\s\S]*COMBO_DEV_NODE_HOSTNAME/,
      );
      assert.doesNotMatch(document, /hostPath:|DirectoryOrCreate/);
    }
    for (const document of pvcs) {
      const claim = identity(document).name;
      const match = Object.entries(expected).find(([, value]) => value[0] === claim);
      assert.ok(match);
      const [pv, [, size]] = match;
      assert.match(document, new RegExp(`^  volumeName: ${pv}$`, 'm'));
      assert.match(document, new RegExp(`^      storage: ${size}$`, 'm'));
      assert.match(document, /^ {2}storageClassName: combo-dev-bounded$/m);
    }
  };

  validateStorage(storage);
  assert.throws(() =>
    validateStorage(storage.replace('name: combo-dev-minio', 'name: missing-minio')),
  );
  assert.throws(() =>
    validateStorage(
      storage.replace(
        '/home/xingzheng/data/combo-dev/minio',
        '/home/xingzheng/data/combo-dev-fallback/minio',
      ),
    ),
  );
  assert.match(storageClass, /provisioner: kubernetes\.io\/no-provisioner/);
  assert.match(storageClass, /reclaimPolicy: Retain/);
  assert.match(storageClass, /volumeBindingMode: WaitForFirstConsumer/);
  assert.doesNotMatch(storageClass, /combo\.dev\/local-path/);
  assert.equal(storage.match(/COMBO_DEV_NODE_HOSTNAME/g)?.length, 3);
  assert.equal(storage.includes('hostPath:'), false);
  assert.equal(
    existsSync(join(repo, 'infra/k8s/overlays/combo-dev/platform/storage-provisioner.yaml')),
    false,
  );
  assert.equal(
    existsSync(join(repo, 'infra/k8s/overlays/combo-dev/platform/storage-rbac.yaml')),
    false,
  );

  const bootstrapMutations = bootstrap.slice(
    bootstrap.indexOf('bootstrap_mutations() {'),
    bootstrap.lastIndexOf('main() {'),
  );
  assert.ok(
    bootstrapMutations.indexOf('MUTATING=1') <
      bootstrapMutations.indexOf('prepare_static_storage_paths'),
  );
  assert.ok(
    bootstrapMutations.indexOf('prepare_static_storage_paths') <
      bootstrapMutations.indexOf('install_static_storage_bindings_admin'),
  );
  for (const token of [
    '$POSTGRES_STORAGE_PATH 70 70',
    '$REDIS_QUEUE_STORAGE_PATH 999 1000',
    '$MINIO_STORAGE_PATH 1000 1000',
    'chown root:root "$STORAGE_POOL"',
    'findmnt -rn -T "$path" -o TARGET',
    'install -d -o "$uid" -g "$gid" -m 0700 "$path"',
  ]) {
    assert.ok(bootstrap.includes(token));
  }
  assert.match(guard, /findmnt -rn -M "\$STORAGE_POOL" -o TARGET/);
  assert.match(guard, /stat -c '%u:%g:%a' "\$STORAGE_POOL"/);
  assert.match(guard, /"\$source" != "\$parent_source"/);
  assert.match(guard, /"\$target" == "\$STORAGE_POOL"/);
  for (const script of [bootstrap, text('scripts/combo-dev-deploy.sh'), guard]) {
    assert.doesNotMatch(script, /df -P[^\n]*--output/);
  }
  if (process.platform === 'linux') {
    assert.equal(spawnSync('df', ['-B1', '--output=size', '/'], { stdio: 'ignore' }).status, 0);
    assert.equal(spawnSync('df', ['--output=iavail', '/'], { stdio: 'ignore' }).status, 0);
  }

  for (const scriptPath of [
    'scripts/combo-dev-bootstrap.sh',
    'scripts/combo-dev-deploy.sh',
    'scripts/combo-dev-reset.sh',
    'scripts/combo-dev-storage-guard.sh',
  ]) {
    assert.match(text(scriptPath), /validate-mount-dependencies/);
  }
  assert.doesNotMatch(bootstrap, /combo\.dev\/local-path|combo-dev-local-path/);
  const mountWork = mkdtempSync(join(tmpdir(), 'combo-dev-mount-contract-'));
  try {
    const input = join(mountWork, 'mounts');
    const check = (value) => {
      writeFileSync(input, value);
      return spawnSync(
        'python3',
        [
          join(repo, 'scripts/combo-dev-production-safety.py'),
          'validate-mount-dependencies',
          '--input',
          input,
          '--data-mount',
          '/home/xingzheng/data',
          '--storage-pool',
          '/home/xingzheng/data/combo-dev',
        ],
        { stdio: 'ignore' },
      ).status;
    };
    assert.equal(check('/home/xingzheng/data /var/lib/rancher/k3s\n'), 0);
    assert.notEqual(check('/home/xingzheng/data/combo-dev\n'), 0);
    assert.notEqual(check('/home/xingzheng/data/combo-dev/postgres\n'), 0);
    assert.notEqual(check('/home/xingzheng/data/combo-dev/../combo-dev/minio\n'), 0);
    assert.notEqual(check('/var/lib/rancher/k3s\n'), 0);
  } finally {
    rmSync(mountWork, { recursive: true, force: true });
  }
  assert.match(hostReadme, /RequiresMountsFor=\/home\/xingzheng\/data/);
  assert.doesNotMatch(hostReadme, /RequiresMountsFor=\/home\/xingzheng\/data\/combo-dev/);
});

test('bootstrap accepts only the exact disposable legacy preview storage and removes it before static binding', () => {
  const bootstrap = text('scripts/combo-dev-bootstrap.sh');
  const marker = 'python3 - "$pvc" "$pv" "$K3S_DATA_DIR" "$WORK/legacy-storage.json" <<\'PY\' ||';
  const start = bootstrap.indexOf(marker);
  assert.notEqual(start, -1);
  const bodyStart = bootstrap.indexOf('\n', start) + 1;
  const bodyEnd = bootstrap.indexOf('\nPY\n', bodyStart);
  assert.ok(bodyStart > 0 && bodyEnd > bodyStart);
  const classifier = bootstrap.slice(bodyStart, bodyEnd);
  const work = mkdtempSync(join(tmpdir(), 'combo-dev-legacy-storage-'));
  try {
    mkdirSync(join(work, 'k3s', 'storage'), { recursive: true });
    const dataDir = realpathSync(join(work, 'k3s'));
    const storageDir = join(dataDir, 'storage');
    const definitions = [
      ['combo-preview-postgres-data-postgres-0', '11111111-1111-1111-1111-111111111111'],
      ['combo-preview-redis-queue-data-redis-queue-0', '22222222-2222-2222-2222-222222222222'],
      ['combo-preview-minio-data-minio-0', '33333333-3333-3333-3333-333333333333'],
    ];
    const claims = [];
    const volumes = [];
    for (const [name, uid] of definitions) {
      const volume = `pvc-${uid}`;
      const localPath = join(storageDir, `${volume}_combo-preview_${name}`);
      mkdirSync(localPath);
      claims.push({
        metadata: { name, uid },
        spec: {
          accessModes: ['ReadWriteOnce'],
          storageClassName: 'local-path',
          volumeMode: 'Filesystem',
          volumeName: volume,
        },
        status: { phase: 'Bound' },
      });
      volumes.push({
        metadata: { name: volume },
        spec: {
          accessModes: ['ReadWriteOnce'],
          capacity: { storage: '1Gi' },
          claimRef: { name, namespace: 'combo-preview', uid },
          local: { path: localPath },
          persistentVolumeReclaimPolicy: 'Delete',
          storageClassName: 'local-path',
          volumeMode: 'Filesystem',
        },
        status: { phase: 'Bound' },
      });
    }
    const pvc = join(work, 'pvc.json');
    const pv = join(work, 'pv.json');
    const output = join(work, 'contract.json');
    const run = (claimItems, volumeItems) => {
      writeFileSync(pvc, JSON.stringify({ items: claimItems }));
      writeFileSync(pv, JSON.stringify({ items: volumeItems }));
      rmSync(output, { force: true });
      return spawnSync('python3', ['-c', classifier, pvc, pv, dataDir, output], {
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
        stdio: 'ignore',
      }).status;
    };
    assert.equal(run(claims, volumes), 0);
    assert.equal(JSON.parse(readFileSync(output, 'utf8')).claims.length, 3);

    const wrongClaim = clone(claims);
    wrongClaim[0].metadata.name = 'unexpected-preview-data';
    assert.notEqual(run(wrongClaim, volumes), 0);
    const wrongPath = clone(volumes);
    wrongPath[0].spec.local.path = join(work, 'outside');
    assert.notEqual(run(claims, wrongPath), 0);
    const wrongReclaim = clone(volumes);
    wrongReclaim[0].spec.persistentVolumeReclaimPolicy = 'Retain';
    assert.notEqual(run(claims, wrongReclaim), 0);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  assert.match(bootstrap, /bootstrap_boundary legacy-storage-cleanup/);
  assert.match(bootstrap, /wait --for=delete "persistentvolume\/\$volume"/);
  assert.match(bootstrap, /\[\[ ! -e "\$path" && ! -L "\$path" \]\]/);
  const freshHarness = `
source ${JSON.stringify(join(repo, 'scripts/combo-dev-bootstrap.sh'))}
fake_kubectl() { return 0; }
AK=(fake_kubectl)
if namespace_exists_admin; then exit 9; else [[ $? == 1 ]]; fi
fence_all_writers_admin
sanitize_preview_namespace
`;
  assert.equal(spawnSync('bash', ['-c', freshHarness], { stdio: 'ignore' }).status, 0);
});

test('data Pod identities and bootstrap ownership match the pinned image contracts', () => {
  const foundation = text('infra/k8s/overlays/combo-dev/foundation/resources.yaml');
  const bootstrap = text('scripts/combo-dev-bootstrap.sh');
  const postgres = documentFor('StatefulSet', 'postgres');
  const redisQueue = documentFor('StatefulSet', 'redis-queue');
  const redisHot = documentFor('Deployment', 'redis-hot');
  const minio = documentFor('StatefulSet', 'minio');
  assert.match(postgres, /runAsGroup: 70[\s\S]*runAsUser: 70/);
  assert.match(redisQueue, /runAsGroup: 1000[\s\S]*runAsUser: 999/);
  assert.match(redisHot, /runAsGroup: 1000[\s\S]*runAsUser: 999/);
  assert.match(minio, /runAsGroup: 1000[\s\S]*runAsUser: 1000/);
  assert.match(bootstrap, /\$POSTGRES_STORAGE_PATH 70 70/);
  assert.match(bootstrap, /\$REDIS_QUEUE_STORAGE_PATH 999 1000/);
  assert.match(bootstrap, /\$MINIO_STORAGE_PATH 1000 1000/);
  assert.match(foundation, new RegExp(POSTGRES_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(foundation, new RegExp(REDIS_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(foundation, new RegExp(MINIO_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test(
  'exact pinned data images expose the required runtime identities',
  { skip: !dockerAvailable },
  () => {
    const probes = [
      [
        POSTGRES_IMAGE,
        ['--entrypoint', '/bin/sh'],
        'test "$(id -u postgres):$(id -g postgres)" = 70:70 && command -v cat >/dev/null && command -v docker-entrypoint.sh >/dev/null',
      ],
      [
        REDIS_IMAGE,
        ['--entrypoint', '/bin/sh'],
        'test "$(id -u redis):$(id -g redis)" = 999:1000 && command -v cat >/dev/null && command -v redis-server >/dev/null',
      ],
      [
        MINIO_IMAGE,
        ['--user', '1000:1000', '--entrypoint', '/bin/sh'],
        'test "$(id -u):$(id -g)" = 1000:1000 && command -v cat >/dev/null && test -x /usr/bin/docker-entrypoint.sh',
      ],
      [
        MINIO_MC_IMAGE,
        ['--entrypoint', '/bin/sh'],
        'command -v mc >/dev/null && command -v sleep >/dev/null',
      ],
    ];
    for (const [image, options, command] of probes) {
      const result = spawnSync('docker', ['run', '--rm', ...options, image, '-ec', command], {
        stdio: 'ignore',
      });
      assert.equal(result.status, 0, `${image} identity probe failed`);
    }
  },
);

test(
  'MinIO initialization runs with the exact pinned mc image toolset',
  { skip: !dockerAvailable },
  () => {
    const resource = text('infra/k8s/overlays/combo-dev/init/resources.yaml');
    const lines = resource.split('\n');
    const start = lines.indexOf('  init-buckets.sh: |') + 1;
    const end = lines.indexOf('kind: ConfigMap');
    assert.ok(start > 0 && end > start);
    const script = lines
      .slice(start, end)
      .map((line) => (line.length === 0 ? '' : line.slice(4)))
      .join('\n');
    const work = mkdtempSync(join(tmpdir(), 'combo-dev-minio-init-'));
    try {
      const scriptPath = join(work, 'init.sh');
      const fakeMc = join(work, 'mc');
      writeFileSync(scriptPath, `${script}\n`);
      writeFileSync(
        fakeMc,
        `#!/bin/sh
case "$*" in
  "admin user list local --json")
    printf '%s\\n' '{"status":"success","accessKey":"appKey1"}'
    [ -f /tmp/fake-mc-removed ] || printf '%s\\n' '{"status":"success","accessKey":"staleKey1"}'
    ;;
  "admin user remove local staleKey1") : >/tmp/fake-mc-removed ;;
  "admin user info local staleKey1") exit 1 ;;
  "alias set revoked "*) exit 1 ;;
  *) exit 0 ;;
esac
`,
      );
      chmodSync(scriptPath, 0o755);
      chmodSync(fakeMc, 0o755);
      const result = spawnSync(
        'docker',
        [
          'run',
          '--rm',
          '--entrypoint',
          '/bin/sh',
          '-v',
          `${work}:/probe:ro`,
          '-e',
          'MINIO_ROOT_USER=rootuser',
          '-e',
          'MINIO_ROOT_PASSWORD=rootpass',
          '-e',
          'S3_ACCESS_KEY=appKey1',
          '-e',
          'S3_SECRET_KEY=secretKey1',
          '-e',
          'S3_ENDPOINT=http://minio.invalid',
          '-e',
          'MC_CONFIG_DIR=/tmp/mc-test',
          MINIO_MC_IMAGE,
          '-ec',
          'PATH=/probe:/bin /bin/sh /probe/init.sh',
        ],
        { stdio: 'ignore' },
      );
      assert.equal(result.status, 0);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
);

test(
  'fresh static volumes are unwritable before exact ownership and writable afterward',
  { skip: !dockerAvailable },
  () => {
    const token = mkdtempSync(join(tmpdir(), 'combo-dev-volume-token-')).split('/').at(-1);
    const specs = [
      { name: 'postgres', image: POSTGRES_IMAGE, user: '70:70' },
      { name: 'redis', image: REDIS_IMAGE, user: '999:1000' },
      { name: 'minio', image: MINIO_IMAGE, user: '1000:1000' },
    ];
    const volumes = [];
    try {
      for (const spec of specs) {
        const volume = `combo-dev-test-${token}-${spec.name}`.toLowerCase();
        volumes.push(volume);
        execFileSync('docker', ['volume', 'create', volume], { stdio: 'ignore' });
        execFileSync(
          'docker',
          [
            'run',
            '--rm',
            '--entrypoint',
            '/bin/sh',
            '-v',
            `${volume}:/volume`,
            spec.image,
            '-ec',
            'chown 0:0 /volume && chmod 0700 /volume',
          ],
          { stdio: 'ignore' },
        );
        const denied = spawnSync(
          'docker',
          [
            'run',
            '--rm',
            '--user',
            spec.user,
            '--entrypoint',
            '/bin/sh',
            '-v',
            `${volume}:/volume`,
            spec.image,
            '-ec',
            'touch /volume/probe',
          ],
          { stdio: 'ignore' },
        );
        assert.notEqual(
          denied.status,
          0,
          `${spec.name} unexpectedly wrote a root-owned fresh volume`,
        );
        execFileSync(
          'docker',
          [
            'run',
            '--rm',
            '--entrypoint',
            '/bin/sh',
            '-v',
            `${volume}:/volume`,
            spec.image,
            '-ec',
            `chown ${spec.user} /volume && chmod 0700 /volume`,
          ],
          { stdio: 'ignore' },
        );
        execFileSync(
          'docker',
          [
            'run',
            '--rm',
            '--user',
            spec.user,
            '--entrypoint',
            '/bin/sh',
            '-v',
            `${volume}:/volume`,
            spec.image,
            '-ec',
            'touch /volume/probe && rm /volume/probe',
          ],
          { stdio: 'ignore' },
        );
        if (spec.name === 'postgres') {
          execFileSync(
            'docker',
            [
              'run',
              '--rm',
              '--user',
              spec.user,
              '--entrypoint',
              '/bin/sh',
              '-v',
              `${volume}:/volume`,
              spec.image,
              '-ec',
              'mkdir /volume/pgdata && initdb -D /volume/pgdata --auth-local=trust --auth-host=reject >/dev/null',
            ],
            { stdio: 'ignore' },
          );
        }
      }
    } finally {
      for (const volume of volumes) {
        spawnSync('docker', ['volume', 'rm', '-f', volume], { stdio: 'ignore' });
      }
      rmSync(join(tmpdir(), token), { recursive: true, force: true });
    }
  },
);

test(
  'PostgreSQL migration runs with only commands in the exact pinned Alpine image',
  { skip: !dockerAvailable },
  () => {
    const tokenDirectory = mkdtempSync(join(tmpdir(), 'combo-dev-migration-token-'));
    const token = tokenDirectory.split('/').at(-1);
    const volume = `combo-dev-test-${token}-migration`.toLowerCase();
    const script = join(repo, 'infra/k8s/overlays/combo-dev/foundation/postgres-entrypoint.sh');
    const marker = join(tokenDirectory, 'volume-marker');
    writeFileSync(marker, 'wrong-volume-marker\n');
    try {
      execFileSync('docker', ['volume', 'create', volume], { stdio: 'ignore' });
      execFileSync(
        'docker',
        [
          'run',
          '--rm',
          '--entrypoint',
          '/bin/sh',
          '-v',
          `${volume}:/var/lib/postgresql/data`,
          POSTGRES_IMAGE,
          '-ec',
          'mkdir -p /var/lib/postgresql/data/base && printf "16\\n" > /var/lib/postgresql/data/PG_VERSION && printf x > /var/lib/postgresql/data/base/item && chown -R 70:70 /var/lib/postgresql/data && chmod 0700 /var/lib/postgresql/data',
        ],
        { stdio: 'ignore' },
      );
      const args = [
        'run',
        '--rm',
        '--user',
        '70:70',
        '--entrypoint',
        '/bin/bash',
        '-e',
        'COMBO_DEV_POSTGRES_DATA_ROOT=/var/lib/postgresql/data',
        '-e',
        'PGDATA=/var/lib/postgresql/data/pgdata',
        '-e',
        'COMBO_DEV_POSTGRES_ENTRYPOINT=/bin/true',
        '-e',
        'COMBO_DEV_POSTGRES_MOVER=/bin/mv',
        '-e',
        'COMBO_DEV_STORAGE_MARKER=/combo-dev-volume-marker',
        '-e',
        'COMBO_DEV_STORAGE_MARKER_STATE=combo-dev-static-volume=postgres:v1',
        '-v',
        `${volume}:/var/lib/postgresql/data`,
        '-v',
        `${marker}:/combo-dev-volume-marker:ro`,
        '-v',
        `${script}:/opt/combo-dev/postgres-entrypoint.sh:ro`,
        POSTGRES_IMAGE,
        '/opt/combo-dev/postgres-entrypoint.sh',
      ];
      const wrongMarker = spawnSync('docker', args, { stdio: 'ignore' });
      assert.equal(wrongMarker.status, 2);
      writeFileSync(marker, 'combo-dev-static-volume=postgres:v1\n');
      execFileSync('docker', args, { stdio: 'ignore' });
      execFileSync('docker', args, { stdio: 'ignore' });
      execFileSync(
        'docker',
        [
          'run',
          '--rm',
          '--entrypoint',
          '/bin/sh',
          '-v',
          `${volume}:/var/lib/postgresql/data`,
          POSTGRES_IMAGE,
          '-ec',
          'test ! -e /var/lib/postgresql/data/PG_VERSION && test -f /var/lib/postgresql/data/pgdata/PG_VERSION && test -f /var/lib/postgresql/data/pgdata/base/item && test ! -e /var/lib/postgresql/data/.combo-dev-pgdata-migration && for command in bash cat mkdir mv chmod rm sync; do command -v "$command" >/dev/null; done && ! find /tmp -maxdepth 0 -printf x >/dev/null 2>&1',
        ],
        { stdio: 'ignore' },
      );
    } finally {
      spawnSync('docker', ['volume', 'rm', '-f', volume], { stdio: 'ignore' });
      rmSync(tokenDirectory, { recursive: true, force: true });
    }
  },
);

test('render security is tied to exact stage bytes and rejects root decoys, unsafe services, commands, and secret references', () => {
  const deploy = text('scripts/combo-dev-deploy.sh');
  assert.doesNotMatch(deploy, /kubectl kustomize "\$destination\/overlay"/);
  assert.match(deploy, /expected_all='\\n---\\n'\.join/);
  assert.match(
    deploy,
    /sha256sum platform\.yaml foundation\.yaml init\.yaml migrate\.yaml apps\.yaml all\.yaml/,
  );
  assert.match(deploy, /assert_validated_render "\$render"/);
  assert.match(deploy, /seen != allowed_files/);
  assert.doesNotMatch(deploy, /allowed_prefix/);

  for (const [mutation, marker] of [
    [
      (root) => {
        const rootKustomization = join(root, 'infra/k8s/overlays/combo-dev/kustomization.yaml');
        writeFileSync(
          rootKustomization,
          'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - platform\n',
        );
        const apps = join(root, 'infra/k8s/overlays/combo-dev/apps/resources.yaml');
        writeFileSync(
          apps,
          readFileSync(apps, 'utf8').replace('  type: ClusterIP\n', '  type: NodePort\n'),
        );
      },
      /guard:forbidden/,
    ],
    [
      (root) => {
        const foundation = join(root, 'infra/k8s/overlays/combo-dev/foundation/resources.yaml');
        writeFileSync(
          foundation,
          readFileSync(foundation, 'utf8').replace(
            '            - redis-server\n            - /usr/local/etc/redis/redis.conf\n',
            '            - sh\n            - -c\n',
          ),
        );
      },
      /guard:command/,
    ],
    [
      (root) => {
        const migrate = join(root, 'infra/k8s/overlays/combo-dev/migrate/resources.yaml');
        writeFileSync(
          migrate,
          readFileSync(migrate, 'utf8').replace('name: combo-dev-env', 'name: other-config'),
        );
      },
      /guard:secret-reference/,
    ],
  ]) {
    const root = fixture();
    try {
      mutation(root);
      expectRenderFailure(root, marker);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('production fingerprint preserves stable object and Pod identities while ignoring only volatile API metadata', () => {
  const safety = text('scripts/combo-dev-production-safety.py');
  for (const scriptPath of [
    'scripts/combo-dev-bootstrap.sh',
    'scripts/combo-dev-deploy.sh',
    'scripts/combo-dev-reset.sh',
  ]) {
    assert.match(
      text(scriptPath),
      /combo-dev-production-safety(?:\.py)?"? canonicalize-production/,
    );
    assert.doesNotMatch(text(scriptPath), /images:\s*\[/);
  }
  for (const field of ['"uid"', '"podIP"', '"podIPs"', '"startTime"']) {
    assert.ok(safety.includes(field));
  }

  const work = mkdtempSync(join(tmpdir(), 'combo-dev-fingerprint-'));
  try {
    const base = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: 'postgres-0',
        namespace: 'combo',
        uid: 'pod-one',
        labels: { app: 'postgres' },
        ownerReferences: [
          {
            apiVersion: 'apps/v1',
            kind: 'StatefulSet',
            name: 'postgres',
            uid: 'owner-one',
            controller: true,
          },
        ],
        resourceVersion: '1',
        creationTimestamp: '2026-01-01T00:00:00Z',
      },
      spec: {
        nodeName: 'node-one',
        containers: [{ name: 'postgres', image: 'postgres@sha256:x' }],
      },
      status: {
        phase: 'Running',
        podIP: '10.42.0.10',
        podIPs: [{ ip: '10.42.0.10' }],
        startTime: '2026-01-01T00:00:10Z',
        containerStatuses: [
          {
            name: 'postgres',
            ready: true,
            restartCount: 0,
            image: 'postgres@sha256:x',
            imageID: 'postgres@sha256:x',
            state: { running: { startedAt: '2026-01-01T00:00:11Z' } },
          },
        ],
      },
    };
    const canonicalize = (name, object) => {
      const input = join(work, `${name}.input.json`);
      const output = join(work, `${name}.output.json`);
      writeFileSync(input, JSON.stringify({ items: [object] }));
      execFileSync(
        'python3',
        [
          join(repo, 'scripts/combo-dev-production-safety.py'),
          'canonicalize-production',
          '--input',
          input,
          '--output',
          output,
        ],
        { stdio: 'ignore' },
      );
      return readFileSync(output, 'utf8');
    };
    const first = canonicalize('first', base);
    const volatile = clone(base);
    volatile.metadata.resourceVersion = '999';
    volatile.metadata.creationTimestamp = '2026-02-02T00:00:00Z';
    assert.equal(sha(first), sha(canonicalize('volatile', volatile)));

    for (const [name, mutate] of [
      ['pod-uid', (value) => (value.metadata.uid = 'pod-two')],
      ['owner-uid', (value) => (value.metadata.ownerReferences[0].uid = 'owner-two')],
      ['pod-ip', (value) => (value.status.podIP = '10.42.0.11')],
      ['pod-start', (value) => (value.status.startTime = '2026-01-02T00:00:10Z')],
      [
        'container-start',
        (value) =>
          (value.status.containerStatuses[0].state.running.startedAt = '2026-01-02T00:00:11Z'),
      ],
    ]) {
      const replaced = clone(base);
      mutate(replaced);
      assert.notEqual(sha(first), sha(canonicalize(name, replaced)), name);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('production observer gate resolves every binding and exact effective rule instead of sampling one permission', () => {
  const safety = text('scripts/combo-dev-production-safety.py');
  const rbac = text('infra/k8s/overlays/combo-dev/platform/rbac.yaml');
  for (const token of [
    'SelfSubjectRulesReview',
    'rolebindings.rbac.authorization.k8s.io',
    'clusterrolebindings.rbac.authorization.k8s.io',
    'observer RBAC contains a wildcard rule',
    'observer has resource access outside production',
    'observer and auditor do not use the same cluster trust',
    'secrets',
    'deletecollection',
  ]) {
    assert.ok(safety.includes(token));
  }
  assert.match(
    rbac,
    /resources: \['roles', 'rolebindings', 'clusterroles', 'clusterrolebindings'\]/,
  );
  assert.match(rbac, /verbs: \['get', 'list'\]/);
  for (const scriptPath of [
    'scripts/combo-dev-bootstrap.sh',
    'scripts/combo-dev-deploy.sh',
    'scripts/combo-dev-reset.sh',
  ]) {
    assert.match(text(scriptPath), /verify-observer/);
    assert.doesNotMatch(text(scriptPath), /can_observer_exact/);
  }

  const work = mkdtempSync(join(tmpdir(), 'combo-dev-observer-unit-'));
  try {
    const unit = join(work, 'observer-unit.py');
    writeFileSync(
      unit,
      `import importlib.util
spec=importlib.util.spec_from_file_location('safety', ${JSON.stringify(join(repo, 'scripts/combo-dev-production-safety.py'))})
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
def item(kind,name,rules,namespace=None):
    metadata={'name':name}
    if namespace is not None: metadata['namespace']=namespace
    return {'kind':kind,'metadata':metadata,'rules':rules}
production_rules=[
 {'apiGroups':['apps'],'resources':['deployments','statefulsets'],'verbs':['get','list','watch']},
 {'apiGroups':[''],'resources':['services','persistentvolumeclaims','pods'],'verbs':['get','list','watch']},
]
roles={'items':[item('Role','observer',production_rules,'combo')]}
rolebindings={'items':[{'kind':'RoleBinding','metadata':{'name':'observer','namespace':'combo'},'subjects':[{'kind':'User','name':'observer'}],'roleRef':{'kind':'Role','name':'observer'}}]}
clusterroles={'items':[
 item('ClusterRole','basic',[{'apiGroups':['authorization.k8s.io'],'resources':['selfsubjectaccessreviews','selfsubjectrulesreviews'],'verbs':['create']},{'apiGroups':['authentication.k8s.io'],'resources':['selfsubjectreviews'],'verbs':['create']}]),
 item('ClusterRole','discovery',[{'nonResourceURLs':['/api','/apis','/openapi/*','/version'],'verbs':['get']}]),
]}
clusterbindings={'items':[
 {'kind':'ClusterRoleBinding','metadata':{'name':'basic'},'subjects':[{'kind':'Group','name':'system:authenticated'}],'roleRef':{'kind':'ClusterRole','name':'basic'}},
 {'kind':'ClusterRoleBinding','metadata':{'name':'discovery'},'subjects':[{'kind':'Group','name':'system:authenticated'}],'roleRef':{'kind':'ClusterRole','name':'discovery'}},
]}
module.validate_bindings('observer',{'system:authenticated'},'combo',roles,rolebindings,clusterroles,clusterbindings)
over_roles={'items':roles['items']+[item('Role','extra',[{'apiGroups':[''],'resources':['secrets'],'verbs':['get']}],'default')]}
over_bindings={'items':rolebindings['items']+[{'kind':'RoleBinding','metadata':{'name':'extra','namespace':'default'},'subjects':[{'kind':'User','name':'observer'}],'roleRef':{'kind':'Role','name':'extra'}}]}
try:
    module.validate_bindings('observer',{'system:authenticated'},'combo',over_roles,over_bindings,clusterroles,clusterbindings)
except module.SafetyError:
    pass
else:
    raise SystemExit(2)
`,
    );
    const result = spawnSync('python3', [unit], {
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      stdio: 'ignore',
    });
    assert.equal(result.status, 0);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('bootstrap failure injection at every apply and credential boundary leaves forwarders and writers fenced', () => {
  const deploy = text('scripts/combo-dev-deploy.sh');
  const reset = text('scripts/combo-dev-reset.sh');
  const bootstrap = text('scripts/combo-dev-bootstrap.sh');
  const guard = text('scripts/combo-dev-storage-guard.sh');
  for (const script of [deploy, reset, bootstrap, guard]) {
    assert.match(script, /\/var\/lib\/combo-dev\/writers-fenced/);
  }
  for (const script of [deploy, reset, guard]) {
    assert.match(script, /redis-hot/);
    assert.match(
      script,
      /minio-init migrate combo-dev-network-canary|JOBS=\(minio-init migrate combo-dev-network-canary\)/,
    );
  }
  const bootstrapFence = bootstrap.slice(
    bootstrap.indexOf('fence_all_writers_admin() {'),
    bootstrap.indexOf('credential_certificate_valid_for() {'),
  );
  assert.match(bootstrapFence, /get deployments\.apps,statefulsets\.apps -o name/);
  assert.match(bootstrapFence, /scale "\$controller" --replicas=0/);
  assert.match(bootstrapFence, /for resource in jobs\.batch cronjobs\.batch daemonsets\.apps/);
  assert.match(bootstrapFence, /delete pods --all/);
  assert.doesNotMatch(bootstrapFence, /APP_NAMES|FOUNDATION_STATEFUL/);

  const boundaries = [
    'sanitize-preview',
    'legacy-storage-cleanup',
    'namespace-apply',
    'static-storage-paths',
    'static-storage-bindings',
    'storage-class-apply',
    'static-volumes-apply',
    'rbac-apply',
    'fencer-credential',
    'dispatcher-credential',
    'approval-files',
    'platform-apply',
    'development-secrets',
    'env-secret-apply',
    'registry-secret-apply',
    'session-credential-file',
    'session-secret-apply',
    'control-files-install',
  ];
  const actualBoundaries = [...bootstrap.matchAll(/bootstrap_boundary ([a-z][a-z0-9-]+)/g)].map(
    (match) => match[1],
  );
  assert.deepEqual([...new Set(actualBoundaries)].sort(), [...boundaries].sort());
  const mainBody = bootstrap.slice(bootstrap.lastIndexOf('\nmain() {'));
  for (const readOnlyStep of [
    'host_preflight',
    'validate_config_names_only',
    'verify_observer_boundary',
    'before=$(production_fingerprint)',
    'prepare_cluster_platform_contract',
    'classify_preview_storage_admin',
  ]) {
    assert.ok(
      mainBody.indexOf(readOnlyStep) < mainBody.indexOf('bootstrap_mutations'),
      readOnlyStep,
    );
  }

  const work = mkdtempSync(join(tmpdir(), 'combo-dev-bootstrap-failure-'));
  try {
    const harness = `
source ${JSON.stringify(join(repo, 'scripts/combo-dev-bootstrap.sh'))}
status() { :; }
record() { printf '%s\\n' "$1" >>"$TEST_LOG"; }
mark_failure_fence() { record marker; }
stop_forwarders() { record forwarders; }
forwarders_stopped() { return 0; }
fence_all_writers_admin() { record writers; }
bootstrap_boundary() {
  local boundary=$1
  shift
  record "boundary:$boundary"
  [[ "$boundary" != "$FAIL_AT" ]] || return 71
  "$@"
}
fake_kubectl() { return 0; }
AK=(fake_kubectl)
sanitize_preview_namespace() { return 0; }
cleanup_legacy_preview_storage_admin() { return 0; }
prepare_static_storage_paths() { return 0; }
check_static_storage_guard() { return 0; }
install_static_storage_bindings_admin() {
  bootstrap_boundary storage-class-apply true || return
  bootstrap_boundary static-volumes-apply true || return
}
provision_fencer_credential() { return 0; }
provision_dispatcher_credential() { return 0; }
write_bootstrap_approvals() { return 0; }
dispatcher_credential_valid() { return 0; }
fencer_credential_valid() { return 0; }
static_storage_is_valid_admin() { return 0; }
verify_cluster_platform_admin() { return 0; }
provision_secrets() {
  bootstrap_boundary env-secret-apply true || return
  bootstrap_boundary registry-secret-apply true || return
  bootstrap_boundary session-credential-file true || return
  bootstrap_boundary session-secret-apply true || return
}
install_control_files() { return 0; }
WORK=''
bootstrap_mutations
`;
    for (const boundary of boundaries) {
      const log = join(work, `${boundary}.log`);
      const result = spawnSync('bash', ['-c', harness], {
        env: { ...process.env, FAIL_AT: boundary, TEST_LOG: log },
        stdio: 'ignore',
      });
      assert.notEqual(result.status, 0, boundary);
      const events = readFileSync(log, 'utf8').trim().split('\n');
      const firstBoundary = events.findIndex((event) => event.startsWith('boundary:'));
      assert.deepEqual(
        events.slice(0, firstBoundary),
        ['marker', 'forwarders', 'writers'],
        boundary,
      );
      assert.ok(events.includes(`boundary:${boundary}`), boundary);
      assert.ok(events.lastIndexOf('marker') > firstBoundary, boundary);
      assert.ok(events.lastIndexOf('forwarders') > firstBoundary, boundary);
      assert.ok(events.lastIndexOf('writers') > firstBoundary, boundary);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  assert.match(deploy, /fence_all_writers_cleanup/);
  assert.match(deploy, /run_pre_app_storage[\s\S]*rm -f -- "\$FAILURE_FENCE_MARKER"/);
  assert.match(
    deploy,
    /flock -w 300 8[\s\S]*verify_writers_restored[\s\S]*rm -f -- "\$FAILURE_FENCE_MARKER"/,
  );
  assert.match(reset, /combo-dev-smoke --storage-only[\s\S]*fence_all_writers \|\| blocked/);
  assert.doesNotMatch(reset, /rm -f -- "\$FAILURE_FENCE_MARKER"/);
  assert.match(guard, /verify_writers_fenced/);
});

test('first bootstrap tolerates absent forwarder units and serializes the persistent storage guard', () => {
  const bootstrap = text('scripts/combo-dev-bootstrap.sh');
  const stopBody = bootstrap.slice(
    bootstrap.indexOf('stop_forwarders() {'),
    bootstrap.indexOf('cleanup() {'),
  );
  assert.match(
    stopBody,
    /systemctl stop combo-dev-web-forward\.service combo-dev-s3-forward\.service[^\n]*\|\| true/,
  );
  assert.ok(stopBody.indexOf('systemctl stop') < stopBody.indexOf('forwarders_stopped'));

  const installBody = bootstrap.slice(
    bootstrap.indexOf('install_control_files() {'),
    bootstrap.indexOf('production_fingerprint() {'),
  );
  const timerStop = installBody.indexOf('systemctl disable --now combo-dev-storage-guard.timer');
  const firstCheck = installBody.indexOf('systemctl start combo-dev-storage-guard.service');
  const timerStart = installBody.indexOf('systemctl enable --now combo-dev-storage-guard.timer');
  assert.ok(timerStop >= 0);
  assert.ok(timerStop < firstCheck);
  assert.ok(firstCheck < timerStart);
  assert.match(
    bootstrap,
    /bootstrap_boundary platform-apply "\$\{AK\[@\]\}" apply --server-side[\s\S]*--field-manager=combo-dev-dispatcher --force-conflicts/,
  );
});

test('the always-on host guard uses an independent minimal fencer for missing, malformed, expiring, or unauthorized dispatcher credentials', () => {
  const bootstrap = text('scripts/combo-dev-bootstrap.sh');
  const deploy = text('scripts/combo-dev-deploy.sh');
  const reset = text('scripts/combo-dev-reset.sh');
  const guard = text('scripts/combo-dev-storage-guard.sh');
  const unit = text('infra/host/combo-dev/combo-dev-storage-guard.service');
  const rbac = text('infra/k8s/overlays/combo-dev/platform/rbac.yaml');
  const lease = text('scripts/combo-dev-forwarder-lease.sh');
  assert.match(bootstrap, /issue_client_credential combo-dev-dispatcher 90/);
  assert.match(bootstrap, /issue_client_credential combo-dev-fencer 365/);
  assert.match(bootstrap, /provision_fencer_credential[\s\S]*provision_dispatcher_credential/);
  assert.match(deploy, /DISPATCHER_OPERATION_MIN_SECONDS=\$\(\(4 \* 60 \* 60\)\)/);
  for (const script of [deploy, reset, guard]) {
    assert.match(script, /DISPATCHER_FENCE_BEFORE_SECONDS=\$\(\(7 \* 24 \* 60 \* 60\)\)/);
  }
  assert.doesNotMatch(unit, /ConditionPathExists/);
  assert.match(unit, /^ProtectHome=read-only$/m);
  assert.match(
    unit,
    /^ReadWritePaths=\/run \/var\/lib\/combo-dev \/home\/xingzheng\/data\/combo-dev$/m,
  );
  assert.doesNotMatch(unit, /ReadWritePaths=.* \/home\/xingzheng\/data(?:\s|$)/m);
  const fencerRoleStart = rbac.indexOf('kind: Role\nmetadata:\n  name: combo-dev-fencer');
  const fencerRoleEnd = rbac.indexOf('\n---', fencerRoleStart);
  assert.ok(fencerRoleStart >= 0);
  assert.ok(fencerRoleEnd > fencerRoleStart);
  const fencerRole = rbac.slice(fencerRoleStart, fencerRoleEnd);
  assert.match(
    fencerRole,
    /resources: \['deployments'\]\n {4}resourceNames: \['api', 'worker', 'runtime', 'web', 'redis-hot'\]\n {4}verbs: \['get'\]/,
  );
  assert.match(
    fencerRole,
    /resources: \['deployments\/scale'\]\n {4}resourceNames: \['api', 'worker', 'runtime', 'web', 'redis-hot'\]\n {4}verbs: \['patch'\]/,
  );
  assert.match(
    fencerRole,
    /resources: \['statefulsets'\]\n {4}resourceNames: \['postgres', 'redis-queue', 'minio'\]\n {4}verbs: \['get'\]/,
  );
  assert.match(
    fencerRole,
    /resources: \['statefulsets\/scale'\]\n {4}resourceNames: \['postgres', 'redis-queue', 'minio'\]\n {4}verbs: \['patch'\]/,
  );
  assert.equal(fencerRole.match(/\/scale/g)?.length, 2);
  assert.equal(fencerRole.match(/'patch'/g)?.length, 2);
  assert.doesNotMatch(fencerRole, /verbs: \[[^\]]*(?:create|update)[^\]]*\]/);
  assert.doesNotMatch(
    fencerRole,
    /resources: \['(?:deployments|statefulsets)'\]\n {4}resourceNames: [^\n]+\n {4}verbs: \[[^\]\n]*patch[^\]\n]*\]/,
  );
  for (const script of [bootstrap, guard]) {
    const canI = script.slice(
      script.indexOf(script === bootstrap ? 'can_i_with_credential() {' : 'can_i() {'),
      script.indexOf(
        script === bootstrap ? 'trusted_source_tree() {' : 'dispatcher_access_valid() {',
      ),
    );
    assert.match(canI, /--subresource="\$subresource"/);
    const fencerChecks = script.slice(
      script.indexOf(
        script === bootstrap ? 'fencer_credential_valid() {' : 'fencer_access_valid() {',
      ),
      script.indexOf(
        script === bootstrap ? 'issue_client_credential() {' : 'mark_failure_fence() {',
      ),
    );
    assert.match(fencerChecks, /yes patch "deployments\.apps\/\$name" "\$NAMESPACE" scale/);
    assert.match(fencerChecks, /yes patch "statefulsets\.apps\/\$name" "\$NAMESPACE" scale/);
    assert.match(fencerChecks, /no patch deployments\.apps\/api "\$NAMESPACE"/);
    assert.match(fencerChecks, /no update deployments\.apps\/api "\$NAMESPACE" scale/);
    assert.match(fencerChecks, /no patch deployments\.apps\/api "\$PRODUCTION_NAMESPACE" scale/);
  }
  assert.match(lease, /FAILURE_FENCE_MARKER/);

  const fenceBody = guard.slice(guard.indexOf('fence_now() {'), guard.lastIndexOf('main() {'));
  assert.ok(fenceBody.indexOf('stop_forwarders') < fenceBody.indexOf('mark_failure_fence'));
  assert.ok(
    fenceBody.indexOf('mark_failure_fence') <
      fenceBody.indexOf('credential_certificate_valid_for "$FENCER_KUBECONFIG"'),
  );
  assert.ok(
    fenceBody.indexOf('credential_certificate_valid_for "$FENCER_KUBECONFIG"') <
      fenceBody.indexOf('fence_writers_with_minimal_credential'),
  );
  for (const message of ['调度凭据缺失、损坏或进入预到期窗口', '调度凭据已失效或权限发生漂移']) {
    assert.ok(guard.includes(message));
  }

  const work = mkdtempSync(join(tmpdir(), 'combo-dev-credential-guard-'));
  try {
    const caKey = join(work, 'ca.key');
    const caCert = join(work, 'ca.crt');
    const key = join(work, 'client.key');
    const request = join(work, 'client.csr');
    const expiring = join(work, 'expiring.crt');
    for (const args of [
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '2',
        '-subj',
        '/CN=test-ca',
        '-keyout',
        caKey,
        '-out',
        caCert,
      ],
      [
        'req',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-subj',
        '/CN=combo-dev-dispatcher',
        '-keyout',
        key,
        '-out',
        request,
      ],
      [
        'x509',
        '-req',
        '-in',
        request,
        '-CA',
        caCert,
        '-CAkey',
        caKey,
        '-set_serial',
        '2',
        '-days',
        '1',
        '-out',
        expiring,
      ],
    ]) {
      execFileSync('openssl', args, { stdio: 'ignore' });
    }
    const kubeconfig = (certificate) =>
      `apiVersion: v1\nkind: Config\nclusters:\n- name: k3s\n  cluster:\n    server: https://127.0.0.1:6443\n    certificate-authority-data: ${readFileSync(caCert).toString('base64')}\nusers:\n- name: combo-dev-dispatcher\n  user:\n    client-certificate-data: ${readFileSync(certificate).toString('base64')}\n    client-key-data: ${readFileSync(key).toString('base64')}\ncontexts:\n- name: combo-dev\n  context:\n    cluster: k3s\n    user: combo-dev-dispatcher\ncurrent-context: combo-dev\n`;
    const expiringConfig = join(work, 'expiring.kubeconfig');
    const malformedConfig = join(work, 'malformed.kubeconfig');
    writeFileSync(expiringConfig, kubeconfig(expiring), { mode: 0o600 });
    writeFileSync(malformedConfig, 'not: [valid\n', { mode: 0o600 });
    const guardPath = join(repo, 'scripts/combo-dev-storage-guard.sh');
    const credentialHarness = (path) => `
source ${JSON.stringify(guardPath)}
private_file() { [[ -f "$1" ]]; }
credential_certificate_valid_for ${JSON.stringify(path)} combo-dev-dispatcher $((2 * 24 * 60 * 60))
`;
    for (const path of [join(work, 'missing.kubeconfig'), malformedConfig, expiringConfig]) {
      assert.notEqual(
        spawnSync('bash', ['-c', credentialHarness(path)], { stdio: 'ignore' }).status,
        0,
      );
    }
    const unauthorized = spawnSync(
      'bash',
      ['-c', `source ${JSON.stringify(guardPath)}; can_i() { return 1; }; dispatcher_access_valid`],
      { stdio: 'ignore' },
    );
    assert.notEqual(unauthorized.status, 0);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('listener validation rejects every additional IPv4 or IPv6 address and wrong owning process', () => {
  const deploy = text('scripts/combo-dev-deploy.sh');
  const smoke = text('scripts/combo-dev-smoke.sh');
  for (const script of [deploy, smoke]) {
    assert.match(script, /ss -H -ltnp/);
    assert.match(script, /systemctl show combo-dev-web-forward\.service -p MainPID/);
    assert.match(script, /validate-listeners/);
  }
  assert.match(
    deploy,
    /wait_loopback_listeners\(\) \{[\s\S]*for \(\(attempt = 1; attempt <= 30; attempt\+\+\)\)/,
  );
  assert.match(
    deploy,
    /systemctl start combo-dev-s3-forward\.service[\s\S]*wait_loopback_listeners/,
  );
  assert.match(deploy, /validate-listeners[\s\S]*\|\| return 1/);
  const work = mkdtempSync(join(tmpdir(), 'combo-dev-listeners-'));
  try {
    const input = join(work, 'listeners');
    const line = (address, port, pid) =>
      `LISTEN 0 4096 ${address}:${port} 0.0.0.0:* users:(("kubectl",pid=${pid},fd=7))`;
    const base = [line('127.0.0.1', 18080, 111), line('127.0.0.1', 19000, 222)];
    const check = (lines) => {
      writeFileSync(input, `${lines.join('\n')}\n`);
      return spawnSync(
        'python3',
        [
          join(repo, 'scripts/combo-dev-production-safety.py'),
          'validate-listeners',
          '--input',
          input,
          '--web-pid',
          '111',
          '--s3-pid',
          '222',
        ],
        { stdio: 'ignore' },
      ).status;
    };
    assert.equal(check(base), 0);
    for (const extra of [
      line('192.0.2.25', 18080, 333),
      line('[2001:db8::25]', 18080, 333),
      line('0.0.0.0', 19000, 333),
      line('[::]', 19000, 333),
      line('[::1]', 19000, 333),
    ]) {
      assert.notEqual(check([...base, extra]), 0, extra);
    }
    assert.notEqual(check([line('127.0.0.1', 18080, 999), base[1]]), 0);
    assert.notEqual(check([base[0]]), 0);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('network canary uses a pinned deterministic TCP probe and proves its positive control before denied targets', () => {
  const smoke = text('scripts/combo-dev-smoke.sh');
  assert.match(
    smoke,
    /python@sha256:37b14db89f587f9eaa890e4a442a3fe55db452b69cca1403cc730bd0fbdc8aaf/,
  );
  assert.doesNotMatch(smoke, /\bnc\s+-z\b/);
  assert.doesNotMatch(
    smoke.slice(
      smoke.indexOf('run_network_canary() {'),
      smoke.indexOf('check_logs_fail_closed() {'),
    ),
    /hostPath:/,
  );
  const start = smoke.indexOf('              import os');
  const end = smoke.indexOf('              production_web', start);
  assert.ok(start > 0 && end > start);
  const positiveControl = smoke
    .slice(start, end)
    .split('\n')
    .map((line) => line.replace(/^ {14}/, ''))
    .join('\n');
  assert.ok(
    positiveControl.indexOf('probe("127.0.0.1", control_port)') <
      positiveControl.indexOf('control.close()'),
  );
  assert.equal(spawnSync('python3', ['-c', positiveControl], { stdio: 'ignore' }).status, 0);
  const brokenProbe = positiveControl.replace(
    'if connection.connect_ex(address) == 0:',
    'if False:',
  );
  assert.equal(spawnSync('python3', ['-c', brokenProbe], { stdio: 'ignore' }).status, 3);
  if (dockerAvailable) {
    assert.equal(
      spawnSync(
        'docker',
        [
          'run',
          '--rm',
          '--read-only',
          '--user',
          '65534:65534',
          'python@sha256:37b14db89f587f9eaa890e4a442a3fe55db452b69cca1403cc730bd0fbdc8aaf',
          'python3',
          '-c',
          positiveControl,
        ],
        { stdio: 'ignore' },
      ).status,
      0,
    );
  }
});

test('combo-dev nginx consumes the exact client-events route without proxying or logging its body', () => {
  const nginx = text('infra/k8s/overlays/combo-dev/apps/nginx-dev.conf');
  const match = nginx.match(/location = \/api\/v1\/client-events \{([\s\S]*?)\n {2}\}/);
  assert.ok(match);
  assert.match(match[1], /access_log off;/);
  assert.match(match[1], /return 204;/);
  assert.match(match[1], /Cache-Control "no-store"/);
  assert.doesNotMatch(match[1], /proxy_pass|\$request_body/);
  assert.equal((nginx.match(/\/api\/v1\/client-events/g) ?? []).length, 1);

  const root = fixture();
  try {
    const path = join(root, 'infra/k8s/overlays/combo-dev/apps/nginx-dev.conf');
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace(
        '    return 204;',
        '    proxy_pass http://$api_host:3000;',
      ),
    );
    expectRenderFailure(root, /guard:telemetry-boundary/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Test prunes only stale Web and release metadata after proving every live reference', () => {
  const deploy = text('scripts/combo-dev-deploy.sh');
  const start = deploy.indexOf('prune_stale_configs() {');
  const end = deploy.indexOf('\ncheck_loopback_listeners_once() {', start);
  assert.ok(start > 0 && end > start);
  const prune = deploy.slice(start, end);
  assert.match(prune, /get deployment "\$\{APP_NAMES\[@\]\}" -o json/);
  assert.match(
    prune,
    /\(\[\.\[\]\.metadata\.name\] \| sort\) != \["api", "runtime", "web", "worker"\]/,
  );
  assert.match(prune, /\(\$release_refs \| unique \| length\) != 1/);
  assert.match(prune, /\^combo-release-meta-\[0-9a-f\]\{12\}\$/);
  assert.match(prune, /\^combo-dev-nginx-\[a-z0-9\]\+\$/);
  assert.match(
    prune,
    /get configmaps -l combo\.dev\/environment=combo-dev -o json[\s\S]*stale_json=/,
  );
  assert.match(prune, /delete "configmap\/\$name" --wait=false/);
  assert.doesNotMatch(prune, /delete "\$item"/);
  assert.ok(prune.indexOf('live_refs=$(') < prune.indexOf('listed=$('));
  assert.ok(prune.indexOf('stale_json=$(') < prune.indexOf('delete "configmap/$name"'));

  const flow = deploy.slice(deploy.indexOf('  MUTATING=1'));
  assert.ok(flow.indexOf('wait_apps ') < flow.indexOf('prune_stale_configs'));
  assert.ok(
    flow.indexOf('prune_stale_configs') <
      flow.indexOf('systemctl start combo-dev-web-forward.service'),
  );
  assert.match(deploy.slice(0, deploy.indexOf('host_preflight() {')), /fence_all_writers_cleanup/);
});

test('Test, Preview, and Production serialize only deploy jobs and preserve promotion trust', () => {
  const workflow = text('.github/workflows/combo-dev.yml');
  const ci = text('.github/workflows/ci.yml');
  const testDeploy = text('scripts/combo-dev-deploy.sh');
  const preview = text('.github/workflows/preview.yml');
  const production = text('.github/workflows/cd.yml');
  const deployGroup = (value) =>
    value.match(
      /^ {4}concurrency:\n {6}group: ([^\n]+)\n {6}queue: ([^\n]+)\n {6}cancel-in-progress: ([^\n]+)$/m,
    );
  for (const delivery of [workflow, preview, production]) {
    const group = deployGroup(delivery);
    assert.ok(group);
    assert.equal(group[1], 'cd-tecent2');
    assert.equal(group[2], 'max');
    assert.equal(group[3], 'false');
    assert.doesNotMatch(delivery, /^concurrency:/m);
  }

  assert.match(workflow, /^ {2}workflow_dispatch:/m);
  const triggers = workflow.slice(workflow.indexOf('on:\n'), workflow.indexOf('\npermissions:'));
  const productionTriggers = production.slice(
    production.indexOf('on:\n'),
    production.indexOf('\npermissions:'),
  );
  assert.doesNotMatch(triggers, /workflow_run/);
  assert.match(productionTriggers, /^ {2}workflow_dispatch:/m);
  assert.doesNotMatch(productionTriggers, /workflow_run|push:|pull_request:/);
  assert.match(preview, /^ {2}workflow_run:/m);
  assert.match(preview, /branches: \[main\]/);
  assert.match(preview, /COMBO_PREVIEW_AUTO_PROMOTION_MODE/);
  assert.match(
    workflow,
    /revision:[\s\S]*required: true[\s\S]*INPUT_REVISION: \$\{\{ inputs\.revision \}\}/,
  );
  assert.match(production, /REVISION: \$\{\{ inputs\.revision \}\}/);
  assert.match(workflow, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(production, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(workflow, /branches\?per_page=100/);
  assert.match(workflow, /compare\/\$\{REVISION\}\.\.\.\$\{branch_sha\}/);
  assert.match(production, /compare\/\$\{REVISION\}\.\.\.main/);
  assert.match(workflow, /uses: \.\/\.github\/workflows\/ci\.yml/);
  assert.match(workflow, /publish_release: true/);
  assert.doesNotMatch(ci, /github\.event_name == 'workflow_call'/);
  assert.match(
    ci,
    /^ {2}release:\n[\s\S]*?^ {4}if: >-\n\s+\(github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'\) \|\|\n\s+inputs\.publish_release == true/m,
  );
  assert.match(
    ci,
    /push: >-\n\s+\$\{\{ \(github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'\) \|\|\n\s+inputs\.publish_release == true \}\}/,
  );
  const webContract = ci.slice(
    ci.indexOf('      - name: Verify the hardened Web runtime metadata path'),
    ci.indexOf('      - name: Record the immutable image reference'),
  );
  assert.match(webContract, /IMAGE_DIGEST: \$\{\{ steps\.build\.outputs\.digest \}\}/);
  assert.match(webContract, /case "\$PUBLISH_RELEASE" in/);
  assert.match(webContract, /\[\[ "\$IMAGE_DIGEST" =~ \^sha256:\[0-9a-f\]\{64\}\$ \]\]/);
  assert.match(webContract, /IMAGE_REF="\$IMAGE_REPOSITORY@\$IMAGE_DIGEST"/);
  assert.match(webContract, /docker pull "\$IMAGE_REF"/);
  assert.match(
    webContract,
    /false\)[\s\S]*IMAGE_REF="\$IMAGE_TAG"[\s\S]*docker image inspect "\$IMAGE_REF"/,
  );
  assert.match(webContract, /"\$IMAGE_REF" >\/dev\/null/);
  assert.doesNotMatch(webContract, /docker pull "\$IMAGE_TAG"/);
  assert.match(workflow, /combo-release-mutation\.lock/);
  assert.match(workflow, /flock -w 300 9/);
  assert.match(
    workflow,
    /"\$RELEASE_ROOT\/metadata\/release\.json"[\s\\\n]*"\$RELEASE_ROOT\/metadata\/release-manifest-digest\.txt"[\s\\\n]*"\$root\/metadata\/"/,
  );
  assert.match(testDeploy, /'metadata\/release\.json', 'metadata\/release-manifest-digest\.txt'/);
  assert.match(
    testDeploy,
    /validate_release_manifest[\s\\\n]*"\$manifest" "\$digest_file" "\$revision" "\$api_image" "\$runtime_image" "\$web_image"/,
  );
  assert.match(testDeploy, /combo-release-meta-\$\{revision:0:12\}/);
  assert.match(
    workflow,
    /combo-dev-reset[\s\\\n]*--confirm=DESTROY-COMBO-PREVIEW-DATA[\s\S]*combo-dev-deploy/,
  );
  assert.match(preview, /combo-preview-promotion-\$\{\{/);
  assert.match(production, /combo-preview-promotion-\$\{\{/);
  assert.match(production, /artifactFileSetDigest/);
  assert.match(
    production,
    /keys == \(\[[\s\S]*?"remoteCleanupEvidenceDigest"[\s\S]*?"status"\s*\] \| sort\)/,
    'Production must compare the exact Preview evidence key set independent of list order',
  );
  assert.match(workflow, /echo ' {2}ServerAliveInterval 30'/);
  assert.match(workflow, /echo ' {2}ServerAliveCountMax 20'/);
  assert.match(workflow, /echo ' {2}TCPKeepAlive yes'/);
  assert.match(preview, /\[\[ "\$SOURCE_BRANCH" == main \]\]/);
  assert.match(production, /\.path == "\.github\/workflows\/preview\.yml"/);
  const credentialRefresh = preview.slice(
    preview.indexOf('      - name: Refresh an expired Preview image pull credential'),
    preview.indexOf('      - name: Validate the refreshed Preview registry credential'),
  );
  assert.match(credentialRefresh, /\(\( \$\{#GHCR_TOKEN\} > 0 && \$\{#GHCR_TOKEN\} <= 4096 \)\)/);
  assert.match(
    credentialRefresh,
    /\[\[ "\$GHCR_TOKEN" != \*\$'\\n'\* && "\$GHCR_TOKEN" != \*\$'\\r'\* \]\]/,
  );
  assert.match(credentialRefresh, /\[\[ "\$GHCR_USER" =~ \^\[A-Za-z0-9_-\]\+\$ \]\]/);
  assert.doesNotMatch(credentialRefresh, /GHCR_TOKEN" =~/);
  assert.doesNotMatch(workflow, /issue\s*#?112|promotion/i);
});

test('every retained cluster-scoped object is compared against one canonical bootstrap contract', () => {
  const safety = join(repo, 'scripts/combo-dev-production-safety.py');
  const work = mkdtempSync(join(tmpdir(), 'combo-dev-platform-contract-'));
  const pv = (name, claim, size, path) => ({
    apiVersion: 'v1',
    kind: 'PersistentVolume',
    metadata: { name, labels: { 'combo.dev/environment': 'combo-dev' } },
    spec: {
      capacity: { storage: size },
      volumeMode: 'Filesystem',
      accessModes: ['ReadWriteOnce'],
      persistentVolumeReclaimPolicy: 'Retain',
      storageClassName: 'combo-dev-bounded',
      claimRef: { namespace: 'combo-preview', name: claim },
      local: { path },
      nodeAffinity: {
        required: {
          nodeSelectorTerms: [
            {
              matchExpressions: [
                { key: 'kubernetes.io/hostname', operator: 'In', values: ['node-one'] },
              ],
            },
          ],
        },
      },
    },
  });
  const objects = [
    {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: 'combo-preview',
        labels: {
          'combo.dev/environment': 'combo-dev',
          'pod-security.kubernetes.io/enforce': 'restricted',
        },
      },
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'ClusterRole',
      metadata: { name: 'combo-dev-control-auditor' },
      rules: [{ apiGroups: [''], resources: ['namespaces'], verbs: ['get', 'list'] }],
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'ClusterRoleBinding',
      metadata: { name: 'combo-dev-control-auditor' },
      subjects: [
        { kind: 'User', apiGroup: 'rbac.authorization.k8s.io', name: 'combo-dev-dispatcher' },
      ],
      roleRef: {
        apiGroup: 'rbac.authorization.k8s.io',
        kind: 'ClusterRole',
        name: 'combo-dev-control-auditor',
      },
    },
    {
      apiVersion: 'storage.k8s.io/v1',
      kind: 'StorageClass',
      metadata: { name: 'combo-dev-bounded' },
      provisioner: 'kubernetes.io/no-provisioner',
      reclaimPolicy: 'Retain',
      volumeBindingMode: 'WaitForFirstConsumer',
      allowVolumeExpansion: false,
    },
    pv('combo-dev-postgres', 'data-postgres-0', '8Gi', '/home/xingzheng/data/combo-dev/postgres'),
    pv(
      'combo-dev-redis-queue',
      'data-redis-queue-0',
      '2Gi',
      '/home/xingzheng/data/combo-dev/redis-queue',
    ),
    pv('combo-dev-minio', 'data-minio-0', '6Gi', '/home/xingzheng/data/combo-dev/minio'),
  ];
  try {
    const input = join(work, 'desired.json');
    const expected = join(work, 'expected.json');
    const live = join(work, 'live.json');
    writeFileSync(input, JSON.stringify({ apiVersion: 'v1', kind: 'List', items: objects }));
    execFileSync(
      'python3',
      [safety, 'canonicalize-platform', '--input', input, '--output', expected],
      { stdio: 'ignore' },
    );
    const compare = (items) => {
      writeFileSync(live, JSON.stringify({ apiVersion: 'v1', kind: 'List', items }));
      return spawnSync(
        'python3',
        [safety, 'compare-platform', '--expected', expected, '--live', live],
        { stdio: 'ignore' },
      ).status;
    };
    const serverDecorated = clone(objects);
    serverDecorated[0].metadata.labels['kubernetes.io/metadata.name'] = 'combo-preview';
    serverDecorated[0].spec = { finalizers: ['kubernetes'] };
    for (const item of serverDecorated.slice(4)) {
      item.metadata.finalizers = ['kubernetes.io/pv-protection'];
      item.spec.claimRef.uid = 'server-generated';
      item.status = { phase: 'Bound' };
    }
    assert.equal(compare(serverDecorated), 0);

    const mutations = [
      [0, (item) => (item.metadata.labels['pod-security.kubernetes.io/enforce'] = 'baseline')],
      [1, (item) => item.rules[0].verbs.push('watch')],
      [2, (item) => (item.subjects[0].name = 'other-user')],
      [
        3,
        (item) =>
          (item.metadata.annotations = { 'storageclass.kubernetes.io/is-default-class': 'true' }),
      ],
      [4, (item) => (item.spec.local.path = '/tmp/postgres')],
      [5, (item) => (item.spec.capacity.storage = '3Gi')],
      [
        6,
        (item) =>
          (item.spec.nodeAffinity.required.nodeSelectorTerms[0].matchExpressions[0].values = [
            'other-node',
          ]),
      ],
    ];
    for (const [index, mutate] of mutations) {
      const drifted = clone(serverDecorated);
      mutate(drifted[index]);
      assert.notEqual(
        compare(drifted),
        0,
        `${drifted[index].kind}/${drifted[index].metadata.name}`,
      );
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  const bootstrap = text('scripts/combo-dev-bootstrap.sh');
  assert.match(bootstrap, /create --dry-run=client --validate=strict/);
  assert.match(bootstrap, /canonicalize-platform/);
  for (const scriptPath of [
    'scripts/combo-dev-bootstrap.sh',
    'scripts/combo-dev-deploy.sh',
    'scripts/combo-dev-reset.sh',
    'scripts/combo-dev-smoke.sh',
  ]) {
    assert.match(text(scriptPath), /compare-platform/);
  }
  assert.equal(
    existsSync(join(repo, 'infra/k8s/overlays/combo-dev/platform/storage-provisioner.yaml')),
    false,
  );
  assert.doesNotMatch(
    text('scripts/combo-dev-bootstrap.sh'),
    /combo-dev-local-path|combo\.dev\/local-path/,
  );
});

test('MinIO initialization removes stale application identities and performs a negative post-removal check', () => {
  const init = text('infra/k8s/overlays/combo-dev/init/resources.yaml');
  const bootstrap = text('scripts/combo-dev-bootstrap.sh');
  assert.match(bootstrap, /re\.fullmatch\(r'\[A-Za-z0-9\]/);
  assert.match(init, /mc admin user list local --json/);
  assert.match(init, /mc admin user remove local "\$identity" >\/dev\/null 2>&1/);
  assert.match(init, /if mc admin user info local "\$identity" >\/dev\/null 2>&1; then/);
  assert.match(init, /mc ls revoked\/combo-raw >\/dev\/null 2>&1/);
  assert.match(init, /inventory_users\(\) \{/);
  assert.match(init, /\[ "\$inventory_records" -eq 1 \]/);
  assert.doesNotMatch(init, /^\s+(?:grep|sed|awk|jq)\b/m);
  assert.doesNotMatch(init, /echo .*\$identity/);
});

test('OpenSSH effective configuration retains exactly the two approved local forwards', () => {
  const connect = text('scripts/combo-dev-connect.sh');
  assert.match(connect, /ClearAllForwardings=no/);
  assert.doesNotMatch(connect, /-o ClearAllForwardings=yes/);
  assert.match(connect, /ssh -G "\$\{SSH_ARGS\[@\]\}"/);
  assert.match(connect, /localforward\|remoteforward\|dynamicforward/);
  const args = [
    '-G',
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'ClearAllForwardings=no',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=3',
    '-L',
    '127.0.0.1:18080:127.0.0.1:18080',
    '-L',
    '127.0.0.1:19000:127.0.0.1:19000',
    'localhost',
  ];
  const result = spawnSync('ssh', args, { encoding: 'utf8' });
  assert.equal(result.status, 0);
  const forwards = result.stdout
    .split('\n')
    .filter((line) => line.startsWith('localforward '))
    .map((line) => line.slice('localforward '.length));
  assert.deepEqual(forwards, [
    '[127.0.0.1]:18080 [127.0.0.1]:18080',
    '[127.0.0.1]:19000 [127.0.0.1]:19000',
  ]);

  const work = mkdtempSync(join(tmpdir(), 'combo-dev-ssh-config-'));
  try {
    mkdirSync(join(work, '.ssh'), { recursive: true });
    writeFileSync(
      join(work, '.ssh/config'),
      'Host combo-dev-extra\n  HostName localhost\n  LocalForward 127.0.0.1:19999 127.0.0.1:19999\n',
    );
    chmodSync(join(work, '.ssh/config'), 0o600);
    const withExtra = spawnSync(
      'ssh',
      ['-G', '-F', join(work, '.ssh/config'), ...args.slice(1, -1), 'combo-dev-extra'],
      { encoding: 'utf8' },
    );
    assert.equal(withExtra.status, 0);
    assert.equal(
      withExtra.stdout
        .split('\n')
        .filter((line) => /^(localforward|remoteforward|dynamicforward) /.test(line)).length,
      3,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('control digest authenticates every consumed kustomization and resource file', () => {
  const bootstrap = text('scripts/combo-dev-bootstrap.sh');
  const deploy = text('scripts/combo-dev-deploy.sh');
  const bootstrapControls = bootstrap.match(/readonly CONTROL_FILES=\((?<body>[\s\S]*?)\n\)/)
    ?.groups?.body;
  const deployControls = deploy.match(/readonly CONTROL_FILES=\((?<body>[\s\S]*?)\n\)/)?.groups
    ?.body;
  assert.ok(bootstrapControls);
  assert.equal(deployControls, bootstrapControls);
  for (const required of [
    'infra/k8s/overlays/combo-dev/kustomization.yaml',
    'infra/k8s/overlays/combo-dev/platform/kustomization.yaml',
    'infra/k8s/overlays/combo-dev/platform/network-policies.yaml',
    'infra/k8s/overlays/combo-dev/platform/rbac.yaml',
    'infra/k8s/overlays/combo-dev/platform/storage-class.yaml',
    'infra/k8s/overlays/combo-dev/platform/storage-volumes.yaml',
    'infra/k8s/overlays/combo-dev/foundation/kustomization.yaml',
    'infra/k8s/overlays/combo-dev/foundation/postgres-entrypoint.sh',
    'infra/k8s/overlays/combo-dev/foundation/resources.yaml',
    'infra/k8s/overlays/combo-dev/init/kustomization.yaml',
    'infra/k8s/overlays/combo-dev/init/resources.yaml',
    'infra/k8s/overlays/combo-dev/migrate/kustomization.yaml',
    'infra/k8s/overlays/combo-dev/migrate/resources.yaml',
    'infra/k8s/overlays/combo-dev/apps/kustomization.yaml',
    'infra/k8s/overlays/combo-dev/apps/resources.yaml',
  ]) {
    assert.ok(bootstrapControls.includes(required));
  }
  assert.match(bootstrap, /\/opt\/combo-dev\/bootstrap-overlay/);
  assert.match(deploy, /"\$INSTALL_ROOT\/bootstrap-overlay\/apps\/resources\.yaml"/);
});

test('existing deployment invariants remain fail-closed', () => {
  const workflow = text('.github/workflows/combo-dev.yml');
  const deploy = text('scripts/combo-dev-deploy.sh');
  const reset = text('scripts/combo-dev-reset.sh');
  const bootstrap = text('scripts/combo-dev-bootstrap.sh');
  const guard = text('scripts/combo-dev-storage-guard.sh');
  const smoke = text('scripts/combo-dev-smoke.sh');
  const rbac = text('infra/k8s/overlays/combo-dev/platform/rbac.yaml');
  const testMinioInit = text('infra/k8s/overlays/combo-dev/init/resources.yaml');
  const releaseMinioInit = text('infra/k8s/job-minio-init.yaml');
  assert.match(
    rbac,
    /resources: \['jobs'\]\n {4}verbs: \['create', 'get', 'list', 'watch', 'patch', 'delete'\]/,
  );
  assert.match(deploy, /name: combo-dev-job-rbac-preflight/);
  assert.match(
    deploy,
    /apply --server-side --dry-run=server --field-manager=combo-dev-dispatcher -f "\$job_probe"/,
  );
  assert.match(
    deploy,
    /\[\[ "\$stage" == foundation \]\][\s\S]*apply --server-side --dry-run=server --field-manager=combo-dev-dispatcher --force-conflicts -f "\$render\/\$stage\.yaml"/,
  );
  assert.match(workflow, /scp -q "\$ARCHIVE" "combo-dev-target:\$temporary"/);
  assert.match(workflow, /ssh combo-dev-target mv -fT -- "\$temporary" "\$remote"/);
  assert.match(deploy, /INCOMING_BUNDLE=\$bundle/);
  assert.match(deploy, /head -c 65537 >"\$evidence"/);
  assert.match(deploy, /"\$evidence_bytes" -le 65536/);
  assert.doesNotMatch(deploy, /ulimit -f/);
  assert.match(deploy, /\[\[ -z "\$INCOMING_BUNDLE" \]\] \|\| rm -f -- "\$INCOMING_BUNDLE"/);
  assert.match(reset, /wipe_static_volume_data/);
  assert.doesNotMatch(reset, /delete "persistentvolumeclaim\/\$name"/);
  assert.match(
    reset,
    /apply --server-side --dry-run=server --field-manager=combo-dev-dispatcher --force-conflicts -k "\$FOUNDATION"/,
  );
  assert.match(
    reset,
    /apply --server-side --field-manager=combo-dev-session --force-conflicts -f "\$manifest"/,
  );
  assert.doesNotMatch(reset, /patch secret\/combo-dev-session/);
  for (const manifest of [testMinioInit, releaseMinioInit]) {
    assert.match(manifest, /name: minio-init/);
    assert.match(manifest, /limits:[\s\S]*?memory: 256Mi/);
  }
  assert.match(
    rbac,
    /resourceNames: \['combo-dev-postgres', 'combo-dev-redis-queue', 'combo-dev-minio'\]/,
  );
  for (const script of [deploy, reset]) {
    assert.match(
      script,
      /apply --server-side --field-manager=combo-dev-replicas --force-conflicts -f -/,
    );
  }
  assert.match(
    smoke,
    /ownership=\$\("\$\{K\[@\]\}" -n "\$NAMESPACE" get "deployment\/\$name" --show-managed-fields=true -o json/,
  );
  assert.match(
    smoke,
    /curl_json\(\) \{[\s\S]*for \(\(attempt = 1; attempt <= 60; attempt\+\+\)\)[\s\S]*mv -fT "\$candidate" "\$output"[\s\S]*恢复窗口内不可读：\$path/,
  );
  assert.ok(
    smoke.includes(
      `tr -d '\\015' <"$headers" | grep -Fxci 'access-control-allow-origin: http://127.0.0.1:18080'`,
    ),
  );
  assert.doesNotMatch(smoke, /access-control-allow-origin:[^\n]*\\r/);
  for (const script of [bootstrap, deploy, reset]) {
    assert.match(script, /exec 9>"\$LOCK_FILE"\n\s+flock -w 300 9/);
  }
  assert.match(bootstrap, /scale "\$controller" --replicas=0/);
  assert.match(guard, /scale "\$kind\/\$name" --replicas=0/);
  assert.doesNotMatch(guard, /--field-manager=combo-dev-dispatcher/);
  for (const path of [
    'scripts/combo-dev-bootstrap.sh',
    'scripts/combo-dev-deploy.sh',
    'scripts/combo-dev-reset.sh',
    'scripts/combo-dev-smoke.sh',
    'scripts/combo-dev-logs.sh',
    'scripts/combo-dev-storage-guard.sh',
    'scripts/combo-dev-forwarder-lease.sh',
  ]) {
    assert.match(
      text(path),
      /export PATH='\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin'/,
    );
  }
});
