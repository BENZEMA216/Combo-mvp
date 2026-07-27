#!/usr/bin/env python3
"""Shared Kubernetes, mount, and host-listener safety checks for combo-dev.

The program never writes credential material or Kubernetes object bodies to stdout.
Callers place all temporary files in an owner-only directory and turn failures into a
fixed, non-sensitive error message.
"""

from __future__ import annotations

import argparse
import base64
import copy
import json
import os
import re
import ssl
import subprocess
import sys
import urllib.parse
from pathlib import Path
from typing import Any

ALLOWED_KINDS = {
    "Deployment",
    "StatefulSet",
    "Service",
    "PersistentVolumeClaim",
    "Pod",
}
PRODUCTION_RULES = {
    ("apps", "deployments", verb)
    for verb in ("get", "list", "watch")
} | {
    ("apps", "statefulsets", verb)
    for verb in ("get", "list", "watch")
} | {
    ("", resource, verb)
    for resource in ("services", "persistentvolumeclaims", "pods")
    for verb in ("get", "list", "watch")
}
# These review endpoints do not persist objects. Kubernetes commonly grants them to
# every authenticated identity so that an identity can inspect its own permissions.
SELF_REVIEW_RULES = {
    ("authorization.k8s.io", "selfsubjectaccessreviews", "create"),
    ("authorization.k8s.io", "selfsubjectrulesreviews", "create"),
    ("authentication.k8s.io", "selfsubjectreviews", "create"),
}
ALLOWED_NON_RESOURCE_URLS = {
    "/api",
    "/api/*",
    "/apis",
    "/apis/*",
    "/healthz",
    "/livez",
    "/openapi",
    "/openapi/*",
    "/readyz",
    "/version",
    "/version/",
}
MUTATING_VERBS = ("create", "update", "patch", "delete", "deletecollection")
READ_VERBS = ("get", "list", "watch")
REQUIRED_RESOURCES = (
    "deployments.apps",
    "statefulsets.apps",
    "services",
    "persistentvolumeclaims",
    "pods",
)
PLATFORM_IDENTITIES = {
    ("Namespace", None, "combo-preview"),
    ("ClusterRole", None, "combo-dev-control-auditor"),
    ("ClusterRoleBinding", None, "combo-dev-control-auditor"),
    ("StorageClass", None, "combo-dev-bounded"),
    ("PersistentVolume", None, "combo-dev-postgres"),
    ("PersistentVolume", None, "combo-dev-redis-queue"),
    ("PersistentVolume", None, "combo-dev-minio"),
}
PLATFORM_IGNORED_IDENTITIES = {
    ("Role", "combo-preview", "combo-dev-dispatcher"),
    ("RoleBinding", "combo-preview", "combo-dev-dispatcher"),
    ("Role", "combo-preview", "combo-dev-fencer"),
    ("RoleBinding", "combo-preview", "combo-dev-fencer"),
    ("PersistentVolumeClaim", "combo-preview", "data-postgres-0"),
    ("PersistentVolumeClaim", "combo-preview", "data-redis-queue-0"),
    ("PersistentVolumeClaim", "combo-preview", "data-minio-0"),
}
LISTENER_PORTS = {18080: "web", 19000: "s3"}


class SafetyError(RuntimeError):
    pass


def load_json(path: Path) -> Any:
    try:
        with path.open(encoding="utf-8") as stream:
            return json.load(stream)
    except Exception as error:  # Never include data-bearing parser errors.
        raise SafetyError("invalid JSON input") from error


def write_json_private(path: Path, value: Any) -> None:
    temporary = path.with_name(path.name + ".next")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        stream.write("\n")
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def canonical_conditions(conditions: Any) -> list[dict[str, Any]]:
    if not isinstance(conditions, list):
        return []
    result = []
    for condition in conditions:
        if not isinstance(condition, dict):
            continue
        kept = {
            key: copy.deepcopy(condition[key])
            for key in ("type", "status", "reason", "observedGeneration")
            if key in condition
        }
        result.append(kept)
    return sorted(result, key=lambda item: (str(item.get("type", "")), str(item.get("status", ""))))


def canonical_container_state(state: Any) -> dict[str, Any]:
    if not isinstance(state, dict):
        return {}
    result: dict[str, Any] = {}
    waiting = state.get("waiting")
    if isinstance(waiting, dict):
        result["waiting"] = {key: waiting[key] for key in ("reason",) if key in waiting}
    running = state.get("running")
    if isinstance(running, dict):
        result["running"] = {
            key: running[key]
            for key in ("startedAt",)
            if key in running
        }
    terminated = state.get("terminated")
    if isinstance(terminated, dict):
        result["terminated"] = {
            key: terminated[key]
            for key in ("exitCode", "signal", "reason")
            if key in terminated
        }
    return result


