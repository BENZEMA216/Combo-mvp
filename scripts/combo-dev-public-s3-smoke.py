#!/usr/bin/env python3
"""Bounded public MinIO SigV4 smoke without exposing credentials or signed URLs."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import hmac
import os
import re
import secrets
import ssl
import stat
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

CONFIG_PATH = Path("/etc/combo-dev/combo-dev.env")
PUBLIC_ENDPOINT = "https://test-s3.43-160-242-46.sslip.io"
PUBLIC_HOST = "test-s3.43-160-242-46.sslip.io"
REGION = "us-east-1"
SERVICE = "s3"
BUCKET = "combo-raw"
SHA_RE = re.compile(r"[0-9a-f]{40}")
INTEGER_RE = re.compile(r"[1-9][0-9]*")


class SmokeError(RuntimeError):
    pass


def load_credentials() -> tuple[str, str]:
    descriptor = -1
    try:
        descriptor = os.open(CONFIG_PATH, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
        file_stat = os.fstat(descriptor)
        if (
            not stat.S_ISREG(file_stat.st_mode)
            or file_stat.st_uid != 0
            or file_stat.st_gid != 0
            or file_stat.st_mode & 0o077
            or file_stat.st_nlink != 1
        ):
            raise SmokeError("configuration boundary is invalid")
        values: dict[str, str] = {}
        with os.fdopen(descriptor, encoding="utf-8") as stream:
            descriptor = -1
            for raw in stream:
                line = raw.rstrip("\n")
                if not line or line.lstrip().startswith("#"):
                    continue
                if "=" not in line:
                    raise SmokeError("configuration is malformed")
                key, value = line.split("=", 1)
                if not key or key in values or not value:
                    raise SmokeError("configuration is malformed")
                values[key] = value
    except SmokeError:
        raise
    except Exception as error:
        raise SmokeError("configuration is unreadable") from error
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    access_key = values.get("S3_ACCESS_KEY", "")
    secret_key = values.get("S3_SECRET_KEY", "")
    if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{2,63}", access_key) is None or not secret_key:
        raise SmokeError("application object-store identity is invalid")
    return access_key, secret_key


def signing_key(secret_key: str, date_stamp: str) -> bytes:
    date_key = hmac.new(f"AWS4{secret_key}".encode(), date_stamp.encode(), hashlib.sha256).digest()
    region_key = hmac.new(date_key, REGION.encode(), hashlib.sha256).digest()
    service_key = hmac.new(region_key, SERVICE.encode(), hashlib.sha256).digest()
    return hmac.new(service_key, b"aws4_request", hashlib.sha256).digest()


def quote(value: str) -> str:
    return urllib.parse.quote(value, safe="-_.~")


def presigned_url(method: str, key: str, access_key: str, secret_key: str, now: dt.datetime) -> str:
    date_stamp = now.strftime("%Y%m%d")
    timestamp = now.strftime("%Y%m%dT%H%M%SZ")
    scope = f"{date_stamp}/{REGION}/{SERVICE}/aws4_request"
    canonical_uri = f"/{quote(BUCKET)}/" + "/".join(quote(part) for part in key.split("/"))
    params = {
        "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
        "X-Amz-Credential": f"{access_key}/{scope}",
        "X-Amz-Date": timestamp,
        "X-Amz-Expires": "60",
        "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD",
        "X-Amz-SignedHeaders": "host",
    }
    canonical_query = "&".join(
        f"{quote(name)}={quote(value)}" for name, value in sorted(params.items())
    )
    canonical_request = "\n".join(
        [method, canonical_uri, canonical_query, f"host:{PUBLIC_HOST}\n", "host", "UNSIGNED-PAYLOAD"]
    )
    string_to_sign = "\n".join(
        [
            "AWS4-HMAC-SHA256",
            timestamp,
            scope,
            hashlib.sha256(canonical_request.encode()).hexdigest(),
        ]
    )
    signature = hmac.new(
        signing_key(secret_key, date_stamp), string_to_sign.encode(), hashlib.sha256
    ).hexdigest()
    return f"{PUBLIC_ENDPOINT}{canonical_uri}?{canonical_query}&X-Amz-Signature={signature}"


def request(opener: urllib.request.OpenerDirector, method: str, url: str, body: bytes | None = None) -> bytes:
    request_value = urllib.request.Request(url, data=body, method=method)
    try:
        with opener.open(request_value, timeout=15) as response:
            if response.status not in ({200} if method in {"PUT", "GET"} else {200, 204}):
                raise SmokeError("public object-store response is invalid")
            data = response.read(1024)
            if response.read(1):
                raise SmokeError("public object-store response exceeded its bound")
            return data
    except SmokeError:
        raise
    except (OSError, urllib.error.URLError, urllib.error.HTTPError) as error:
        raise SmokeError("public object-store request failed") from error


def run(revision: str, run_id: str, run_attempt: str) -> None:
    if os.geteuid() != 0:
        raise SmokeError("public object-store smoke must run as root")
    if (
        SHA_RE.fullmatch(revision) is None
        or INTEGER_RE.fullmatch(run_id) is None
        or INTEGER_RE.fullmatch(run_attempt) is None
    ):
        raise SmokeError("workflow identity is malformed")
    access_key, secret_key = load_credentials()
    suffix = secrets.token_hex(12)
    key = f".combo-public-smoke/{revision}/{run_id}-{run_attempt}-{suffix}.bin"
    body = secrets.token_bytes(64)
    context = ssl.create_default_context()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context))
    uploaded = False
    primary_error: Exception | None = None
    try:
        now = dt.datetime.now(dt.timezone.utc)
        request(opener, "PUT", presigned_url("PUT", key, access_key, secret_key, now), body)
        uploaded = True
        received = request(
            opener,
            "GET",
            presigned_url("GET", key, access_key, secret_key, dt.datetime.now(dt.timezone.utc)),
        )
        if not hmac.compare_digest(received, body):
            raise SmokeError("public object-store payload mismatch")
    except Exception as error:  # Keep credentials, URLs, and server bodies out of logs.
        primary_error = error
    finally:
        if uploaded:
            try:
                request(
                    opener,
                    "DELETE",
                    presigned_url(
                        "DELETE", key, access_key, secret_key, dt.datetime.now(dt.timezone.utc)
                    ),
                )
            except Exception as error:
                if primary_error is None:
                    primary_error = error
        access_key = ""
        secret_key = ""
        body = b""
    if primary_error is not None:
        raise SmokeError("public object-store SigV4 smoke failed") from primary_error


def main() -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--workflow-run-id", required=True)
    parser.add_argument("--workflow-run-attempt", required=True)
    try:
        args = parser.parse_args()
        run(args.revision, args.workflow_run_id, args.workflow_run_attempt)
    except Exception:
        print("[combo-dev-public-s3-smoke] BLOCKED: public SigV4 validation failed", file=sys.stderr)
        return 2
    print("[combo-dev-public-s3-smoke] PASS operation=put-get-delete")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
