// 本机助手脚本渲染（GET /connect/script 下发，`curl ... | sh` 直跑）。
// Python 上传器把本次扫描固化成权限收紧的本地快照，先向服务端准备 bundle 清单，再按缺片续传。
// 每片网络异常后先确认服务端状态，只有未落地才重发，覆盖“响应丢失但服务端已接收”的歧义。
import { BUNDLE_SENTINEL } from './session-parse.js';

/** POSIX shell 单引号安全注入（' → '\''，防注入闭合脚本字符串）。 */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface ConnectScriptParams {
  base: string;
  pairingCode: string;
}

export function renderConnectScript(p: ConnectScriptParams): string {
  return `#!/bin/sh
# Combo 本机助手 — 在本机读取你的对话历史后，把原文【完整上传】到云端，
#   再由云端解析、抹掉手机号/密钥这类隐私信息后用于能力提取。
set -u

COMBO_BASE=${shq(p.base)}
COMBO_CODE=${shq(p.pairingCode)}
export COMBO_BASE COMBO_CODE

if ! command -v python3 >/dev/null 2>&1; then
  printf '[Combo] %s\\n' '这台电脑没有 python3，命令行方式用不了。请回到任务页查看其它方式。' >&2
  exit 1
fi

exec python3 - <<'COMBO_PY'
import hashlib, json, os, pathlib, platform, random, shutil, sys, time, traceback, uuid
import urllib.error, urllib.request

BASE = os.environ['COMBO_BASE'].rstrip('/')
CODE = os.environ['COMBO_CODE']
SENTINEL = ${JSON.stringify(BUNDLE_SENTINEL)}
PROTOCOL_VERSION = 2
PART_LIMIT = 2 * 1024 * 1024  # 兼容旧任务：按 Python 字符数、只在行边界切片
MAX_PARTS = 10000
DEBUG = os.environ.get('COMBO_DEBUG', '') not in ('', '0')
SOURCE_SCOPE = os.environ.get('COMBO_SOURCE_SCOPE', '')
TRANSIENT_HTTP = {408, 425, 429, 500, 502, 503, 504}

def env_float(name, default, low, high):
    try:
        value = float(os.environ.get(name, str(default)))
    except ValueError:
        value = default
    return min(max(value, low), high)

def env_int(name, default, low, high):
    try:
        value = int(os.environ.get(name, str(default)))
    except ValueError:
        value = default
    return min(max(value, low), high)

UPLOAD_TIMEOUT = env_float('COMBO_UPLOAD_TIMEOUT', 300, 0.1, 3600)
MAX_ATTEMPTS = env_int('COMBO_UPLOAD_ATTEMPTS', 4, 1, 8)
RETRY_BASE_DELAY = env_float('COMBO_RETRY_BASE_DELAY', 1, 0, 60)

IS_TTY = sys.stderr.isatty()
ACCENT = '\\x1b[38;2;60;160;95m'
BOLD = '\\x1b[1;38;2;60;160;95m'
DIM = '\\x1b[38;2;150;145;138m'
RESET = '\\x1b[0m'
CLREOL = '\\x1b[K'
_started = time.time()
_last_draw = 0.0
_bar_active = False

def c(color, text):
    return color + text + RESET if IS_TTY else text

def log(message):
    print('[Combo] ' + message, file=sys.stderr)

def dbg(message):
    if DEBUG:
        end_bar()
        print('[Combo debug %s] %s' % (time.strftime('%H:%M:%S'), message), file=sys.stderr)

def draw_bar(label, current, total, suffix, force=False):
    global _last_draw, _bar_active
    if not IS_TTY:
        return
    now = time.time()
    if not force and _bar_active and now - _last_draw < 0.06:
        return
    _last_draw = now
    width = 26
    total = max(total, 1)
    filled = min(max(current * width // total, 0), width)
    sys.stderr.write('\\r  ' + c(BOLD, label) + '  ' + c(ACCENT, '▕')
                     + c(BOLD, '█' * filled) + c(DIM, '░' * (width - filled))
                     + c(ACCENT, '▏') + '  ' + c(DIM, suffix) + CLREOL)
    sys.stderr.flush()
    _bar_active = True

def end_bar():
    global _bar_active
    if _bar_active:
        sys.stderr.write('\\n')
        _bar_active = False

def fail(message):
    end_bar()
    log(message)
    sys.exit(1)

def current_codex_thread_id():
    value = os.environ.get('CODEX_THREAD_ID', '').strip().lower()
    try:
        parsed = uuid.UUID(value)
    except (ValueError, AttributeError):
        fail('无法识别当前 Codex 任务，已在上传前停止。请在原始 Codex 顶层任务中重试。')
    if str(parsed) != value:
        fail('当前 Codex 任务标识格式无效，已在上传前停止。')
    return value

def source_key():
    if SOURCE_SCOPE == 'codex_current_task':
        return hashlib.sha256(current_codex_thread_id().encode('utf-8')).hexdigest()
    if SOURCE_SCOPE == 'history':
        return 'history'
    fail('连接命令缺少有效的数据范围，已在上传前停止。请回到 Combo 获取新的连接命令。')

def elapsed_text():
    seconds = int(time.time() - _started)
    return '%d 分 %d 秒' % (seconds // 60, seconds % 60) if seconds >= 60 else '%d 秒' % seconds

def cache_paths():
    root_env = os.environ.get('COMBO_CACHE_DIR', '')
    root = pathlib.Path(root_env).expanduser() if root_env else pathlib.Path.home() / '.combo' / 'uploads'
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if root.is_symlink():
        fail('上传缓存根目录是符号链接，已停止以保护本机数据。')
    os.chmod(root, 0o700)
    key = hashlib.sha256((BASE + '\\0' + CODE + '\\0' + SOURCE_SCOPE + '\\0' + source_key()).encode('utf-8')).hexdigest()
    return root, root / key

def part_path(cache_dir, index):
    return cache_dir / ('part-%05d.txt' % index)

def atomic_write(path, data):
    tmp = path.with_name(path.name + '.tmp-%d' % os.getpid())
    with open(tmp, 'wb') as handle:
        os.chmod(tmp, 0o600)
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)
    os.chmod(path, 0o600)

def bundle_digest(entries, cache_dir):
    digest = hashlib.sha256()
    for index, entry in enumerate(entries):
        data = part_path(cache_dir, index).read_bytes()
        if len(data) != entry['size'] or hashlib.sha256(data).hexdigest() != entry['sha256']:
            raise ValueError('缓存分片校验失败')
        digest.update(len(data).to_bytes(8, 'big'))
        digest.update(data)
    return digest.hexdigest()

def load_cache(cache_dir):
    manifest_path = cache_dir / 'manifest.json'
    if not manifest_path.is_file():
        return None
    try:
        manifest = json.loads(manifest_path.read_text('utf-8'))
        if (manifest.get('protocolVersion') != PROTOCOL_VERSION
                or manifest.get('base') != BASE
                or manifest.get('sourceScope') != SOURCE_SCOPE
                or manifest.get('sourceKey') != source_key()):
            return None
        entries = manifest.get('parts')
        if not isinstance(entries, list) or not 0 < len(entries) <= MAX_PARTS:
            return None
        if bundle_digest(entries, cache_dir) != manifest.get('bundleId'):
            return None
        return manifest
    except (OSError, ValueError, json.JSONDecodeError, KeyError, TypeError):
        return None

def scan_current_codex_task():
    thread_id = current_codex_thread_id()
    root = pathlib.Path.home() / '.codex' / 'sessions'
    if not root.is_dir() or root.is_symlink():
        fail('找不到安全的 Codex 会话目录，已在上传前停止。')
    try:
        root_real = root.resolve(strict=True)
        candidates = list(root.rglob('rollout-*-' + thread_id + '.jsonl'))
    except OSError:
        fail('无法读取 Codex 会话目录，已在上传前停止。')
    if len(candidates) != 1:
        fail('当前 Codex 任务必须精确匹配一个本地会话文件；本次匹配到 %d 个，已在上传前停止。' % len(candidates))
    path = candidates[0]
    cursor = path
    while cursor != root:
        if cursor.is_symlink():
            fail('当前 Codex 会话路径包含符号链接，已在上传前停止。')
        cursor = cursor.parent
    try:
        resolved = path.resolve(strict=True)
        resolved.relative_to(root_real)
    except (OSError, ValueError):
        fail('当前 Codex 会话文件不在安全目录内，已在上传前停止。')
    if not resolved.is_file():
        fail('当前 Codex 会话不是普通文件，已在上传前停止。')
    try:
        with resolved.open('r', encoding='utf-8', errors='strict') as handle:
            first = next((line.strip() for line in handle if line.strip()), '')
        meta = json.loads(first)
    except (OSError, UnicodeError, json.JSONDecodeError, StopIteration):
        fail('当前 Codex 会话元数据不可读，已在上传前停止。')
    if (not isinstance(meta, dict) or meta.get('type') != 'session_meta'
            or not isinstance(meta.get('payload'), dict)
            or str(meta['payload'].get('id', '')).lower() != thread_id):
        fail('当前 Codex 会话元数据与任务不一致，已在上传前停止。')
    log('已将数据范围锁定为当前 Codex 任务（1 个会话）。')
    return [resolved]

def scan_history():
    roots = [pathlib.Path.home() / '.claude' / 'projects', pathlib.Path.home() / '.codex' / 'sessions']
    files = []
    for root in roots:
        if root.is_dir():
            files.extend(root.rglob('*.jsonl'))
    if not files:
        fail('没扫到可上传的对话历史（~/.claude/projects 或 ~/.codex/sessions 为空）。')
    try:
        limit = int(os.environ.get('COMBO_SESSION_LIMIT', '300'))
    except ValueError:
        limit = 300
    def mtime(path):
        try:
            return path.stat().st_mtime
        except OSError:
            return 0.0
    files.sort(key=mtime, reverse=True)
    found = len(files)
    if limit > 0 and found > limit:
        files = files[:limit]
        log('本机共 %d 个会话，本次只导入最近 %d 个（按修改时间）。要导入全部请设 COMBO_SESSION_LIMIT=0 后重跑本命令。' % (found, limit))
    return files

def scan_files():
    if SOURCE_SCOPE == 'codex_current_task':
        return scan_current_codex_task()
    if SOURCE_SCOPE == 'history':
        return scan_history()
    fail('连接命令缺少有效的数据范围，已在上传前停止。请回到 Combo 获取新的连接命令。')

def build_cache(cache_dir):
    if cache_dir.exists():
        if cache_dir.is_symlink():
            fail('上传缓存目录是符号链接，已停止以保护本机数据。')
        shutil.rmtree(cache_dir)
    cache_dir.mkdir(parents=True, mode=0o700)
    os.chmod(cache_dir, 0o700)
    files = scan_files()
    entries = []
    buffer = []
    size = 0

    def flush():
        nonlocal buffer, size
        if not buffer:
            return
        if len(entries) >= MAX_PARTS:
            raise ValueError('分片超过 10000 片，请减少 COMBO_SESSION_LIMIT 后重试。')
        data = '\\n'.join(buffer).encode('utf-8')
        index = len(entries)
        atomic_write(part_path(cache_dir, index), data)
        entries.append({'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
        buffer, size = [], 0

    def add_line(line):
        nonlocal size
        piece_len = len(line) + 1
        if buffer and size + piece_len > PART_LIMIT:
            flush()
        buffer.append(line)
        size += piece_len

    try:
        for number, path in enumerate(files):
            try:
                text = path.read_text('utf-8', errors='replace')
            except OSError:
                continue
            add_line(SENTINEL)
            for line in text.splitlines():
                add_line(line)
            draw_bar('打包', number + 1, len(files), '%d / %d 会话' % (number + 1, len(files)), number + 1 == len(files))
        flush()
        end_bar()
        if not entries:
            raise ValueError('会话文件都是空的，没有可上传内容。')
        bundle_id = bundle_digest(entries, cache_dir)
        manifest = {
            'protocolVersion': PROTOCOL_VERSION,
            'base': BASE,
            'sourceScope': SOURCE_SCOPE,
            'sourceKey': source_key(),
            'bundleId': bundle_id,
            'totalParts': len(entries),
            'parts': entries,
        }
        atomic_write(cache_dir / 'manifest.json', json.dumps(manifest, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
        return manifest
    except Exception:
        shutil.rmtree(cache_dir, ignore_errors=True)
        raise

class RequestFailure(Exception):
    def __init__(self, message, retryable, status=None, body=b'', headers=None, cause=None):
        super().__init__(message)
        self.retryable = retryable
        self.status = status
        self.body = body
        self.headers = headers or {}
        self.cause = cause

def post_json(path, payload):
    body = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    request = urllib.request.Request(BASE + path, data=body, headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=UPLOAD_TIMEOUT) as response:
            return json.load(response), len(body), response.status, dict(response.headers.items())
    except urllib.error.HTTPError as error:
        try:
            response_body = error.read()
        except Exception:
            response_body = b''
        raise RequestFailure('HTTP %d' % error.code, error.code in TRANSIENT_HTTP,
                             status=error.code, body=response_body,
                             headers=dict(error.headers.items()) if error.headers else {}, cause=error)
    except Exception as error:
        raise RequestFailure(str(error), True, cause=error)

def retry_delay(attempt, failure):
    retry_after = failure.headers.get('Retry-After') or failure.headers.get('retry-after')
    if retry_after:
        try:
            return min(max(float(retry_after), 0), 60)
        except ValueError:
            pass
    return RETRY_BASE_DELAY * (2 ** max(attempt - 1, 0)) + random.uniform(0, RETRY_BASE_DELAY * 0.25)

def user_message(failure):
    try:
        return json.loads(failure.body.decode('utf-8', errors='replace')).get('error', {}).get('userMessage', '')
    except Exception:
        return ''

def request_with_retry(path, payload, label):
    last = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        started = time.time()
        try:
            result = post_json(path, payload)
            dbg('%s 成功：HTTP %d，耗时 %.1f 秒' % (label, result[2], time.time() - started))
            return result
        except RequestFailure as failure:
            last = failure
            dbg('%s 第 %d/%d 次失败：%s，耗时 %.1f 秒' % (label, attempt, MAX_ATTEMPTS, failure, time.time() - started))
            if not failure.retryable or attempt >= MAX_ATTEMPTS:
                raise
            end_bar()
            delay = retry_delay(attempt, failure)
            log('%s网络不稳定，%.1f 秒后重试（%d / %d）。' % (label, delay, attempt + 1, MAX_ATTEMPTS))
            time.sleep(delay)
    raise last

def prepare_payload(manifest, replace_existing):
    return {
        'pairingCode': CODE,
        'protocolVersion': PROTOCOL_VERSION,
        'bundleId': manifest['bundleId'],
        'totalParts': manifest['totalParts'],
        'replaceExisting': replace_existing,
    }

def prepare(manifest, replace_existing, retries=True):
    payload = prepare_payload(manifest, replace_existing)
    response = request_with_retry('/api/v1/connect/prepare', payload, '确认上传状态时') if retries else post_json('/api/v1/connect/prepare', payload)
    return response[0]['data']

def dump_failure(index, total, attempt, body_len, failure):
    end_bar()
    log('—— 上传失败诊断 ——')
    log('时间：%s（本地时钟）' % time.strftime('%Y-%m-%d %H:%M:%S'))
    log('分片：第 %d / %d 片，请求体 %d 字节，已尝试 %d / %d 次' % (index + 1, total, body_len, attempt, MAX_ATTEMPTS))
    log('目标：%s/api/v1/connect/upload；单次超时 %.1f 秒' % (BASE, UPLOAD_TIMEOUT))
    if failure.status:
        log('状态：HTTP %d' % failure.status)
    else:
        log('异常：%s' % failure)
    trace = failure.headers.get('x-trace-id') or failure.headers.get('X-Trace-Id')
    if trace:
        log('Trace ID：' + trace)
    if failure.body:
        log('响应体（前 500 字节）：' + failure.body[:500].decode('utf-8', errors='replace'))
    if DEBUG and failure.cause:
        traceback.print_exception(type(failure.cause), failure.cause, failure.cause.__traceback__, file=sys.stderr)
    log('—— 诊断信息结束，请把以上内容一并反馈 ——')

if IS_TTY:
    sys.stderr.write('\\n  ' + c(BOLD, 'Combo') + c(DIM, '  本机助手 · 上传对话历史') + '\\n')
    sys.stderr.write(c(DIM, '  正在准备可续传的本地快照…') + '\\n')
else:
    log('正在准备可续传的本地快照…')

cache_root, cache_dir = cache_paths()
manifest = load_cache(cache_dir) if cache_dir.exists() and not cache_dir.is_symlink() else None
fresh_cache = manifest is None
try:
    if manifest is None:
        if cache_dir.exists() and not cache_dir.is_symlink():
            log('上次缓存不完整或已损坏，正在安全重建。')
        manifest = build_cache(cache_dir)
    else:
        log('找到上次未完成的安全缓存，将从服务端缺少的位置续传。')
except OSError as error:
    fail('本地缓存写入失败：%s。请检查磁盘空间和 %s 的权限。' % (error, cache_root))
except ValueError as error:
    fail(str(error))

total = manifest['totalParts']
dbg('运行环境：python %s，%s' % (platform.python_version(), platform.platform()))
dbg('快照：%s，共 %d 片，单请求超时 %.1f 秒，最多 %d 次' % (manifest['bundleId'][:12], total, UPLOAD_TIMEOUT, MAX_ATTEMPTS))

try:
    remote = prepare(manifest, fresh_cache)
except RequestFailure as failure:
    message = user_message(failure)
    fail(message or ('无法确认上传状态：%s。安全缓存已保留，重跑命令即可续传。' % failure))

if remote.get('complete'):
    shutil.rmtree(cache_dir, ignore_errors=True)
    log('服务端已确认上传完成，本地缓存已清理。')
    sys.exit(0)

landed = set(remote.get('landedParts', []))
draw_bar('上传', len(landed), total, '%d / %d 片' % (len(landed), total), True)
complete = False
for index in range(total):
    if index in landed:
        continue
    content = part_path(cache_dir, index).read_text('utf-8')
    payload = {
        'pairingCode': CODE,
        'bundleId': manifest['bundleId'],
        'partIndex': index,
        'totalParts': total,
        'content': content,
    }
    body_len = len(json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
    last_failure = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        started = time.time()
        try:
            response, _, status, _ = post_json('/api/v1/connect/upload', payload)
            data = response['data']
            dbg('第 %d/%d 片完成：HTTP %d，耗时 %.1f 秒' % (index + 1, total, status, time.time() - started))
            landed.add(index)
            complete = bool(data.get('complete'))
            break
        except RequestFailure as failure:
            last_failure = failure
            dbg('第 %d/%d 片第 %d 次失败：%s' % (index + 1, total, attempt, failure))
            if not failure.retryable:
                dump_failure(index, total, attempt, body_len, failure)
                fail(user_message(failure) or '上传请求被拒绝，安全缓存已保留。')
            try:
                confirmed = prepare(manifest, False, retries=False)
                confirmed_landed = set(confirmed.get('landedParts', []))
                if confirmed.get('complete'):
                    landed.update(range(total))
                    complete = True
                    break
                if index in confirmed_landed:
                    landed.update(confirmed_landed)
                    break
            except RequestFailure as confirm_failure:
                dbg('失败后的状态确认也未成功：%s' % confirm_failure)
            if attempt >= MAX_ATTEMPTS:
                dump_failure(index, total, attempt, body_len, failure)
                fail('网络多次中断，安全缓存已保留；网络恢复后重跑本命令续传。')
            end_bar()
            delay = retry_delay(attempt, failure)
            log('第 %d / %d 片网络中断，%.1f 秒后重试（%d / %d）。' % (index + 1, total, delay, attempt + 1, MAX_ATTEMPTS))
            time.sleep(delay)
    draw_bar('上传', len(landed), total, '%d / %d 片' % (len(landed), total), complete or len(landed) == total)
    if complete:
        break

if not complete:
    try:
        remote = prepare(manifest, False)
        complete = bool(remote.get('complete'))
    except RequestFailure as failure:
        fail('分片已发完，但最终状态确认失败：%s。安全缓存已保留，重跑命令即可确认。' % failure)

if not complete:
    fail('服务端尚未确认全部分片，安全缓存已保留，重跑命令续传。')

end_bar()
shutil.rmtree(cache_dir, ignore_errors=True)
if IS_TTY:
    sys.stderr.write('  ' + c(ACCENT, '上传完成') + c(DIM, ' · 用时 ' + elapsed_text() + '，云端已自动开始解析与提取，回到任务页查看进度。') + '\\n')
else:
    log('上传完成（用时 %s），云端已自动开始解析与提取。回到任务页查看进度。' % elapsed_text())
COMBO_PY
`;
}

export function renderExpiredScript(): string {
  return `#!/bin/sh
printf '[Combo] %s\\n' '配对码已失效，请回到任务页重新生成连接命令。' >&2
exit 1
`;
}