def canonical_container_statuses(statuses: Any) -> list[dict[str, Any]]:
    if not isinstance(statuses, list):
        return []
    result = []
    for status in statuses:
        if not isinstance(status, dict):
            continue
        kept = {
            key: copy.deepcopy(status[key])
            for key in ("name", "ready", "restartCount", "started", "image", "imageID")
            if key in status
        }
        kept["state"] = canonical_container_state(status.get("state"))
        kept["lastState"] = canonical_container_state(status.get("lastState"))
        result.append(kept)
    return sorted(result, key=lambda item: str(item.get("name", "")))


def canonical_metadata(metadata: Any) -> dict[str, Any]:
    if not isinstance(metadata, dict):
        raise SafetyError("object metadata is missing")
    name = metadata.get("name")
    if not isinstance(name, str) or not name:
        raise SafetyError("object name is missing")
    result: dict[str, Any] = {
        "name": name,
        "namespace": metadata.get("namespace"),
        "uid": metadata.get("uid"),
        "labels": copy.deepcopy(metadata.get("labels") or {}),
        "annotations": copy.deepcopy(metadata.get("annotations") or {}),
        "finalizers": sorted(metadata.get("finalizers") or []),
        "deleting": metadata.get("deletionTimestamp") is not None,
    }
    owners = []
    for owner in metadata.get("ownerReferences") or []:
        if not isinstance(owner, dict):
            continue
        owners.append(
            {
                key: copy.deepcopy(owner[key])
                for key in ("apiVersion", "kind", "name", "uid", "controller", "blockOwnerDeletion")
                if key in owner
            }
        )
    result["ownerReferences"] = sorted(
        owners,
        key=lambda item: (str(item.get("apiVersion", "")), str(item.get("kind", "")), str(item.get("name", ""))),
    )
    return result


def canonical_readiness(kind: str, status: Any) -> dict[str, Any]:
    if not isinstance(status, dict):
        return {}
    if kind == "Deployment":
        keys = (
            "observedGeneration",
            "replicas",
            "updatedReplicas",
            "readyReplicas",
            "availableReplicas",
            "unavailableReplicas",
            "collisionCount",
        )
        result = {key: copy.deepcopy(status[key]) for key in keys if key in status}
        result["conditions"] = canonical_conditions(status.get("conditions"))
        return result
    if kind == "StatefulSet":
        keys = (
            "observedGeneration",
            "replicas",
            "currentReplicas",
            "updatedReplicas",
            "readyReplicas",
            "availableReplicas",
            "currentRevision",
            "updateRevision",
            "collisionCount",
        )
        result = {key: copy.deepcopy(status[key]) for key in keys if key in status}
        result["conditions"] = canonical_conditions(status.get("conditions"))
        return result
    if kind == "Pod":
        result = {
            key: copy.deepcopy(status[key])
            for key in (
                "phase",
                "nominatedNodeName",
                "hostIP",
                "hostIPs",
                "podIP",
                "podIPs",
                "startTime",
            )
            if key in status
        }
        result["conditions"] = canonical_conditions(status.get("conditions"))
        for key in ("initContainerStatuses", "containerStatuses", "ephemeralContainerStatuses"):
            result[key] = canonical_container_statuses(status.get(key))
        return result
    if kind == "PersistentVolumeClaim":
        result = {
            key: copy.deepcopy(status[key])
            for key in ("phase", "accessModes", "capacity", "allocatedResources")
            if key in status
        }
        result["conditions"] = canonical_conditions(status.get("conditions"))
        return result
    if kind == "Service":
        load_balancer = status.get("loadBalancer")
        return {"loadBalancer": copy.deepcopy(load_balancer)} if isinstance(load_balancer, dict) else {}
    raise SafetyError("unsupported production object kind")


def canonicalize_production(input_path: Path, output_path: Path) -> None:
    payload = load_json(input_path)
    items = payload.get("items") if isinstance(payload, dict) else None
    if not isinstance(items, list):
        raise SafetyError("production inventory is not a list")
    canonical = []
    seen = set()
    for item in items:
        if not isinstance(item, dict):
            raise SafetyError("production inventory contains a non-object")
        kind = item.get("kind")
        if kind not in ALLOWED_KINDS:
            raise SafetyError("production inventory contains a prohibited kind")
        metadata = canonical_metadata(item.get("metadata"))
        identity = (kind, metadata["namespace"], metadata["name"])
        if identity in seen:
            raise SafetyError("production inventory contains a duplicate object")
        seen.add(identity)
        spec = item.get("spec")
        if not isinstance(spec, dict):
            raise SafetyError("production object spec is missing")
        canonical.append(
            {
                "apiVersion": item.get("apiVersion"),
                "kind": kind,
                "metadata": metadata,
                # Preserve the complete API-returned spec. Only volatile metadata and
                # status fields are removed by this canonicalizer.
                "spec": copy.deepcopy(spec),
                "readiness": canonical_readiness(kind, item.get("status")),
            }
        )
    canonical.sort(
        key=lambda item: (
            str(item["kind"]),
            str(item["metadata"].get("namespace") or ""),
            str(item["metadata"]["name"]),
        )
    )
    write_json_private(output_path, {"items": canonical})


