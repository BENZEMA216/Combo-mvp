#!/usr/bin/env bash
set -euo pipefail

ENVIRONMENT=''
SOURCE_SHA=''
OUTPUT=''
KUBECONFIG_PATH=${KUBECONFIG:-"$HOME/.kube/config"}

fail() {
  printf 'collect-live-runtime-evidence: %s\n' "$1" >&2
  exit 1
}

usage() {
  fail 'usage: collect-live-runtime-evidence.sh --environment preview|production --source-sha SHA --output FILE'
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
[[ -f "$KUBECONFIG_PATH" && ! -L "$KUBECONFIG_PATH" ]] || fail 'kubeconfig is missing'
for command in kubectl jq install date dirname mktemp sha256sum awk chmod mv rm; do
  command -v "$command" >/dev/null 2>&1 || fail "missing command: $command"
done

K=(kubectl --kubeconfig "$KUBECONFIG_PATH")
PREFIX="release-${SOURCE_SHA:0:12}-"
work=$(mktemp -d)
temporary="${OUTPUT}.$$"
cleanup() {
  rm -f -- "$temporary"
  rm -rf -- "$work"
}
trap cleanup EXIT

deployments_file="$work/deployments.json"
pods_file="$work/pods.json"
migration_job_file="$work/migration-job.json"
migration_pods_file="$work/migration-pods.json"
ledger_file="$work/migration-ledger.txt"

"${K[@]}" -n "$NAMESPACE" get \
  "deployment/${PREFIX}api" \
  "deployment/${PREFIX}worker" \
  "deployment/${PREFIX}runtime" \
  "deployment/${PREFIX}web" \
  -o json >"$deployments_file"
"${K[@]}" -n "$NAMESPACE" get pods \
  -l combo.build/release-track=release-v1 -o json >"$pods_file"
"${K[@]}" -n "$NAMESPACE" get "job/${PREFIX}migrate" -o json >"$migration_job_file"
"${K[@]}" -n "$NAMESPACE" get pods \
  -l "job-name=${PREFIX}migrate" -o json >"$migration_pods_file"

# Credentials expand only inside PostgreSQL. The command emits migration filenames only.
# shellcheck disable=SC2016
"${K[@]}" -n "$NAMESPACE" exec release-postgres-0 -- sh -euc '
  export PGPASSWORD="$POSTGRES_PASSWORD"
  psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At \
    -c "SELECT filename FROM schema_migrations ORDER BY filename"
' >"$ledger_file"
ledger_digest=$(sha256sum "$ledger_file" | awk '{print "sha256:" $1}')

install -d -m 0700 "$(dirname "$OUTPUT")"
jq -n \
  --arg environment "$ENVIRONMENT" \
  --arg namespace "$NAMESPACE" \
  --arg sourceSha "$SOURCE_SHA" \
  --arg prefix "$PREFIX" \
  --arg collectedAt "$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')" \
  --arg ledgerDigest "$ledger_digest" \
  --slurpfile deploymentList "$deployments_file" \
  --slurpfile podList "$pods_file" \
  --slurpfile migrationJob "$migration_job_file" \
  --slurpfile migrationPodList "$migration_pods_file" \
  --rawfile ledgerText "$ledger_file" '
    def image_id:
      sub("^docker-pullable://"; "")
      | sub("^docker://"; "");
    def exact_container_shape:
      (.containers | length) == 1
      and ((.initContainers // []) | length) == 0
      and ((.ephemeralContainers // []) | length) == 0;
    def ready:
      (.spec | exact_container_shape)
      and (.status.containerStatuses | length) == 1
      and all(.status.containerStatuses[]; .ready == true);
    ($ledgerText | split("\n") | map(select(length > 0))) as $ledger
    | {
        schemaVersion: 1,
        environment: $environment,
        namespace: $namespace,
        sourceSha: $sourceSha,
        collectedAt: $collectedAt,
        deployments: (
          [$deploymentList[0].items[]
            | .metadata.name as $name
            | {
                name: $name,
                generation: .metadata.generation,
                observedGeneration: .status.observedGeneration,
                replicas: .spec.replicas,
                readyReplicas: (.status.readyReplicas // 0),
                image: (
                  if (.spec.template.spec | exact_container_shape)
                  then .spec.template.spec.containers[0].image
                  else ""
                  end
                ),
                sourceSha: .spec.template.metadata.annotations["combo.build/source-sha"],
                pods: (
                  [$podList[0].items[]
                    | select(.metadata.deletionTimestamp == null)
                    | select(.metadata.labels.app == $name)
                    | {
                        name: .metadata.name,
                        uid: .metadata.uid,
                        image: (
                          if (.spec | exact_container_shape)
                          then .spec.containers[0].image
                          else ""
                          end
                        ),
                        imageID: ((.status.containerStatuses[0].imageID // "") | image_id),
                        ready: ready
                      }]
                  | sort_by(.name)
                )
              }]
          | sort_by(.name)
        ),
        migration: {
          job: {
            name: $migrationJob[0].metadata.name,
            uid: $migrationJob[0].metadata.uid,
            image: (
              if ($migrationJob[0].spec.template.spec | exact_container_shape)
              then $migrationJob[0].spec.template.spec.containers[0].image
              else ""
              end
            ),
            succeeded: ($migrationJob[0].status.succeeded // 0),
            completionTime: $migrationJob[0].status.completionTime,
            sourceSha:
              $migrationJob[0].spec.template.metadata.annotations["combo.build/source-sha"]
          },
          pod: (
            [$migrationPodList[0].items[]
              | select(.metadata.deletionTimestamp == null)
              | {
                  name: .metadata.name,
                  uid: .metadata.uid,
                  image: (
                    if (.spec | exact_container_shape)
                    then .spec.containers[0].image
                    else ""
                    end
                  ),
                  imageID: ((.status.containerStatuses[0].imageID // "") | image_id),
                  phase: .status.phase,
                  exitCode: .status.containerStatuses[0].state.terminated.exitCode
                }]
            | if length == 1 then .[0] else null end
          ),
          ledger: $ledger,
          head: ($ledger[-1] // null),
          ledgerDigest: $ledgerDigest
        }
      }
  ' >"$temporary"
chmod 0600 "$temporary"
mv -fT "$temporary" "$OUTPUT"
trap - EXIT
rm -rf -- "$work"
