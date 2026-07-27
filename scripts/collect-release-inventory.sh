#!/usr/bin/env bash
set -euo pipefail

ENVIRONMENT=''
SOURCE_SHA=''
OUTPUT=''
KUBECONFIG_PATH=${KUBECONFIG:-"$HOME/.kube/config"}

fail() {
  printf 'collect-release-inventory: %s\n' "$1" >&2
  exit 1
}

usage() {
  fail 'usage: collect-release-inventory.sh --environment preview|production --source-sha SHA --output FILE'
}

while (($# > 0)); do
  (($# >= 2)) || usage
  case "$1" in
    --environment) ENVIRONMENT=$2 ;;
    --source-sha) SOURCE_SHA=$2 ;;
    --output) OUTPUT=$2 ;;
    *) usage ;;
  esac
  shift 2
done

case "$ENVIRONMENT" in
  preview) NAMESPACE=combo-review ;;
  production) NAMESPACE=combo ;;
  *) usage ;;
esac
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || fail 'source SHA is invalid'
[[ -n "$OUTPUT" && ! -e "$OUTPUT" ]] || fail 'output must be a new path'
for command in kubectl jq install date dirname mv chmod rm; do
  command -v "$command" >/dev/null 2>&1 || fail "missing command: $command"
done
[[ -f "$KUBECONFIG_PATH" ]] || fail 'kubeconfig is missing'

K=(kubectl --kubeconfig "$KUBECONFIG_PATH")
names() {
  "${K[@]}" -n "$NAMESPACE" get "$1" -o json |
    jq -c '[.items[].metadata.name] | sort'
}

