export function checkoutPageHtml(paymentId: string, nonce: string, testMode: boolean): string {
  if (!/^[A-Za-z0-9+/=_-]{16,128}$/.test(nonce)) throw new Error('invalid page nonce');
  const id = JSON.stringify(paymentId).replace(
    /[<>&\u2028\u2029]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
  );
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>支付 · Combo</title>
<style nonce="${nonce}">
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#f5f5f4;color:#1c1917;font-family:system-ui,-apple-system,sans-serif;display:flex;justify-content:center;align-items:flex-start;padding:40px 16px}
main{width:100%;max-width:420px;padding:28px;background:white;border-radius:12px;box-shadow:0 1px 4px rgb(0 0 0/.08)}h1{font-size:1.35rem;margin:0 0 20px}h2{font-size:1rem;margin:24px 0 8px}p{font-size:.9rem;line-height:1.6;margin:8px 0;color:#57534e;text-wrap:pretty}.label{font-size:.8rem;margin:0}.amount{font-size:2.25rem;font-weight:650;color:#1c1917;margin:2px 0 4px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.test{margin:0 0 18px;padding:8px 10px;background:#fff7ed;color:#9a3412;border-radius:6px;font-size:.8rem}fieldset{border:0;margin:24px 0 0;padding:0}legend{font-size:.9rem;margin-bottom:10px}.methods{display:flex;gap:10px}.method{flex:1;padding:12px;border:1px solid #d6d3d1;border-radius:8px;font-size:.9rem;cursor:pointer}.method:has(input:checked){border-color:#1c1917;background:#f5f5f4}input{accent-color:#1c1917;margin-right:6px}
button,a.login{display:block;width:100%;border:0;border-radius:8px;padding:12px;font:inherit;font-size:.9rem;cursor:pointer;margin-top:16px;background:#1c1917;color:#fff;text-align:center;text-decoration:none}button:hover,a.login:hover{background:#44403c}button:active{background:#0c0a09}button:focus-visible,a:focus-visible,input:focus-visible,summary:focus-visible{outline:3px solid #2563eb;outline-offset:3px}button:disabled{opacity:.5;cursor:default}button.secondary{background:#f5f5f4;color:#1c1917}.secondary:hover{background:#e7e5e4}
#qr{display:block;width:264px;height:264px;max-width:100%;object-fit:contain;margin:20px auto 8px}#status{font-weight:600;color:#1c1917}#error{color:#b91c1c}#timer{text-align:center;font-variant-numeric:tabular-nums}.muted{font-size:.8rem}details{margin-top:24px;font-size:.8rem;color:#57534e}summary{cursor:pointer}code{display:block;margin-top:8px;overflow-wrap:anywhere;user-select:all}hr{border:0;border-top:1px solid #e7e5e4;margin:24px 0 16px}[hidden]{display:none!important}@media(max-width:420px){body{padding:16px 12px}main{padding:24px 20px}}@media(prefers-reduced-motion:no-preference){button{transition:background-color 150ms ease-out}}
</style></head><body><main>
<h1>Combo 收银台</h1>${testMode ? '<p class="test">测试支付环境，请勿用于正式业务。</p>' : ''}
<p class="label">为本次使用补充余额</p><p class="amount" id="amount" aria-live="polite">正在查询…</p>
<p id="status" role="status">正在核对支付状态</p><p id="hint">金额和支付结果由 Combo 确认。</p>
<fieldset id="choice" hidden><legend>选择付款方式</legend><div class="methods"><label class="method"><input type="radio" name="payType" value="wechat" checked>微信扫码</label><label class="method"><input type="radio" name="payType" value="alipay">支付宝扫码</label></div><button id="generate" type="button">生成付款码</button><p class="muted">生成后，本次付款方式不能更换。</p></fieldset>
<img id="qr" alt="本次支付的付款二维码" hidden><p id="timer" class="muted" hidden></p>
<p id="error" role="alert" hidden></p><button class="secondary" id="refresh" type="button">刷新支付状态</button><a class="login" id="login" hidden>登录后查看支付</a>
<hr><p class="muted">到账后，余额优先用于本次使用，未使用部分保留在账户中。请回到原对话继续；关闭本页不影响已完成的付款。</p>
<details><summary>查看支付编号</summary><code id="payment-id"></code></details>
</main><script nonce="${nonce}">
(()=>{
  const id=${id};const endpoint='/v1/payment-checkouts/'+encodeURIComponent(id);
  const el=name=>document.getElementById(name);el('payment-id').textContent=id;
  el('login').href='/authz/login?next='+encodeURIComponent('/payments/'+id);
  let active;let timer;let closed=false;let finished=false;let deadline=Date.now()+15*60*1000;let qrExpires=0;
  function clearQr(){el('qr').hidden=true;el('qr').removeAttribute('src');el('timer').hidden=true;qrExpires=0;}
  function error(text){el('error').textContent=text;el('error').hidden=!text;}
  function amount(money){if(money.currency!=='CNY'||!/^[1-9][0-9]{0,14}$/.test(money.amountCents))throw Error();const cents=BigInt(money.amountCents);return '¥ '+(cents/100n).toLocaleString('zh-CN')+'.'+String(cents%100n).padStart(2,'0');}
  function show(data){
    const p=data.payment;el('amount').textContent=amount(p.amount);el('choice').hidden=true;el('login').hidden=true;clearQr();
    if(p.status==='completed'){finished=true;el('status').textContent='已确认入账';el('hint').textContent='可以回到原对话继续，不需要再次付款。';return;}
    if(p.status==='closed'){finished=true;el('status').textContent='本次支付已关闭';el('hint').textContent='请返回原对话查看下一步。如果刚刚完成付款，可以稍后刷新核对。';return;}
    const c=data.checkout;
    if(!c){el('choice').hidden=false;el('status').textContent='等待付款';el('hint').textContent='选择付款方式后，由 Combo 生成本次付款码。';return;}
    const method=c.payType==='wechat'?'微信':'支付宝';
    if(c.qrImage&&typeof c.qrImage==='string'&&c.qrImage.startsWith('data:image/png;base64,')&&Date.parse(c.expiresAt)>Date.now()){
      el('qr').src=c.qrImage;el('qr').hidden=false;qrExpires=Date.parse(c.expiresAt);el('timer').hidden=false;
      el('status').textContent='请使用'+method+'扫码付款';el('hint').textContent='付款后会自动核对入账结果。';
    }else{el('status').textContent='正在确认支付结果';el('hint').textContent='请勿重复付款。暂时没有可用付款码时，请稍后刷新。';}
  }
  async function request(method='GET'){
    if(active||closed)return;clearTimeout(timer);if(Date.now()>=deadline){clearQr();error('自动查询已暂停，请点击刷新查看最新状态。');return;}error('');el('generate').disabled=true;el('refresh').disabled=true;if(method==='POST')el('choice').hidden=true;
    const controller=new AbortController();active=controller;const timeout=setTimeout(()=>controller.abort(),10000);
    try{
      const res=await fetch(endpoint,{method,credentials:'same-origin',redirect:'error',cache:'no-store',headers:{'content-type':'application/json'},...(method==='POST'?{body:JSON.stringify({payType:document.querySelector('input[name="payType"]:checked').value})}:{}),signal:controller.signal});
      if(res.status===401||res.status===403||res.status===404){finished=true;clearQr();el('choice').hidden=true;el('login').hidden=res.status!==401;el('amount').textContent='未显示';el('status').textContent='暂时无法查看此支付';el('hint').textContent=res.status===401?'请重新登录当前账户。':'请回到发起支付的原对话核对。';return;}
      if(!res.ok)throw Error();const data=await res.json();if(closed)return;show(data.data);
    }catch{if(!closed){clearQr();error(method==='POST'?'创建结果暂时无法确认，正在查询原支付，请勿重复付款。':'状态查询暂时失败，请稍后刷新。');}}
    finally{clearTimeout(timeout);active=undefined;el('generate').disabled=false;el('refresh').disabled=false;if(!closed&&!finished&&!document.hidden&&Date.now()<deadline)timer=setTimeout(()=>request(),3000);}
  }
  el('generate').onclick=()=>request('POST');el('refresh').onclick=()=>{finished=false;deadline=Date.now()+15*60*1000;request();};
  document.addEventListener('visibilitychange',()=>{clearTimeout(timer);if(!document.hidden&&!finished&&Date.now()<deadline)request();});
  window.addEventListener('pagehide',()=>{closed=true;clearTimeout(timer);active?.abort();clearInterval(countdown);});
  const countdown=setInterval(()=>{if(qrExpires){const seconds=Math.max(0,Math.ceil((qrExpires-Date.now())/1000));el('timer').textContent='付款码剩余 '+Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');if(!seconds){clearQr();request();}}},1000);
  request();
})();
</script></body></html>`;
}
