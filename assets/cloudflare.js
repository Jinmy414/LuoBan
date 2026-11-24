// Only the public widget key is available to the browser.
const cloudflareAccess = (() => {
  let settings, loading;

  function config() {
    if (!settings) settings = accountRequest('cloudflare-config').catch(error => {
      settings = null;
      if (error.code === 'STATIC_SITE') return {siteKey:'', llama:false};
      throw error;
    });
    return settings;
  }

  function widgetScript() {
    if (window.turnstile) return Promise.resolve(window.turnstile);
    if (!loading) loading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const failed = () => { clearTimeout(timer); script.remove(); loading = null; reject(new Error('人机验证暂时无法加载，请重试。')); };
      const timer = setTimeout(failed, 15000);
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.onload = () => {
        if (!window.turnstile) { failed(); return; }
        clearTimeout(timer);
        window.turnstile.ready(() => resolve(window.turnstile));
      };
      script.onerror = failed;
      document.head.appendChild(script);
    });
    return loading;
  }

  async function token(action, host, active) {
    const {siteKey} = await config();
    if (!siteKey) return '';
    const api = await widgetScript();
    if (!active() || !host?.isConnected) throw new Error('验证已取消。');
    let id, timer, timeout;
    const container = document.createElement('div');
    host.replaceChildren(container);
    try {
      return await new Promise((resolve, reject) => {
        const failed = () => { reject(new Error('人机验证未完成，请重试。')); return true; };
        timeout = setTimeout(failed, 120000);
        timer = setInterval(() => { if (!active() || !container.isConnected) failed(); }, 250);
        id = api.render(container, {sitekey:siteKey, action, size:'flexible',
          appearance:'interaction-only', callback:resolve, 'error-callback':failed,
          'expired-callback':failed, 'timeout-callback':failed});
      });
    } finally {
      clearInterval(timer);
      clearTimeout(timeout);
      if (id != null) api.remove(id);
      container.remove();
    }
  }

  return {config, token};
})();