deployments=$(names deployments.apps)
stateful_sets=$(names statefulsets.apps)
jobs=$(names jobs.batch)
services=$(names services)
ingresses=$(names ingresses.networking.k8s.io)
pvcs=$(names persistentvolumeclaims)
cron_jobs=$(names cronjobs.batch)
daemon_sets=$(names daemonsets.apps)
network_policies=$(names networkpolicies.networking.k8s.io)
roles=$(names roles.rbac.authorization.k8s.io)
role_bindings=$(names rolebindings.rbac.authorization.k8s.io)
service_accounts=$(names serviceaccounts)
config_maps=$(names configmaps)
pods=$(names pods)
replica_sets=$(names replicasets.apps)
cluster_role_bindings=$("${K[@]}" get clusterrolebindings.rbac.authorization.k8s.io -o json |
  jq -c --arg namespace "$NAMESPACE" '
    [.items[]
      | select(any(.subjects[]?; .namespace == $namespace))
      | .metadata.name]
    | sort
  ')
persistent_volumes=$("${K[@]}" get persistentvolumes -o json |
  jq -c --arg namespace "$NAMESPACE" '
    [.items[]
      | select(.spec.claimRef.namespace == $namespace)
      | {claim: .spec.claimRef.name, name: .metadata.name}]
    | sort_by(.name)
  ')
node_ports=$("${K[@]}" -n "$NAMESPACE" get services -o json |
  jq -c '
    [.items[]
      | .metadata.name as $name
      | .spec.ports[]?
      | select(.nodePort != null)
      | {name: $name, port: .nodePort}]
    | sort_by([.name, .port])
  ')
pods_json=$("${K[@]}" -n "$NAMESPACE" get pods -o json)
replica_sets_json=$("${K[@]}" -n "$NAMESPACE" get replicasets.apps -o json)
live_pods=$(jq -c --arg prefix "release-${SOURCE_SHA:0:12}-" '
    [.items[]
      | select(.metadata.deletionTimestamp == null)
      | select(.metadata.labels["combo.build/release-track"] == "release-v1")
      | select((.metadata.labels.app // "") | startswith($prefix))
      | {
          app: .metadata.labels.app,
          image: (.spec.containers[0].image // ""),
          imageID: (
            (.status.containerStatuses[0].imageID // "")
            | sub("^docker-pullable://"; "")
            | sub("^docker://"; "")
          ),
          name: .metadata.name,
          ready: (
            (.spec.containers | length) == 1
            and ((.spec.initContainers // []) | length) == 0
            and ((.spec.ephemeralContainers // []) | length) == 0
            and (.status.containerStatuses | length) == 1
            and all(.status.containerStatuses[]; .ready == true)
          ),
          sourceSha: .metadata.annotations["combo.build/source-sha"]
        }]
    | sort_by([.app, .name])
  ' <<<"$pods_json")
legacy_pods=$(jq -c --arg sourceSha "$SOURCE_SHA" '
  [.items[]
    | select(
        (
          .metadata.labels["combo.build/release-track"] == "release-v1"
          and (
            .metadata.annotations["combo.build/source-sha"]
              // .spec.template.metadata.annotations["combo.build/source-sha"]
          ) != $sourceSha
        )
        or ((.metadata.name // "")
          | test(
              "^(api|runtime|web|worker)-|consumer|sweeper|outbox|cloud-review|(^|[-_.])rt[_-]";
              "i"
            ))
      )
    | "Pod/" + .metadata.name]
  | unique
  | sort
' <<<"$pods_json")
legacy_replica_sets=$(jq -c --arg sourceSha "$SOURCE_SHA" '
  [.items[]
    | select(
        (
          .metadata.labels["combo.build/release-track"] == "release-v1"
          and (
            .metadata.annotations["combo.build/source-sha"]
              // .spec.template.metadata.annotations["combo.build/source-sha"]
          ) != $sourceSha
        )
        or ((.metadata.name // "")
          | test(
              "^(api|runtime|web|worker)-|consumer|sweeper|outbox|cloud-review|(^|[-_.])rt[_-]";
              "i"
            ))
      )
    | "ReplicaSet/" + .metadata.name]
  | unique
  | sort
' <<<"$replica_sets_json")
# Credentials expand only inside PostgreSQL; neither command emits credential values.
# shellcheck disable=SC2016
migration_ledger=$("${K[@]}" -n "$NAMESPACE" exec release-postgres-0 -- sh -euc '
  export PGPASSWORD="$POSTGRES_PASSWORD"
  psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At \
    -c "SELECT filename FROM schema_migrations ORDER BY filename"
' | jq -Rsc 'split("\n") | map(select(length > 0))')
# shellcheck disable=SC2016
database_tables=$("${K[@]}" -n "$NAMESPACE" exec release-postgres-0 -- sh -euc '
  export PGPASSWORD="$POSTGRES_PASSWORD"
  psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At \
    -c "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = '\''public'\'' ORDER BY tablename"
' | jq -Rsc 'split("\n") | map(select(length > 0))')
migration_job=$("${K[@]}" -n "$NAMESPACE" get \
  "job/release-${SOURCE_SHA:0:12}-migrate" -o json |
  jq -c '{
    completionTime: .status.completionTime,
    image: (
      if (.spec.template.spec.containers | length) == 1
        and ((.spec.template.spec.initContainers // []) | length) == 0
        and ((.spec.template.spec.ephemeralContainers // []) | length) == 0
      then .spec.template.spec.containers[0].image
      else ""
      end
    )
  }')
legacy_findings=$(jq -nc \
  --argjson deployments "$deployments" \
  --argjson statefulSets "$stateful_sets" \
  --argjson jobs "$jobs" \
  --argjson services "$services" \
  --argjson ingresses "$ingresses" \
  --argjson configMaps "$config_maps" \
  --argjson databaseTables "$database_tables" \
  --argjson legacyPods "$legacy_pods" \
  --argjson legacyReplicaSets "$legacy_replica_sets" '
    [
      $legacyPods[],
      $legacyReplicaSets[],
      ($deployments[]
        | select(test("^(api|consumer|redis-hot|runtime|sweeper|web|worker|outbox)$")
          or test("cloud-review|consumer|sweeper|outbox"; "i"))
        | "Deployment/" + .),
      ($statefulSets[]
        | select(test("^(postgres|redis-queue|minio)$") or test("cloud-review"; "i"))
        | "StatefulSet/" + .),
      ($jobs[]
        | select(test("^(migrate|minio-init)$")
          or test("cloud-review|consumer|sweeper|outbox"; "i"))
        | "Job/" + .),
      ($services[]
        | select(test("^(api|runtime|web|postgres|redis-queue|redis-hot|minio)$")
          or test("cloud-review|consumer|sweeper|outbox"; "i"))
        | "Service/" + .),
      ($ingresses[]
        | select(test("cloud-review|consumer|sweeper|outbox"; "i"))
        | "Ingress/" + .),
      ($configMaps[]
        | select(test("cloud-review|consumer|sweeper|outbox"; "i"))
        | "ConfigMap/" + .),
      ($databaseTables[]
        | select(
            test("^(rt_chat_|rt_studio_)")
            or test("^(drafts|snapshots|jobs|candidates|capability_versions)$")
          )
        | "DatabaseTable/" + .)
    ]
    | unique
    | sort
  ')

install -d -m 0700 "$(dirname "$OUTPUT")"
temporary="${OUTPUT}.$$"
trap 'rm -f -- "$temporary"' EXIT
jq -n \
  --arg environment "$ENVIRONMENT" \
  --arg namespace "$NAMESPACE" \
  --arg sourceSha "$SOURCE_SHA" \
  --arg collectedAt "$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')" \
  --argjson deployments "$deployments" \
  --argjson statefulSets "$stateful_sets" \
  --argjson jobs "$jobs" \
  --argjson services "$services" \
  --argjson ingresses "$ingresses" \
  --argjson persistentVolumeClaims "$pvcs" \
  --argjson persistentVolumes "$persistent_volumes" \
  --argjson cronJobs "$cron_jobs" \
  --argjson daemonSets "$daemon_sets" \
  --argjson networkPolicies "$network_policies" \
  --argjson roles "$roles" \
  --argjson roleBindings "$role_bindings" \
  --argjson clusterRoleBindings "$cluster_role_bindings" \
  --argjson serviceAccounts "$service_accounts" \
  --argjson configMaps "$config_maps" \
  --argjson pods "$pods" \
  --argjson replicaSets "$replica_sets" \
  --argjson nodePorts "$node_ports" \
  --argjson livePods "$live_pods" \
  --argjson migrationLedger "$migration_ledger" \
  --argjson migrationJob "$migration_job" \
  --argjson databaseTables "$database_tables" \
  --argjson legacyFindings "$legacy_findings" '{
    schemaVersion: 2,
    environment: $environment,
    namespace: $namespace,
    sourceSha: $sourceSha,
    collectedAt: $collectedAt,
    excludedKinds: ["Secret"],
    databaseTables: $databaseTables,
    legacyFindings: $legacyFindings,
    livePods: $livePods,
    migration: {
      head: ($migrationLedger[-1] // null),
      jobCompletionTime: $migrationJob.completionTime,
      jobImage: $migrationJob.image,
      ledger: $migrationLedger
    },
    nodePorts: $nodePorts,
    resources: {
      deployments: $deployments,
      statefulSets: $statefulSets,
      jobs: $jobs,
      services: $services,
      ingresses: $ingresses,
      persistentVolumeClaims: $persistentVolumeClaims,
      persistentVolumes: $persistentVolumes,
      cronJobs: $cronJobs,
      daemonSets: $daemonSets,
      networkPolicies: $networkPolicies,
      roles: $roles,
      roleBindings: $roleBindings,
      clusterRoleBindings: $clusterRoleBindings,
      serviceAccounts: $serviceAccounts,
      configMaps: $configMaps,
      pods: $pods,
      replicaSets: $replicaSets
    }
  }' >"$temporary"
chmod 0600 "$temporary"
mv -fT "$temporary" "$OUTPUT"
trap - EXIT
