// 最简登录页：自包含 HTML（内联 CSS/JS，无框架无构建）。OTP 两个接口的 fetch 走同源
// 相对路径；登录成功跳 next（只允许同站相对路径）。

/**
 * next 参数收敛：只接受以单个 / 开头的站内路径。协议相对（//）、反斜杠、
 * 控制字符与空白一律回落 /，防开放跳转。
 */
export function sanitizeLoginNext(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return '/';
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f || value[index] === '\\') return '/';
  }
  return value;
}

export function loginPageHtml(next: string): string {
  // HTML parser 会在 JavaScript 字符串语义之前识别 </script>。JSON 序列化后继续
  // 转义所有能改变 HTML/脚本边界的字符，确保 next 只能成为字符串数据。
  const nextJson = JSON.stringify(next).replace(/[<>&\u2028\u2029]/g, (character) => {
    switch (character) {
      case '<':
        return '\\u003c';
      case '>':
        return '\\u003e';
      case '&':
        return '\\u0026';
      case '\u2028':
        return '\\u2028';
      case '\u2029':
        return '\\u2029';
      default:
        throw new Error('unreachable inline script escape');
    }
  });
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>登录 · Combo</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f5f5f4; font-family: system-ui, -apple-system, sans-serif; }
  main { width: 320px; padding: 32px; background: #fff; border-radius: 12px; box-shadow: 0 1px 4px rgb(0 0 0 / 0.08); }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p.hint { font-size: 13px; color: #78716c; margin: 0 0 20px; }
  label { display: block; font-size: 13px; color: #44403c; margin: 12px 0 4px; }
  input { width: 100%; box-sizing: border-box; padding: 9px 10px; font-size: 15px; border: 1px solid #d6d3d1; border-radius: 8px; }
  button { width: 100%; margin-top: 14px; padding: 10px; font-size: 15px; color: #fff; background: #1c1917; border: 0; border-radius: 8px; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: default; }
  #code-row { display: none; }
  #error { display: none; margin-top: 12px; font-size: 13px; color: #b91c1c; }
</style>
</head>
<body>
<main>
  <h1>登录</h1>
  <p class="hint">验证码将发送到你的邮箱。</p>
  <form id="login-form">
    <label for="email">邮箱</label>
    <input id="email" name="email" type="email" autocomplete="email" required>
    <div id="code-row">
      <label for="code">验证码</label>
      <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6">
    </div>
    <button id="send" type="button">发送验证码</button>
    <button id="submit" type="submit" style="display:none">登录</button>
    <p id="error" role="alert"></p>
  </form>
</main>
<script>
(function () {
  var NEXT = ${nextJson};
  var email = document.getElementById('email');
  var codeRow = document.getElementById('code-row');
  var code = document.getElementById('code');
  var send = document.getElementById('send');
  var submit = document.getElementById('submit');
  var error = document.getElementById('error');

  function showError(message) {
    error.textContent = message;
    error.style.display = message ? 'block' : 'none';
  }

  send.addEventListener('click', function () {
    showError('');
    send.disabled = true;
    fetch('/authz/otp/challenges', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ email: email.value.trim() }),
    }).then(function (res) {
      if (res.status !== 202) throw new Error(res.status === 400 ? '邮箱格式不正确' : '服务暂时不可用，请稍后重试');
      codeRow.style.display = 'block';
      submit.style.display = 'block';
      send.textContent = '重新发送验证码';
      code.focus();
    }).catch(function (err) {
      showError(err.message || '网络异常，请稍后重试');
    }).finally(function () {
      send.disabled = false;
    });
  });

  document.getElementById('login-form').addEventListener('submit', function (event) {
    event.preventDefault();
    showError('');
    submit.disabled = true;
    fetch('/authz/otp/verifications', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ email: email.value.trim(), code: code.value.trim() }),
    }).then(function (res) {
      if (res.status === 401) throw new Error('验证码不正确或已过期');
      if (res.status !== 200) throw new Error('服务暂时不可用，请稍后重试');
      window.location.assign(NEXT);
    }).catch(function (err) {
      showError(err.message || '网络异常，请稍后重试');
    }).finally(function () {
      submit.disabled = false;
    });
  });
})();
</script>
</body>
</html>
`;
}
