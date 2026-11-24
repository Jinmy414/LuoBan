(() => {
  const widget = document.getElementById('entryWidget');
  const notice = document.getElementById('entryStatus');
  const retry = document.getElementById('entryRetry');
  let submitting = false;
  let timer;

  function failed(message) {
    clearTimeout(timer);
    notice.textContent = message;
    retry.hidden = false;
  }

  async function finish(token) {
    if (submitting) return;
    submitting = true;
    clearTimeout(timer);
    retry.hidden = true;
    notice.textContent = '正在确认验证结果…';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 18000);
    try {
      const result = await fetch('/api/site-entry', {method:'POST', credentials:'same-origin',
        headers:{'Content-Type':'application/json'}, body:JSON.stringify({turnstileToken:token}), signal:controller.signal});
      const data = await result.json();
      if (!result.ok || !data.verified) throw new Error(data.error || '验证未完成，请重试。');
      const check = await fetch('/api/cloudflare-config', {credentials:'same-origin', cache:'no-store', signal:controller.signal});
      if (check.status === 403) throw new Error('请允许本站使用 Cookie，再重新验证。');
      if (!check.ok) throw new Error('暂时无法进入罗瓣，请稍后重试。');
      location.reload();
    } catch (error) {
      failed(error instanceof TypeError || error.name === 'AbortError' ? '连接失败，请检查网络后重试。' : error.message);
    } finally {
      clearTimeout(timeout);
      submitting = false;
    }
  }

  retry.onclick = () => location.reload();
  const script = document.createElement('script');
  timer = setTimeout(() => failed('验证组件加载较慢，请检查网络后重试。'), 15000);
  window.luobanEntryReady = () => {
    clearTimeout(timer);
    retry.hidden = true;
    try {
      window.turnstile.render(widget, {sitekey:widget.dataset.siteKey, action:'site_entry', size:'flexible',
        theme:'light', callback:finish, 'error-callback':() => { failed('验证暂时无法完成，请重试。'); return true; },
        'timeout-callback':() => failed('本次验证已超时，请重试。'),
        'expired-callback':() => failed('本次验证已过期，请重试。')});
    } catch { failed('验证组件暂时无法打开，请重试。'); }
  };
  script.async = true;
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=luobanEntryReady&render=explicit';
  script.onerror = () => failed('验证组件暂时无法加载，请检查网络后重试。');
  document.head.appendChild(script);
})();