def payload_items(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        raise SafetyError("Kubernetes inventory is malformed")
    if payload.get("kind") == "List":
        items = payload.get("items")
    else:
        items = [payload]
    if not isinstance(items, list) or not all(isinstance(item, dict) for item in items):
        raise SafetyError("Kubernetes inventory is malformed")
    return items


def platform_identity(item: dict[str, Any]) -> tuple[str, str | None, str]:
    kind = item.get("kind")
    metadata = item.get("metadata")
    if not isinstance(kind, str) or not isinstance(metadata, dict):
        raise SafetyError("platform object identity is malformed")
    name = metadata.get("name")
    namespace = metadata.get("namespace")
    if not isinstance(name, str) or not name:
        raise SafetyError("platform object name is malformed")
    if namespace is not None and not isinstance(namespace, str):
        raise SafetyError("platform object namespace is malformed")
    return kind, namespace, name


def canonical_platform_metadata(kind: str, metadata: Any) -> dict[str, Any]:
    if not isinstance(metadata, dict):
        raise SafetyError("platform object metadata is malformed")
    name = metadata.get("name")
    if not isinstance(name, str) or not name:
        raise SafetyError("platform object name is malformed")
    labels = copy.deepcopy(metadata.get("labels") or {})
    annotations = copy.deepcopy(metadata.get("annotations") or {})
    if not isinstance(labels, dict) or not isinstance(annotations, dict):
        raise SafetyError("platform metadata maps are malformed")
    if kind == "Namespace":
        labels.pop("kubernetes.io/metadata.name", None)
    annotations.pop("kubectl.kubernetes.io/last-applied-configuration", None)
    if kind == "PersistentVolume":
        annotations.pop("pv.kubernetes.io/bound-by-controller", None)
    finalizers = metadata.get("finalizers") or []
    if not isinstance(finalizers, list) or not all(isinstance(value, str) for value in finalizers):
        raise SafetyError("platform finalizers are malformed")
    ignored_finalizers = {
        "Namespace": {"kubernetes"},
        "PersistentVolume": {"kubernetes.io/pv-protection"},
    }.get(kind, set())
    owners = []
    for owner in metadata.get("ownerReferences") or []:
        if not isinstance(owner, dict):
            raise SafetyError("platform owner reference is malformed")
        owners.append(copy.deepcopy(owner))
    owners.sort(
        key=lambda item: (
            str(item.get("apiVersion", "")),
            str(item.get("kind", "")),
            str(item.get("name", "")),
            str(item.get("uid", "")),
        )
    )
    return {
        "name": name,
        "namespace": metadata.get("namespace"),
        "labels": labels,
        "annotations": annotations,
        "finalizers": sorted(value for value in finalizers if value not in ignored_finalizers),
        "ownerReferences": owners,
        "deleting": metadata.get("deletionTimestamp") is not None,
    }


def canonical_rbac_rules(rules: Any) -> list[dict[str, Any]]:
    if not isinstance(rules, list):
        raise SafetyError("platform RBAC rules are malformed")
    result = []
    for rule in rules:
        if not isinstance(rule, dict):
            raise SafetyError("platform RBAC rule is malformed")
        normalized = copy.deepcopy(rule)
        for key in ("apiGroups", "resources", "resourceNames", "verbs", "nonResourceURLs"):
            if key in normalized:
                values = normalized[key]
                if not isinstance(values, list) or not all(isinstance(value, str) for value in values):
                    raise SafetyError("platform RBAC rule values are malformed")
                normalized[key] = sorted(values)
        result.append(normalized)
    return sorted(result, key=lambda item: json.dumps(item, ensure_ascii=False, sort_keys=True, separators=(",", ":")))


def canonical_platform_object(item: dict[str, Any]) -> dict[str, Any]:
    kind, _, _ = platform_identity(item)
    result = {
        "apiVersion": item.get("apiVersion"),
        "kind": kind,
        "metadata": canonical_platform_metadata(kind, item.get("metadata")),
    }
    for key, value in item.items():
        if key not in {"apiVersion", "kind", "metadata", "status"}:
            result[key] = copy.deepcopy(value)
    if kind == "Namespace":
        spec = result.get("spec")
        if spec is None:
            result["spec"] = {}
        elif isinstance(spec, dict):
            finalizers = spec.pop("finalizers", [])
            if not isinstance(finalizers, list) or not all(isinstance(value, str) for value in finalizers):
                raise SafetyError("namespace finalizers are malformed")
            remaining = sorted(value for value in finalizers if value != "kubernetes")
            if remaining:
                spec["finalizers"] = remaining
        else:
            raise SafetyError("namespace spec is malformed")
    elif kind == "ClusterRole":
        result["rules"] = canonical_rbac_rules(result.get("rules"))
    elif kind == "ClusterRoleBinding":
        subjects = result.get("subjects")
        if not isinstance(subjects, list) or not all(isinstance(subject, dict) for subject in subjects):
            raise SafetyError("platform RBAC subjects are malformed")
        result["subjects"] = sorted(
            subjects,
            key=lambda item: (
                str(item.get("kind", "")),
                str(item.get("apiGroup", "")),
                str(item.get("namespace", "")),
                str(item.get("name", "")),
            ),
        )
    elif kind == "StorageClass":
        parameters = result.get("parameters")
        if parameters is None:
            result["parameters"] = {}
        elif not isinstance(parameters, dict):
            raise SafetyError("platform StorageClass parameters are malformed")
    elif kind == "PersistentVolume":
        spec = result.get("spec")
        if not isinstance(spec, dict):
            raise SafetyError("platform PV spec is malformed")
        claim_ref = spec.get("claimRef")
        if not isinstance(claim_ref, dict):
            raise SafetyError("platform PV claim reference is malformed")
        spec["claimRef"] = {
            key: copy.deepcopy(claim_ref[key])
            for key in ("namespace", "name")
            if key in claim_ref
        }
    return result


def canonical_platform_payload(payload: Any) -> dict[str, Any]:
    retained: dict[tuple[str, str | None, str], dict[str, Any]] = {}
    for item in payload_items(payload):
        identity = platform_identity(item)
        if identity in PLATFORM_IGNORED_IDENTITIES:
            continue
        if identity not in PLATFORM_IDENTITIES or identity in retained:
            raise SafetyError("platform inventory contains an unexpected object")
        retained[identity] = canonical_platform_object(item)
    if set(retained) != PLATFORM_IDENTITIES:
        raise SafetyError("platform inventory is incomplete")
    ordered = [
        retained[identity]
        for identity in sorted(
            retained,
            key=lambda value: (value[0], value[1] or "", value[2]),
        )
    ]
    return {"apiVersion": "v1", "kind": "List", "items": ordered}


def canonicalize_platform(input_path: Path, output_path: Path) -> None:
    write_json_private(output_path, canonical_platform_payload(load_json(input_path)))


def compare_platform(expected_path: Path, live_path: Path) -> None:
    expected = canonical_platform_payload(load_json(expected_path))
    live = canonical_platform_payload(load_json(live_path))
    if expected != live:
        raise SafetyError("live platform differs from the canonical bootstrap contract")


def validate_mount_dependencies(input_path: Path, data_mount: str, storage_pool: str) -> None:
    parent_lexical = os.path.abspath(os.path.normpath(data_mount))
    pool_lexical = os.path.abspath(os.path.normpath(storage_pool))
    parent = os.path.realpath(parent_lexical)
    pool = os.path.realpath(pool_lexical)
    if not os.path.isabs(data_mount) or not os.path.isabs(storage_pool) or pool == parent:
        raise SafetyError("mount dependency contract is malformed")
    try:
        dependencies = input_path.read_text(encoding="utf-8").split()
    except Exception as error:
        raise SafetyError("mount dependency inventory is unreadable") from error
    parent_seen = False
    for dependency in dependencies:
        if not os.path.isabs(dependency):
            raise SafetyError("mount dependency is not absolute")
        lexical = os.path.abspath(os.path.normpath(dependency))
        normalized = os.path.realpath(lexical)
        if (
            lexical == pool_lexical
            or os.path.commonpath((lexical, pool_lexical)) == pool_lexical
            or normalized == pool
            or os.path.commonpath((normalized, pool)) == pool
        ):
            raise SafetyError("k3s depends on the development storage pool")
        if normalized == parent:
            parent_seen = True
    if not parent_seen:
        raise SafetyError("k3s does not depend on the parent data mount")


def parse_listener_endpoint(endpoint: str) -> tuple[str, int]:
    match = re.fullmatch(r"\[([^]]+)]:(\d+)", endpoint)
    if match:
        address, port = match.groups()
    else:
        try:
            address, port = endpoint.rsplit(":", 1)
        except ValueError as error:
            raise SafetyError("listener endpoint is malformed") from error
    if not port.isdigit() or not (0 < int(port) < 65536):
        raise SafetyError("listener port is malformed")
    return address, int(port)


def validate_listeners(input_path: Path, web_pid: int, s3_pid: int) -> None:
    expected_pids = {18080: web_pid, 19000: s3_pid}
    if any(pid <= 0 for pid in expected_pids.values()):
        raise SafetyError("forwarder process identity is missing")
    found: dict[int, list[tuple[str, set[int]]]] = {port: [] for port in LISTENER_PORTS}
    try:
        lines = input_path.read_text(encoding="utf-8").splitlines()
    except Exception as error:
        raise SafetyError("listener inventory is unreadable") from error
    for line in lines:
        fields = line.split()
        if len(fields) < 4:
            continue
        address, port = parse_listener_endpoint(fields[3])
        if port not in found:
            continue
        pids = {int(value) for value in re.findall(r"\bpid=(\d+)\b", line)}
        found[port].append((address, pids))
    for port, listeners in found.items():
        if listeners != [("127.0.0.1", {expected_pids[port]})]:
            raise SafetyError("development listener set is not the exact loopback contract")


def run_json(command: list[str], output: Path, *, stdin: Path | None = None) -> Any:
    with output.open("wb") as target:
        source = stdin.open("rb") if stdin else None
        try:
            completed = subprocess.run(
                command,
                stdin=source if source is not None else subprocess.DEVNULL,
                stdout=target,
                stderr=subprocess.DEVNULL,
                check=False,
                timeout=45,
            )
        finally:
            if source is not None:
                source.close()
    os.chmod(output, 0o600)
    if completed.returncode != 0:
        raise SafetyError("Kubernetes observer audit request failed")
    return load_json(output)


def run_can_i(kubectl: str, kubeconfig: Path, expected: bool, verb: str, resource: str, namespace: str | None) -> None:
    command = [kubectl, "--request-timeout=30s", "--kubeconfig", str(kubeconfig), "auth", "can-i", "-q", verb, resource]
    if namespace is None:
        command.append("--all-namespaces")
    else:
        command.extend(("--namespace", namespace))
    completed = subprocess.run(
        command,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
        timeout=40,
    )
    if expected and completed.returncode != 0:
        raise SafetyError("observer is missing an allowlisted read permission")
    if not expected and completed.returncode != 1:
        raise SafetyError("observer has a prohibited permission or the denial probe failed")


def cluster_trust(config: Any) -> tuple[str, bytes, str | None]:
    clusters = config.get("clusters") if isinstance(config, dict) else None
    if not isinstance(clusters, list) or len(clusters) != 1 or not isinstance(clusters[0], dict):
        raise SafetyError("kubeconfig cluster is malformed")
    cluster = clusters[0].get("cluster")
    if not isinstance(cluster, dict) or not set(cluster) <= {
        "server",
        "certificate-authority-data",
        "tls-server-name",
        "disable-compression",
    }:
        raise SafetyError("kubeconfig cluster trust contains unsupported fields")
    server = cluster.get("server")
    ca_data = cluster.get("certificate-authority-data")
    tls_server_name = cluster.get("tls-server-name")
    if not isinstance(server, str) or not isinstance(ca_data, str):
        raise SafetyError("kubeconfig cluster trust is incomplete")
    parsed = urllib.parse.urlsplit(server)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        raise SafetyError("kubeconfig server is not a fixed HTTPS endpoint")
    if tls_server_name is not None and not isinstance(tls_server_name, str):
        raise SafetyError("kubeconfig TLS server name is malformed")
    try:
        ca_bytes = base64.b64decode(ca_data, validate=True)
    except Exception as error:
        raise SafetyError("kubeconfig CA encoding is malformed") from error
    if not ca_bytes.startswith(b"-----BEGIN CERTIFICATE-----"):
        raise SafetyError("kubeconfig CA is not a certificate")
    return server, ca_bytes, tls_server_name


def audit_cluster_trust(kubectl: str, kubeconfig: Path, work: Path) -> tuple[str, bytes, str | None]:
    raw_path = work / "audit-config.json"
    config = run_json(
        [
            kubectl,
            "--kubeconfig",
            str(kubeconfig),
            "config",
            "view",
            "--raw",
            "--flatten",
            "--minify",
            "-o",
            "json",
        ],
        raw_path,
    )
    try:
        return cluster_trust(config)
    finally:
        try:
            raw_path.unlink()
        except FileNotFoundError:
            pass


def embedded_certificate_identity(
    kubectl: str, kubeconfig: Path, work: Path
) -> tuple[str, set[str], tuple[str, bytes, str | None]]:
    raw_path = work / "observer-config.json"
    config = run_json(
        [
            kubectl,
            "--kubeconfig",
            str(kubeconfig),
            "config",
            "view",
            "--raw",
            "--flatten",
            "--minify",
            "-o",
            "json",
        ],
        raw_path,
    )
    try:
        if not isinstance(config, dict):
            raise SafetyError("observer kubeconfig is malformed")
        users = config.get("users")
        contexts = config.get("contexts")
        clusters = config.get("clusters")
        if not (isinstance(users, list) and len(users) == 1 and isinstance(contexts, list) and len(contexts) == 1 and isinstance(clusters, list) and len(clusters) == 1):
            raise SafetyError("observer kubeconfig is not single-context")
        trust = cluster_trust(config)
        user = users[0].get("user") if isinstance(users[0], dict) else None
        if not isinstance(user, dict) or set(user) != {"client-certificate-data", "client-key-data"}:
            raise SafetyError("observer must use only an embedded client certificate")
        certificate_data = user.get("client-certificate-data")
        key_data = user.get("client-key-data")
        if not isinstance(certificate_data, str) or not isinstance(key_data, str):
            raise SafetyError("observer credential data is malformed")
        try:
            certificate = base64.b64decode(certificate_data, validate=True)
            private_key = base64.b64decode(key_data, validate=True)
        except Exception as error:
            raise SafetyError("observer credential encoding is malformed") from error
        if not certificate.startswith(b"-----BEGIN CERTIFICATE-----") or b"PRIVATE KEY" not in private_key:
            raise SafetyError("observer credential type is invalid")
        certificate_path = work / "observer.crt"
        with certificate_path.open("wb") as stream:
            stream.write(certificate)
        os.chmod(certificate_path, 0o600)
        try:
            decoded = ssl._ssl._test_decode_cert(str(certificate_path))  # type: ignore[attr-defined]
        except Exception as error:
            raise SafetyError("observer certificate is not parseable") from error
        subject = decoded.get("subject")
        common_names: list[str] = []
        organizations: list[str] = []
        if isinstance(subject, tuple):
            for rdn in subject:
                if not isinstance(rdn, tuple):
                    continue
                for attribute in rdn:
                    if not (isinstance(attribute, tuple) and len(attribute) == 2 and isinstance(attribute[1], str)):
                        continue
                    if attribute[0] == "commonName":
                        common_names.append(attribute[1])
                    elif attribute[0] == "organizationName":
                        organizations.append(attribute[1])
        if len(common_names) != 1 or not common_names[0] or any(not value for value in organizations):
            raise SafetyError("observer certificate subject is ambiguous")
        return common_names[0], set(organizations) | {"system:authenticated"}, trust
    finally:
        # The raw config contains credential material and must not outlive parsing.
        try:
            raw_path.unlink()
        except FileNotFoundError:
            pass


def binding_matches(binding: Any, username: str, groups: set[str]) -> bool:
    if not isinstance(binding, dict):
        return False
    subjects = binding.get("subjects") or []
    if not isinstance(subjects, list):
        raise SafetyError("RBAC binding subjects are malformed")
    for subject in subjects:
        if not isinstance(subject, dict):
            raise SafetyError("RBAC binding subject is malformed")
        kind = subject.get("kind")
        name = subject.get("name")
        if kind in {"User", "Group", "ServiceAccount"} and not isinstance(name, str):
            raise SafetyError("RBAC binding subject name is malformed")
        if kind == "User" and name == username:
            return True
        if kind == "Group" and name in groups:
            return True
        if kind == "ServiceAccount" and isinstance(subject.get("namespace"), str):
            service_account_user = f"system:serviceaccount:{subject['namespace']}:{name}"
            if name and service_account_user == username:
                return True
    return False


def expanded_resource_rules(rules: Any) -> tuple[set[tuple[str, str, str]], set[tuple[str, str]]]:
    if rules is None:
        return set(), set()
    if not isinstance(rules, list):
        raise SafetyError("RBAC rules are malformed")
    resources: set[tuple[str, str, str]] = set()
    non_resources: set[tuple[str, str]] = set()
    for rule in rules:
        if not isinstance(rule, dict):
            raise SafetyError("RBAC rule is malformed")
        verbs = rule.get("verbs") or []
        api_groups = rule.get("apiGroups") or [""]
        names = rule.get("resources") or []
        urls = rule.get("nonResourceURLs") or []
        resource_names = rule.get("resourceNames") or []
        if not all(isinstance(value, str) for value in verbs + api_groups + names + urls + resource_names):
            raise SafetyError("RBAC rule contains a non-string value")
        if "*" in verbs or "*" in api_groups or "*" in names or "*" in resource_names:
            raise SafetyError("observer RBAC contains a wildcard rule")
        if resource_names:
            raise SafetyError("observer RBAC contains a resource-name exception")
        if names and urls:
            raise SafetyError("observer RBAC mixes resource and non-resource rules")
        for api_group in api_groups:
            for resource in names:
                for verb in verbs:
                    resources.add((api_group, resource, verb))
        for url in urls:
            for verb in verbs:
                non_resources.add((url, verb))
    return resources, non_resources


def validate_non_resource_rules(rules: set[tuple[str, str]]) -> None:
    for url, verb in rules:
        if verb != "get" or url not in ALLOWED_NON_RESOURCE_URLS:
            raise SafetyError("observer has a prohibited non-resource permission")


def index_named(items: Any, kind: str, namespaced: bool) -> dict[Any, Any]:
    if not isinstance(items, list):
        raise SafetyError("RBAC inventory is malformed")
    result = {}
    for item in items:
        if not isinstance(item, dict) or item.get("kind") != kind:
            raise SafetyError("RBAC inventory contains an unexpected kind")
        metadata = item.get("metadata")
        if not isinstance(metadata, dict) or not isinstance(metadata.get("name"), str):
            raise SafetyError("RBAC inventory metadata is malformed")
        key: Any = (metadata.get("namespace"), metadata["name"]) if namespaced else metadata["name"]
        if key in result:
            raise SafetyError("RBAC inventory contains a duplicate")
        result[key] = item
    return result


def validate_bindings(
    username: str,
    groups: set[str],
    production_namespace: str,
    roles_payload: Any,
    rolebindings_payload: Any,
    clusterroles_payload: Any,
    clusterbindings_payload: Any,
) -> None:
    roles = index_named(roles_payload.get("items") if isinstance(roles_payload, dict) else None, "Role", True)
    rolebindings = index_named(rolebindings_payload.get("items") if isinstance(rolebindings_payload, dict) else None, "RoleBinding", True)
    clusterroles = index_named(clusterroles_payload.get("items") if isinstance(clusterroles_payload, dict) else None, "ClusterRole", False)
    clusterbindings = index_named(clusterbindings_payload.get("items") if isinstance(clusterbindings_payload, dict) else None, "ClusterRoleBinding", False)

    production_effective: set[tuple[str, str, str]] = set()
    for binding in rolebindings.values():
        if not binding_matches(binding, username, groups):
            continue
        metadata = binding["metadata"]
        namespace = metadata.get("namespace")
        role_ref = binding.get("roleRef")
        if not isinstance(namespace, str) or not isinstance(role_ref, dict):
            raise SafetyError("observer RoleBinding is malformed")
        role_kind = role_ref.get("kind")
        role_name = role_ref.get("name")
        if not isinstance(role_name, str):
            raise SafetyError("observer RoleBinding roleRef is malformed")
        if role_kind == "Role":
            role = roles.get((namespace, role_name))
        elif role_kind == "ClusterRole":
            role = clusterroles.get(role_name)
        else:
            raise SafetyError("observer RoleBinding has an unsupported roleRef")
        if role is None:
            raise SafetyError("observer RoleBinding roleRef is unresolved")
        resources, non_resources = expanded_resource_rules(role.get("rules"))
        if non_resources:
            raise SafetyError("observer RoleBinding contains non-resource permissions")
        if namespace != production_namespace:
            if resources:
                raise SafetyError("observer has resource access outside production")
        else:
            if not resources <= PRODUCTION_RULES:
                raise SafetyError("observer production RoleBinding exceeds the allowlist")
            production_effective |= resources

    cluster_effective: set[tuple[str, str, str]] = set()
    for binding in clusterbindings.values():
        if not binding_matches(binding, username, groups):
            continue
        role_ref = binding.get("roleRef")
        if not isinstance(role_ref, dict) or role_ref.get("kind") != "ClusterRole" or not isinstance(role_ref.get("name"), str):
            raise SafetyError("observer ClusterRoleBinding is malformed")
        role = clusterroles.get(role_ref["name"])
        if role is None:
            raise SafetyError("observer ClusterRoleBinding roleRef is unresolved")
        resources, non_resources = expanded_resource_rules(role.get("rules"))
        if not resources <= SELF_REVIEW_RULES:
            raise SafetyError("observer has a prohibited cluster resource permission")
        validate_non_resource_rules(non_resources)
        cluster_effective |= resources

    if production_effective != PRODUCTION_RULES:
        raise SafetyError("observer production allowlist is not exact")
    if not cluster_effective <= SELF_REVIEW_RULES:
        raise SafetyError("observer self-review permission set is invalid")


def validate_self_subject_rules(payload: Any, namespace: str, production_namespace: str) -> None:
    status = payload.get("status") if isinstance(payload, dict) else None
    if not isinstance(status, dict) or status.get("incomplete") is True or status.get("evaluationError"):
        raise SafetyError("observer effective-rule review is incomplete")
    resources, non_resources = expanded_resource_rules(status.get("resourceRules") or [])
    validate_non_resource_rules(non_resources)
    allowed = SELF_REVIEW_RULES | (PRODUCTION_RULES if namespace == production_namespace else set())
    if not resources <= allowed:
        raise SafetyError("observer effective rules exceed the allowlist")
    production_part = resources & PRODUCTION_RULES
    if namespace == production_namespace and production_part != PRODUCTION_RULES:
        raise SafetyError("observer effective production reads are incomplete")
    if namespace != production_namespace and production_part:
        raise SafetyError("observer has production-type access outside production")


def verify_observer(
    audit_kubeconfig: Path,
    observer_kubeconfig: Path,
    production_namespace: str,
    work: Path,
) -> None:
    kubectl = "kubectl"
    work.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(work, 0o700)
    username, groups, observer_trust = embedded_certificate_identity(kubectl, observer_kubeconfig, work)
    if observer_trust != audit_cluster_trust(kubectl, audit_kubeconfig, work):
        raise SafetyError("observer and auditor do not use the same cluster trust")

    inventories: dict[str, Any] = {}
    commands = {
        "namespaces": ["get", "namespaces", "-o", "json"],
        "roles": ["get", "roles.rbac.authorization.k8s.io", "--all-namespaces", "-o", "json"],
        "rolebindings": ["get", "rolebindings.rbac.authorization.k8s.io", "--all-namespaces", "-o", "json"],
        "clusterroles": ["get", "clusterroles.rbac.authorization.k8s.io", "-o", "json"],
        "clusterbindings": ["get", "clusterrolebindings.rbac.authorization.k8s.io", "-o", "json"],
    }
    for name, suffix in commands.items():
        inventories[name] = run_json(
            [kubectl, "--request-timeout=30s", "--kubeconfig", str(audit_kubeconfig), *suffix],
            work / f"{name}.json",
        )

    validate_bindings(
        username,
        groups,
        production_namespace,
        inventories["roles"],
        inventories["rolebindings"],
        inventories["clusterroles"],
        inventories["clusterbindings"],
    )

    namespace_items = inventories["namespaces"].get("items") if isinstance(inventories["namespaces"], dict) else None
    if not isinstance(namespace_items, list):
        raise SafetyError("namespace inventory is malformed")
    namespaces = []
    for item in namespace_items:
        metadata = item.get("metadata") if isinstance(item, dict) else None
        name = metadata.get("name") if isinstance(metadata, dict) else None
        if not isinstance(name, str) or not re.fullmatch(r"[a-z0-9]([-a-z0-9]*[a-z0-9])?", name):
            raise SafetyError("namespace inventory contains an invalid name")
        namespaces.append(name)
    if len(namespaces) != len(set(namespaces)) or production_namespace not in namespaces:
        raise SafetyError("production namespace inventory is invalid")

    request = work / "self-subject-rules-request.json"
    response = work / "self-subject-rules-response.json"
    for namespace in sorted(namespaces):
        write_json_private(
            request,
            {
                "apiVersion": "authorization.k8s.io/v1",
                "kind": "SelfSubjectRulesReview",
                "spec": {"namespace": namespace},
            },
        )
        payload = run_json(
            [
                kubectl,
                "--request-timeout=30s",
                "--kubeconfig",
                str(observer_kubeconfig),
                "create",
                "--raw",
                "/apis/authorization.k8s.io/v1/selfsubjectrulesreviews",
                "-f",
                "-",
            ],
            response,
            stdin=request,
        )
        validate_self_subject_rules(payload, namespace, production_namespace)

    for resource in REQUIRED_RESOURCES:
        for verb in READ_VERBS:
            run_can_i(kubectl, observer_kubeconfig, True, verb, resource, production_namespace)
    for namespace in sorted(namespaces):
        for verb in READ_VERBS + MUTATING_VERBS:
            run_can_i(kubectl, observer_kubeconfig, False, verb, "secrets", namespace)
        for resource in REQUIRED_RESOURCES:
            for verb in MUTATING_VERBS:
                run_can_i(kubectl, observer_kubeconfig, False, verb, resource, namespace)
    for resource in (
        "namespaces",
        "nodes",
        "persistentvolumes",
        "storageclasses.storage.k8s.io",
        "clusterroles.rbac.authorization.k8s.io",
        "clusterrolebindings.rbac.authorization.k8s.io",
        "customresourcedefinitions.apiextensions.k8s.io",
    ):
        for verb in MUTATING_VERBS:
            run_can_i(kubectl, observer_kubeconfig, False, verb, resource, None)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(add_help=False)
    subparsers = parser.add_subparsers(dest="command", required=True)
    canonical = subparsers.add_parser("canonicalize-production", add_help=False)
    canonical.add_argument("--input", required=True, type=Path)
    canonical.add_argument("--output", required=True, type=Path)
    platform = subparsers.add_parser("canonicalize-platform", add_help=False)
    platform.add_argument("--input", required=True, type=Path)
    platform.add_argument("--output", required=True, type=Path)
    compare = subparsers.add_parser("compare-platform", add_help=False)
    compare.add_argument("--expected", required=True, type=Path)
    compare.add_argument("--live", required=True, type=Path)
    mounts = subparsers.add_parser("validate-mount-dependencies", add_help=False)
    mounts.add_argument("--input", required=True, type=Path)
    mounts.add_argument("--data-mount", required=True)
    mounts.add_argument("--storage-pool", required=True)
    listeners = subparsers.add_parser("validate-listeners", add_help=False)
    listeners.add_argument("--input", required=True, type=Path)
    listeners.add_argument("--web-pid", required=True, type=int)
    listeners.add_argument("--s3-pid", required=True, type=int)
    observer = subparsers.add_parser("verify-observer", add_help=False)
    observer.add_argument("--audit-kubeconfig", required=True, type=Path)
    observer.add_argument("--observer-kubeconfig", required=True, type=Path)
    observer.add_argument("--production-namespace", required=True)
    observer.add_argument("--work-dir", required=True, type=Path)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        if args.command == "canonicalize-production":
            canonicalize_production(args.input, args.output)
        elif args.command == "canonicalize-platform":
            canonicalize_platform(args.input, args.output)
        elif args.command == "compare-platform":
            compare_platform(args.expected, args.live)
        elif args.command == "validate-mount-dependencies":
            validate_mount_dependencies(args.input, args.data_mount, args.storage_pool)
        elif args.command == "validate-listeners":
            validate_listeners(args.input, args.web_pid, args.s3_pid)
        elif args.command == "verify-observer":
            verify_observer(
                args.audit_kubeconfig,
                args.observer_kubeconfig,
                args.production_namespace,
                args.work_dir,
            )
        else:  # pragma: no cover
            raise SafetyError("unknown command")
    except Exception:
        # Keep output fixed: object data, subject names, and credential material must
        # never leak through an exception or subprocess error.
        print("combo-dev production safety check failed", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
