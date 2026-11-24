// All identity decisions come from the same-origin API. Registration proofs stay in memory.
const authDialog = document.getElementById('authModal');
let authFlow = null;
let resendTimer = null;
let activeAccount = null;
let sessionRevision = 0;

async function accountRequest(path, data) {
  let response;
  try {
    response = await fetch(`api/${path}`, data === undefined
      ? { credentials: 'same-origin', cache: 'no-store' }
      : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  } catch {
    throw new Error('连接失败，请检查网络后重试。');
  }
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('此站点尚未连接账号服务，暂时只能浏览作品。');
  }
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || '请求失败，请稍后再试。');
    error.status = response.status;
    throw error;
  }
  return result;
}

async function refreshSession() {
  const revision = ++sessionRevision;
  try {
    const { user } = await accountRequest('session');
    if (revision === sessionRevision && JSON.stringify(user) !== JSON.stringify(activeAccount)) {
      applyAccount(user);
      renderApp();
    }
  } catch { /* The public catalogue also works on a static host. */ }
}

function openAuth(mode = 'login') {
  authFlow = { step: mode === 'register' ? 'email' : 'login', email: '', challenge: '', ticket: '', resendAt: 0 };
  if (!authDialog.open) authDialog.showModal();
  document.body.classList.add('sheet-open');
  drawAuth();
}

function drawAuth() {
  clearInterval(resendTimer);
  const flow = authFlow;
  const { step } = flow;
  const isLogin = step === 'login';
  const steps = ['email', 'code', 'account'];
  const titles = { login: '登录罗瓣', email: '你的邮箱是？', code: '查看你的收件箱', account: '给自己起个名字' };
  const hints = { login: '用用户名或已验证的邮箱继续。', email: '我们会发送一封含六位验证码的邮件。', code: `验证码已发送至 ${escapeHTML(flow.email)}，10 分钟内有效。`, account: '邮箱已验证。设置用户名和密码后，就可以留下你的第一条短评。' };
  const fields = {
    login: '<label>用户名或邮箱<input name="identity" autocomplete="username" autocapitalize="none" required></label>',
    email: '<label>邮箱地址<input name="email" type="email" placeholder="name@example.com" maxlength="254" autocomplete="email" autocapitalize="none" required></label>',
    code: '<label>六位验证码<input class="otp" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="000000" required></label>',
    account: '<label>用户名<input name="username" maxlength="20" autocomplete="username" placeholder="可用中文，最多 20 字" required></label>'
  };
  const actions = { login: '登录', email: '发送验证码', code: '验证邮箱', account: '创建账号' };
  const password = isLogin || step === 'account' ? `<label>密码<input name="password" type="password" autocomplete="${isLogin ? 'current-password' : 'new-password'}" ${isLogin ? '' : 'minlength="8" maxlength="128" placeholder="至少 8 个字符"'} required></label>` : '';
  document.getElementById('authBody').innerHTML = `
    ${isLogin ? '' : `<div class="step-track" aria-label="注册第 ${steps.indexOf(step) + 1} 步，共三步">${steps.map((s, i) => `<i class="${i <= steps.indexOf(step) ? 'filled' : ''}"></i>`).join('')}</div>`}
    <h2 id="authTitle">${titles[step]}</h2><p class="auth-description">${hints[step]}</p>
    <form id="authForm" class="stack-form">${fields[step]}${password}
      <p class="form-error" id="authError" role="alert"></p>
      <button class="button button-primary button-wide" type="submit">${actions[step]}</button>
    </form>
    <div class="auth-links">${step === 'code' ? '<button type="button" data-resend>重新发送</button><button type="button" data-auth-step="email">更改邮箱</button>' : isLogin ? '<span>第一次来？</span><button type="button" data-auth-step="email">注册账号</button>' : '<button type="button" data-auth-step="login">已有账号？去登录</button>'}</div>`;
  const form = document.getElementById('authForm');
  if (step === 'email') form.elements.email.value = flow.email;
  form.querySelector('input').focus({ preventScroll: true });
  if (step === 'code') {
    const update = () => {
      const remaining = Math.max(0, Math.ceil((flow.resendAt - Date.now()) / 1000));
      const button = authDialog.querySelector('[data-resend]');
      button.disabled = remaining > 0 || Boolean(flow.busy);
      button.textContent = remaining ? `${remaining} 秒后可重发` : '重新发送验证码';
    };
    update();
    resendTimer = setInterval(update, 500);
  }
}

async function handleAuth(resend = false) {
  const flow = authFlow;
  if (!flow || flow.busy) return;
  const form = authDialog.querySelector('form');
  const values = Object.fromEntries(new FormData(form));
  flow.busy = true;
  const submit = form.querySelector('[type=submit]');
  const originalLabel = submit.textContent;
  submit.disabled = true;
  submit.textContent = '正在处理…';
  const error = document.getElementById('authError');
  error.textContent = '';
  try {
    if (flow.step === 'email' || resend) {
      const email = (resend ? flow.email : values.email).trim();
      const result = await accountRequest('email-code', { email });
      if (authFlow !== flow) return;
      Object.assign(flow, { step: 'code', email, challenge: result.challenge, resendAt: Date.now() + result.retryAfter * 1000 });
    } else if (flow.step === 'code') {
      const result = await accountRequest('verify-email', { challenge: flow.challenge, code: values.code });
      if (authFlow !== flow) return;
      Object.assign(flow, { step: 'account', ticket: result.ticket });
    } else {
      const result = flow.step === 'login' ? await accountRequest('login', values)
        : await accountRequest('register', { ...values, ticket: flow.ticket });
      applyAccount(result.user);
      if (authFlow === flow) authDialog.close();
      renderApp();
      showToast(`欢迎，${result.user.username}`);
      return;
    }
    drawAuth();
  } catch (exception) {
    if (authFlow !== flow) return;
    if (exception.status === 410) {
      flow.step = 'email';
      drawAuth();
    }
    document.getElementById('authError').textContent = exception.message;
    if (flow.step === 'code') form.elements.code?.select();
  } finally {
    flow.busy = false;
    submit.disabled = false;
    submit.textContent = originalLabel;
  }
}

authDialog.addEventListener('submit', event => {
  event.preventDefault();
  handleAuth();
});
authDialog.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (button?.hasAttribute('data-close-auth')) authDialog.close();
  if (event.target === authDialog) {
    const rect = authDialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) authDialog.close();
  }
  if (button?.hasAttribute('data-resend')) handleAuth(true);
  if (button?.dataset.authStep) {
    authFlow = { ...authFlow, busy: false, step: button.dataset.authStep, ticket: '', challenge: '' };
    drawAuth();
  }
});
authDialog.addEventListener('close', () => {
  clearInterval(resendTimer);
  authFlow = null;
  document.body.classList.remove('sheet-open');
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshSession();
});
