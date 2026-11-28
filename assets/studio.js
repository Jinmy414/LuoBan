// Profile sheets, work submissions and review share the same published catalogue.
const posterNames = { mint: '青苔绿', dusk: '晚霞橘', sky: '晴空蓝', lavender: '雾紫色', lemon: '柠檬黄', ink: '墨夜蓝' };
const submissionStatus = {pending: '待审核', approved: '已发布', rejected: '已退回'};
function profileTool(kind, label) {
  return `<button type="button" class="studio-action" data-profile-tool="${kind}">${label}</button>`;
}
function renderProfile() {
  const user = currentUser();
  const favorites = user.favoriteIds.map(getWork).filter(Boolean);
  const allComments = profileComments(user);
  const comments = allComments.filter(item => user.featuredCommentIds.includes(item.key));
  const created = state.works.filter(work => !work.shared && work.createdBy === user.username);
  return `<section class="studio-page">
    <div class="profile-banner"><img class="identity-image" src="${avatarURL(user.username)}" alt=""><div><h1>我的罗瓣</h1>
      <p>${escapeHTML(user.username)} · 收到 ${allComments.reduce((sum, c) => sum + c.likes, 0)} 个赞</p></div>${profileTool('account','编辑个人信息')}</div>
    <a class="public-profile-link" href="${memberHref(user.username, user.accountId)}">查看我的公开主页 ›</a>
    <section class="studio-panel"><div class="panel-heading"><h2 id="historyTitle">继续观看</h2><small>仅自己可见</small></div><div id="watchHistory" aria-live="polite">正在读取观看记录…</div></section>
    <section class="studio-panel"><div class="panel-heading"><h2>想看清单</h2><small>仅自己可见</small></div><div id="privateWatchlist" aria-live="polite">正在读取想看清单…</div></section>
    <section class="studio-panel"><div class="panel-heading"><div><h2>三部最爱</h2><p>${favorites.length} / 3 部</p></div>${profileTool('favorites','选择最爱')}</div>
    <div class="favorite-shelf">${favorites.map(work => workCard(work, true)).join('')}${favorites.length < 3 ? '<button class="favorite-slot" type="button" data-profile-tool="favorites"><span aria-hidden="true">♡</span>添加最爱作品</button>' : ''}</div></section>
    <div class="profile-columns"><section class="studio-panel"><div class="panel-heading"><h2>展示评论</h2>${profileTool('comments','选择评论')}</div>${comments.map(c => `<article class="profile-quote">${commentScoreBadge(c.work,user.username,c.score)}<p>${escapeHTML(c.text)}</p><a href="#work-${escapeHTML(c.work.id)}">《${escapeHTML(c.work.title)}》</a></article>`).join('') || '<p class="studio-empty">还没有展示评论。</p>'}</section>
    <section class="studio-panel"><div class="panel-heading"><h2>我的上线申请</h2><a class="studio-action" href="#create">期待上线</a></div>
    <div id="mySubmissions" aria-live="polite">正在读取申请…</div>
    ${created.map(w => `<a class="studio-row" href="#work-${escapeHTML(w.id)}">${thumb(w)}<span>${escapeHTML(w.title)}</span><small>${displayYear(w.year)}</small></a>`).join('')}</section></div></section>`;
}
function refreshProfileAfterSheet() {
  const profile = document.querySelector('.studio-page .profile-banner');
  if (profile && !document.querySelector('.studio-dialog[open]')) renderApp();
}
function openPicker(kind, opener) {
  const user = currentUser();
  const favorites = kind === 'favorites';
  const property = favorites ? 'favoriteIds' : 'featuredCommentIds';
  const choices = favorites ? state.works.map(work => ({id:work.id, label:work.title, info:[displayYear(work.year),work.region].join(' · '), work}))
    : profileComments(user).map(c => ({id:c.key, label:c.work.title, info:c.text, work:c.work}));
  const chosen = new Set((user[property] || []).filter(id => choices.some(c => c.id === id)));
  const title = favorites ? '选择最爱' : '选择评论';
  const dialog = openSheet(title, `<div class="picker-tools"><div class="pick-summary"><strong>已选 <span data-count></span> / 3</strong><div class="selected-chips"></div></div>
    <label class="picker-search"><span class="search-icon" aria-hidden="true"></span><input type="search" role="combobox" aria-expanded="true" aria-controls="pickOptions" aria-autocomplete="list" aria-label="搜索作品名称" placeholder="搜索作品名称" autocomplete="off" autofocus></label></div>
    <div class="pick-list" id="pickOptions" role="listbox" aria-label="搜索建议" aria-multiselectable="true"></div><div class="sheet-foot"><span role="status" class="picker-status"></span><button class="button button-primary" data-confirm type="button">确定</button></div>`, opener);
  const search = dialog.querySelector('input');
  const list = dialog.querySelector('.pick-list');
  const message = dialog.querySelector('[role=status]');
  let active = -1, results = [], limit = 25;
  const normalize = str => str.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  function draw() {
    const term = normalize(search.value);
    const matches = choices.filter(c => [c.label, ...(c.work.aliases || [])].some(label => normalize(label).includes(term)));
    if (term) matches.sort((a,b) => Number(normalize(b.label).startsWith(term)) - Number(normalize(a.label).startsWith(term)));
    results = matches.slice(0,limit);
    dialog.querySelector('[data-count]').textContent = chosen.size;
    dialog.querySelector('.selected-chips').innerHTML = [...chosen].map(id => {
      const c = choices.find(item => item.id === id);
      return `<button type="button" data-pick="${escapeHTML(id)}" aria-label="移除 ${escapeHTML(c.label)}">${escapeHTML(c.label)} ×</button>`;
    }).join('');
    list.innerHTML = results.map((c,i) => `<button id="pick-${i}" role="option" tabindex="-1" aria-selected="${chosen.has(c.id)}" class="pick-option" data-pick="${escapeHTML(c.id)}" type="button">${thumb(c.work)}<span><strong>${escapeHTML(c.label)}</strong><small>${escapeHTML(c.info)}</small></span><i aria-hidden="true">${chosen.has(c.id) ? '✓' : '+'}</i></button>`).join('') || `<p class="studio-empty">${!favorites && !choices.length ? '给作品写一条评论后，就可以在这里选择。' : '没有找到匹配的作品，换个名字试试。'}</p>`;
    if (results.length < matches.length) list.insertAdjacentHTML('beforeend','<button type="button" class="more-picks studio-action">显示更多</button>');
    search.removeAttribute('aria-activedescendant');
    active = -1;
    message.textContent = term ? `找到 ${matches.length} 项` : '';
  }
  function toggle(id) {
    if (chosen.has(id)) chosen.delete(id);
    else if (chosen.size < 3) chosen.add(id);
    else { message.textContent = '已选满 3 项，请先移除一项。'; return; }
    const top = list.scrollTop;
    draw();
    list.scrollTop = top;
  }
  search.addEventListener('input', () => { limit = 25; draw(); list.scrollTop = 0; });
  search.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229 || !results.length) return;
    if (['ArrowDown','ArrowUp'].includes(event.key)) {
      event.preventDefault();
      active = Math.max(0,Math.min(results.length-1,active + (event.key === 'ArrowDown' ? 1 : -1)));
      list.querySelector('.key-active')?.classList.remove('key-active');
      const option = list.children[active];
      option.classList.add('key-active'); option.scrollIntoView({block:'nearest'});
      search.setAttribute('aria-activedescendant',option.id);
    } else if (event.key === 'Enter') { event.preventDefault(); toggle(results[Math.max(0,active)].id); }
  });
  dialog.addEventListener('click', async event => {
    const option = event.target.closest('[data-pick]');
    if (option) toggle(option.dataset.pick);
    if (event.target.closest('.more-picks')) { limit += 25; draw(); }
    if (event.target.closest('[data-confirm]')) {
      if (currentUser() !== user) { dialog.close(); return; }
      const confirm = dialog.querySelector('[data-confirm]');
      confirm.disabled = true;
      try {
        await saveShowcase(user, favorites ? {favoriteIds:[...chosen]} : {featuredComments:featuredSelection(user, [...chosen])});
      } catch (e) { message.textContent = e.message; confirm.disabled = false; return; }
      dialog.close(); refreshProfileAfterSheet(); showToast('已保存');
    }
  });
  draw();
  search.focus({preventScroll:true});
}
function readFile(file) {
  return new Promise((resolve,reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('读取图片失败，请重新选择。'));
    reader.readAsDataURL(file);
  });
}
async function squareAvatar(file) {
  if (file.size > 15 * 1024 * 1024) throw new Error('请选择小于 15 MB 的照片。');
  const src = URL.createObjectURL(file);
  try {
    const picture = new Image();
    picture.src = src;
    await picture.decode();
    const side = Math.min(picture.naturalWidth, picture.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 320;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0,0,320,320);
    ctx.drawImage(picture,(picture.naturalWidth-side)/2,(picture.naturalHeight-side)/2,side,side,0,0,320,320);
    return canvas.toDataURL('image/jpeg',0.85);
  } finally { URL.revokeObjectURL(src); }
}
function openProfileAccount(opener) {
  const user = currentUser();
  const dialog = openSheet('编辑个人信息', `<form method="post" class="account-edit"><div class="sheet-scroll"><div class="avatar-edit"><img src="${avatarURL(user.username)}" alt="头像预览"><label class="studio-action file-label">更换头像<input type="file" accept="image/*" name="avatar"></label></div>
    <label class="studio-field">用户名<input name="username" autocomplete="username" maxlength="20" value="${escapeHTML(user.username)}" required></label>
    <details><summary>修改密码</summary><label class="studio-field">新密码<input name="password" autocomplete="new-password" type="password" minlength="8" maxlength="128"></label></details>
    <label class="studio-field" data-current hidden>当前密码<input name="currentPassword" type="password" autocomplete="current-password"></label>
    <div class="account-picks">${profileTool('favorites','选择最爱')}${profileTool('comments','选择展示评论')}</div>
    <p class="form-error" role="alert"></p></div><div class="sheet-foot"><button type="button" class="studio-action" data-close>取消</button><button class="button button-primary" type="submit">保存</button></div></form>`, opener);
  const form = dialog.querySelector('form');
  const error = form.querySelector('[role=alert]');
  const submit = form.querySelector('[type=submit]');
  let avatar, generation = 0;
  form.addEventListener('input', () => {
    const credentials = form.elements.username.value.trim() !== user.username || !!form.elements.password.value;
    form.querySelector('[data-current]').hidden = !credentials;
    form.elements.currentPassword.required = credentials;
  });
  form.elements.avatar.addEventListener('change', async () => {
    const file = form.elements.avatar.files[0];
    if (!file) return;
    const id = ++generation; submit.disabled = true; error.textContent = '';
    try {
      const result = await squareAvatar(file);
      if (id === generation) { avatar = result; form.querySelector('img').src = result; }
    } catch { if (id === generation) error.textContent = '无法读取照片，请选择 15 MB 以内的 JPG、PNG 或 WebP 图片。'; }
    finally { if (id === generation) submit.disabled = false; }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (submit.disabled) return;
    submit.disabled = true; error.textContent = '';
    const username = form.elements.username.value.trim();
    try {
      if (avatar || username !== user.username || form.elements.password.value) {
        const result = await accountRequest('account', { username, password:form.elements.password.value, currentPassword:form.elements.currentPassword.value, ...(avatar ? {avatar} : {}) });
        avatarRevision++; applyAccount(result.user);
      }
      dialog.close(); navigate('profile'); showToast('个人信息已保存');
    } catch (exception) { error.textContent = exception.message; }
    finally { submit.disabled = false; }
  });
  dialog.addEventListener('close', () => {
    if (!document.querySelector('.studio-dialog[open]') && currentRoute().startsWith('profile')) {
      const current = document.querySelector('.studio-page');
      if (current && opener.isConnected) { renderApp(); document.querySelector('[data-profile-tool=account]')?.focus({preventScroll:true}); }
    }
  }, {once:true});
}
function workTypeChoices(selected) {
  const options = [...new Set([...selected, ...typeOptions()])];
  const typeChip = type => `<label class="type-choice"><input type="checkbox" name="types" value="${escapeHTML(type)}" ${selected.includes(type) ? 'checked' : ''}><span>${escapeHTML(type)}</span></label>`;
  return `<fieldset><legend>类别 <small>可多选</small></legend><div class="type-choices">${options.slice(0,10).map(typeChip).join('')}</div>${options.length > 10 ? `<details class="more-types" ${selected.length > 10 ? 'open' : ''}><summary>更多类型</summary><div class="type-choices">${options.slice(10).map(typeChip).join('')}</div></details>` : ''}</fieldset>`;
}
function renderWorkRequest(item = {}) {
  if (!currentUser()) return loginRequired('期待上线', '登录后，告诉管理员你想在罗瓣看到哪部作品。');
  const id = item.id || 'entry-' + crypto.randomUUID().replaceAll('-', '');
  return `<section class="studio-page work-request"><header class="studio-intro"><h1>期待上线</h1><p>想在罗瓣看到哪部作品？给管理员留个言。</p></header>
    <form id="requestForm" class="studio-panel form-stack" data-id="${escapeHTML(id)}" data-version="${item.version || 0}">
    ${item.reason ? `<p class="request-return">退回原因 · ${escapeHTML(item.reason)}</p>` : ''}
    <label class="studio-field">作品名称<input name="title" required maxlength="120" value="${escapeHTML(item.title || '')}" placeholder="填写片名，剧集请注明第几季"></label>
    <p class="title-match" role="status" aria-live="polite"></p>
    <label class="studio-field">地区<select name="region" required><option value="">选择地区</option>${REGION_OPTIONS.map(r => `<option ${item.region === r ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
    ${workTypeChoices(item.types || [])}
    <label class="studio-field"><span>给管理员的留言 <small>选填</small></span><textarea name="requestNote" rows="3" maxlength="500" placeholder="可以补充别名、版本或想看的原因">${escapeHTML(item.requestNote || '')}</textarea></label>
    <p class="request-privacy">只有你、管理员和超级管理员可以查看留言。</p>
    <p class="form-error" role="alert"></p><div class="editor-foot"><a class="studio-action" href="#profile">我的申请</a><button class="button button-primary" type="submit">提交审核</button></div></form></section>`;
}

function matchingWork(title, exceptId) {
  const normalize = text => text.normalize('NFKC').toLowerCase().replace(/[\s\p{Cf}]/gu, '').replace(/^《(.*)》$/u, '$1');
  const key = normalize(title);
  if (!key) return null;
  const existing = state.works.find(work => work.id !== exceptId && normalize(work.title) === key);
  if (existing) return existing;
  for (const [rootId, seasons] of animeSeries) {
    const root = getWork(rootId);
    if (!root || rootId === exceptId) continue;
    const season = seasons.find(s => s.n && [s.title, root.title + s.label,
      /^第.+季$/.test(s.label) && root.title + '第' + s.n + '季'].some(name => name && normalize(name) === key));
    if (season) return season;
  }
  return null;
}

function workMessage(target, message, id) {
  target.textContent = message;
  if (id) {
    const link = document.createElement('a');
    link.href = '#work-' + encodeURIComponent(id);
    link.textContent = '查看作品 ›';
    target.append(' ', link);
  }
}

function setupRequestForm(form) {
  const fields = form.elements;
  const hint = form.querySelector('.title-match');
  const error = form.querySelector('[role=alert]');
  const button = form.querySelector('[type=submit]');
  function updateMatch() {
    const work = matchingWork(fields.title.value, form.dataset.id);
    workMessage(hint, work ? '罗瓣已收录这部作品。' : '', work?.id);
  }
  updateMatch();
  fields.title.addEventListener('input', updateMatch);
  form.addEventListener('input', () => { error.textContent = ''; });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (button.disabled) return;
    const types = new FormData(form).getAll('types');
    if (!types.length) {
      error.textContent = '请至少选择一种类别。';
      form.querySelector('[name=types]').focus();
      return;
    }
    button.disabled = true;
    button.textContent = '正在提交…';
    try {
      await accountRequest('submissions', {
        action:'request', id:form.dataset.id, version:Number(form.dataset.version),
        title:fields.title.value.trim(), region:fields.region.value, types, requestNote:fields.requestNote.value.trim()
      });
      if (form.isConnected) { navigate('profile'); showToast('已提交，可在「我的上线申请」查看进度'); }
    } catch (exception) {
      workMessage(error, exception.message, exception.workId);
    } finally { button.disabled = false; button.textContent = '提交审核'; }
  });
}

function renderEditor(editId = '', submission = null, review = false) {
  const user = currentUser();
  if (!user) return loginRequired('登录后编辑作品', '提交作品后，可以在我的罗瓣查看审核进度。');
  const work = submission || (editId && getWork(editId));
  if (editId && !work) return '<p class="studio-empty">找不到这部作品。</p>';
  if (work && work.createdBy !== user.username && !isAdmin(user)) return '<p class="studio-empty">只有创建者和管理员可以修改这部作品。</p>';
  const legacy = !!work && !submission && !work.shared;
  const style = posterKey(work?.poster);
  const title = review ? '审核作品' : work ? '编辑作品' : '创建作品';
  const action = review ? '通过并发布' : legacy ? '保存修改' : '提交审核';
  const id = work?.id || 'entry-' + crypto.randomUUID().replaceAll('-','');
  return `<section class="studio-page"><header class="studio-intro"><h1>${title}</h1><p>${review ? '由 ' + escapeHTML(work.createdBy) + ' 提交。可直接修改下方内容，再决定是否发布。' : legacy ? '更新这部作品的资料。' : '管理员审核通过后，作品会出现在发现页。'}</p></header>
    <form id="workForm" data-id="${escapeHTML(id)}" data-version="${work?.version || 0}" data-mode="${review ? 'review' : legacy ? 'legacy' : 'submit'}">
    ${review && work.requestNote ? `<section class="studio-panel request-message"><h2>申请人留言</h2><p>${escapeHTML(work.requestNote)}</p></section>` : ''}
    <div class="studio-editor"><section class="studio-panel form-stack"><h2>作品资料</h2>
    <label class="studio-field">作品名称<input name="title" required maxlength="120" value="${escapeHTML(work?.title || '')}" placeholder="输入作品名称"></label>
    <div class="field-pair"><label class="studio-field">地区<select name="region">${REGION_OPTIONS.map(r => `<option ${work?.region === r ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
    <label class="studio-field">年份<input type="number" name="year" min="1900" max="2100" inputmode="numeric" ${work && Object.hasOwn(work, 'requestNote') ? 'placeholder="待补充"' : 'required'} value="${work ? (work.year ?? '') : new Date().getFullYear()}"></label></div>
    ${workTypeChoices(work?.types || ['原创'])}
    ${!legacy || (isAdmin(user) && SEED_WORKS.some(seed => seed.id === work.id)) ? `<label class="studio-field">官方作品页 <small>选填</small><input type="url" name="playbackUrl" value="${escapeHTML(work?.playbackUrl || playbackOverrides[work?.id] || '')}" placeholder="粘贴官方平台的作品网址"><small>供审核时核对作品，支持哔哩哔哩、腾讯视频等平台</small></label>` : ''}
    <label class="studio-field">作品介绍 <small>选填</small><textarea name="summary" maxlength="2400" rows="3" placeholder="用几句话介绍这部作品">${escapeHTML(work?.summary || '')}</textarea></label></section>
    <section class="studio-panel form-stack"><h2>作品封面</h2><div class="cover-sample"><div class="sample-art" data-poster="${style}"><img alt="" ${safeImage(work?.coverImage) ? 'src="' + escapeHTML(work.coverImage) + '"' : 'hidden'}><b>${escapeHTML((work?.title || '作').slice(0,1))}</b></div><div><small>封面预览</small><strong data-sample-title>${escapeHTML(work?.title || '作品名称')}</strong><span data-sample-meta></span></div></div>
    <fieldset><legend>封面配色</legend><div class="swatches">${Object.entries(posterNames).map(([key,name]) => `<label title="${name}"><input type="radio" name="poster" aria-label="${name}" value="${key}" ${key === style ? 'checked' : ''}><span data-poster="${key}"></span></label>`).join('')}</div></fieldset>
    <label class="studio-field">图片网址 <small>选填</small><input name="coverImage" inputmode="url" placeholder="https://…" value="${escapeHTML(work?.coverImage?.startsWith('data:') ? '' : work?.coverImage || '')}"></label>
    ${isAdmin(user) ? '<label class="studio-field">上传封面 <small>最大 2 MB</small><input type="file" name="coverFile" accept="image/png,image/jpeg,image/webp,image/gif"></label>' : ''}</section></div>
    ${review ? '<div class="studio-panel review-note"><label class="studio-field">退回原因 <small>退回时必填</small><textarea name="reason" rows="2" maxlength="300" placeholder="告诉作者需要修改什么"></textarea></label></div>' : ''}
    ${submission?.reason ? `<p class="studio-empty">上次退回原因 · ${escapeHTML(submission.reason)}</p>` : ''}
    <div class="editor-foot"><p class="form-error" role="alert"></p><a class="studio-action" href="#${review ? 'admin' : 'profile'}">取消</a>${review ? '<button type="submit" value="reject" class="button button-ghost">退回修改</button>' : ''}<button type="submit" value="${review ? 'approve' : 'submit'}" class="button button-primary">${action}</button></div></form></section>`;
}

function setupWorkForm(form, original = {}) {
  if (!form) return;
  const fields = form.elements, sample = form.querySelector('.sample-art'), img = sample.querySelector('img');
  const error = form.querySelector('[role=alert]');
  let filePreview = '', initialImage = original?.coverImage?.startsWith('data:') ? original.coverImage : '';
  let busy = false;
  if (initialImage) fields.coverImage.placeholder = '已使用上传的封面';
  function preview() {
    const title = fields.title.value.trim() || '作品名称';
    form.querySelector('[data-sample-title]').textContent = title;
    form.querySelector('[data-sample-meta]').textContent = [fields.region.value,fields.year.value,...new FormData(form).getAll('types').slice(0,2)].filter(Boolean).join(' · ');
    sample.dataset.poster = posterKey(fields.poster.value);
    sample.querySelector('b').textContent = title.slice(0,1);
    const source = filePreview || safeImage(fields.coverImage.value.trim()) || initialImage;
    if (source && img.getAttribute('src') !== source) { img.hidden = false; img.src = source; }
    if (!source) { img.removeAttribute('src'); img.hidden = true; }
  }
  img.addEventListener('error', () => { img.hidden = true; });
  img.addEventListener('load', () => { img.hidden = false; });
  form.addEventListener('input', () => { error.textContent = ''; preview(); });
  if (fields.coverFile) fields.coverFile.addEventListener('change', () => {
    if (filePreview) URL.revokeObjectURL(filePreview);
    filePreview = fields.coverFile.files.length ? URL.createObjectURL(fields.coverFile.files[0]) : '';
    preview();
  });
  const release = () => { if (filePreview) URL.revokeObjectURL(filePreview); };
  window.addEventListener('hashchange',release,{once:true});
  preview();
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return;
    const user = currentUser();
    if (!user) { openAuth(); return; }
    const values = new FormData(form);
    const data = {id:form.dataset.id, version:Number(form.dataset.version), title:fields.title.value.trim(), year:fields.year.value ? Number(fields.year.value) : null,
      region:fields.region.value, playbackUrl:fields.playbackUrl?.value.trim() || '', types:values.getAll('types'), poster:fields.poster.value, coverImage:fields.coverImage.value.trim() || initialImage, summary:fields.summary.value.trim()};
    if (!data.title || !data.types.length) { error.textContent = '请填写作品名称，并至少选择一种类型。'; return; }
    if (data.coverImage && !safeImage(data.coverImage)) { error.textContent = '请填写有效的图片网址。'; return; }
    busy = true; form.querySelectorAll('[type=submit]').forEach(b => b.disabled = true);
    try {
      const file = fields.coverFile?.files[0];
      if (file) {
        if (file.size > 2 * 1024 * 1024) throw new Error('请选择 2 MB 以内的封面图片。');
        data.coverImage = await readFile(file);
        if (!safeImage(data.coverImage)) throw new Error('请选择 JPG、PNG、WebP 或 GIF 图片。');
      }
      if (form.dataset.mode === 'legacy') {
        const work = getWork(data.id);
        if (!work || (work.createdBy !== user.username && !isAdmin(user))) throw new Error('当前账号没有编辑权限。');
        const duplicate = matchingWork(data.title, data.id);
        if (duplicate) { workMessage(error, '罗瓣已收录这部作品。', duplicate.id); return; }
        const {id,version,playbackUrl,...updates} = data;
        if (fields.playbackUrl && playbackUrl !== (playbackOverrides[id] || '')) {
          await accountRequest('playback',{id,url:playbackUrl});
          playbackOverrides[id] = playbackUrl;
        }
        const previous = {...work};
        Object.assign(work,updates,{poster:POSTER_OPTIONS[data.poster]});
        try { saveState(); } catch { Object.assign(work,previous); throw new Error('浏览器存储空间不足，请缩小封面。'); }
        navigate('work-' + id); showToast('作品已保存'); return;
      }
      const review = form.dataset.mode === 'review';
      data.action = review ? event.submitter?.value || 'approve' : 'submit';
      data.reason = fields.reason?.value.trim() || '';
      if (data.action === 'reject' && !data.reason) { fields.reason.focus(); throw new Error('请填写退回原因。'); }
      await accountRequest(review ? 'reviews' : 'submissions',data);
      if (review && data.action === 'approve') await refreshPublished(false);
      if (!form.isConnected) return;
      navigate(review ? 'admin' : 'profile'); showToast(review ? (data.action === 'approve' ? '审核通过，作品已发布' : '稿件已退回') : '已提交审核');
    } catch (exception) { workMessage(error, exception.message, exception.workId); }
    finally { busy = false; form.querySelectorAll('[type=submit]').forEach(b => b.disabled = false); }
  });
}
async function renderEditorRoles(target) {
  function draw(users) {
    target.innerHTML = users.map(user => {
      const owner = user.role === 'superadmin', editor = user.role === 'admin';
      return `<div class="studio-row"><span><strong>${memberLink(user.username, user.id)}</strong><small>${owner ? '超级管理员' : editor ? '管理员' : '普通用户'}</small></span>${owner ? '' : `<button class="studio-action" data-user-id="${user.id}" data-grant="${!editor}">${editor ? '收回权限' : '设为管理员'}</button>`}</div>`;
    }).join('');
  }
  try {
    draw((await accountRequest('editors')).users);
    target.onclick = async event => {
      const button = event.target.closest('[data-user-id]');
      if (!button) return;
      const name = button.closest('.studio-row').querySelector('strong').textContent;
      const grant = button.dataset.grant === 'true';
      if (!confirm(grant ? `授权「${name}」审核、修改、发布和删除作品？` : `收回「${name}」的管理员权限？`)) return;
      button.disabled = true;
      try {
        draw((await accountRequest('editors',{id:Number(button.dataset.userId),grant})).users);
        showToast('管理员权限已更新');
      } catch (error) { button.disabled = false; showToast(error.message); }
    };
  } catch (error) { target.textContent = error.message; }
}
async function loadStudioSections(route) {
  const history = document.getElementById('watchHistory');
  if (history) loadWatchHistory(history);
  const watchlist = document.getElementById('privateWatchlist');
  if (watchlist) loadPrivateWatchlist(watchlist);
  const roles = document.getElementById('editorRoles');
  if (roles) {
    renderEditorRoles(roles);
    const details = document.querySelector('.member-admin');
    details.addEventListener('toggle', () => { if (details.open) loadMemberInvites(details.querySelector('#memberInvites')); });
  }
  const requestForm = document.getElementById('requestForm');
  if (requestForm) setupRequestForm(requestForm);
  const form = document.getElementById('workForm');
  if (form) setupWorkForm(form,getWork(form.dataset.id));
  const target = document.querySelector('#submissionEditor,#mySubmissions,#adminQueue');
  if (!target) return;
  const editing = target.id === 'submissionEditor';
  const reviewing = target.id === 'adminQueue' || route.startsWith('review-');
  if (editing && !currentUser()) { target.innerHTML = loginRequired('登录后查看稿件','使用提交作品的账号或管理员账号继续。'); return; }
  try {
    if (editing) {
      const id = route.slice(route.indexOf('-')+1);
      const {item} = await accountRequest('submissions/' + encodeURIComponent(id));
      if (!target.isConnected) return;
      if (reviewing && (!isAdmin() || item.status !== 'pending')) { target.textContent = '稿件已处理或当前账号没有审核权限。'; return; }
      const canReview = reviewing || (isAdmin() && item.createdBy !== currentUser().username && item.status === 'pending');
      if (!canReview && item.status !== 'approved' && route.startsWith('submission-') && item.requestOnly) {
        target.outerHTML = renderWorkRequest(item);
        setupRequestForm(document.getElementById('requestForm'));
      } else {
        target.outerHTML = renderEditor('',item,canReview);
        setupWorkForm(document.getElementById('workForm'),item);
      }
      return;
    }
    const {items} = await accountRequest(reviewing ? 'reviews' : 'submissions');
    if (!target.isConnected) return;
    target.innerHTML = items.map(item => {
      const name = escapeHTML(item.title);
      const href = reviewing ? 'review-' + item.id : item.status === 'approved' ? 'work-' + item.id : 'submission-' + item.id;
      if (reviewing) return `<div class="studio-row">${thumb(item)}<span><strong><a href="#${href}">${name}</a></strong><small>${memberLink(item.createdBy,item.authorId)} · ${escapeHTML([item.region, ...item.types].join(' · '))}</small>${item.requestNote ? `<small class="request-excerpt">${escapeHTML(item.requestNote)}</small>` : ''}</span><a class="row-link" href="#${href}">审核 ›</a></div>`;
      return `<a class="studio-row" href="#${href}">${thumb(item)}<span><strong>${name}</strong><small>${escapeHTML(item.reason || submissionStatus[item.status])}</small></span><b class="row-link">${item.status === 'approved' ? '查看' : '修改'} ›</b></a>`;
    }).join('') || `<p class="studio-empty">${reviewing ? '当前没有待审核的作品。' : '还没有上线申请。'}</p>`;
  } catch (error) {
    if (!target.isConnected) return;
    target.textContent = error.message + ' ';
    const retry = document.createElement('button'); retry.className = 'studio-action'; retry.textContent = '重试';
    retry.onclick = () => loadStudioSections(route); target.append(retry);
  }
}
document.addEventListener('click', async event => {
  const opener = event.target.closest('[data-profile-tool]');
  if (!opener || !currentUser()) return;
  if (opener.dataset.profileTool === 'account') openProfileAccount(opener);
  else {
    const user = currentUser();
    try { await ensureOwnShowcase(user); } catch (e) { showToast(e.message); return; }
    if (currentUser() === user && opener.isConnected) openPicker(opener.dataset.profileTool,opener);
  }
});
async function loadMemberInvites(target) {
  const labels = {available:'未绑定',issued:'已发码',expired:'认领码已过期',claimed:'已绑定'};
  try {
    const {members} = await accountRequest('member-invites');
    target.innerHTML = members.map(m => `<div class="studio-row"><span><strong>${escapeHTML(m.username)}</strong><small>${labels[m.status]}</small></span>${m.status === 'claimed' ? '' : `<button type="button" class="studio-action" data-member="${escapeHTML(m.username)}" data-issued="${m.status === 'issued'}">${m.status === 'issued' ? '重新发码' : '生成认领码'}</button>`}</div>`).join('');
    target.onclick = async event => {
      const button = event.target.closest('[data-member]');
      if (!button) return;
      const name = button.dataset.member;
      if (button.dataset.issued === 'true' && !confirm('重新生成后，之前的认领码会失效。继续吗？')) return;
      button.disabled = true;
      try {
        const {code} = await accountRequest('member-invites',{username:name});
        const sheet = openSheet(name + '的认领码',`<div class="sheet-scroll"><p>请私下交给「${escapeHTML(name)}」本人，用于首次绑定邮箱。</p><input class="invite-code" aria-label="一次性认领码" readonly value="${escapeHTML(code)}"></div><div class="sheet-foot"><button type="button" class="studio-action" data-copy>复制认领码</button><button type="button" class="button button-primary" data-close>完成</button></div>`,button);
        sheet.querySelector('[data-copy]').onclick = async () => {
          try { await navigator.clipboard.writeText(code); sheet.querySelector('[data-copy]').textContent = '已复制'; }
          catch { sheet.querySelector('input').select(); }
        };
        button.dataset.issued = 'true'; button.textContent = '重新发码'; button.parentElement.querySelector('small').textContent = '已发码';
      } catch (error) { showToast(error.message); }
      finally { button.disabled = false; }
    };
  } catch (error) { target.textContent = error.message; }
}
const privateListMarkup = new WeakMap();
const incompletePrivateLists = new WeakMap();

function updatePrivateList(target, html) {
  target.querySelector('[data-private-error]')?.remove();
  if (privateListMarkup.get(target) === html) return;
  const expanded = target.querySelector('details')?.open;
  const focused = target.contains(document.activeElement) ? document.activeElement : null;
  target.innerHTML = html;
  privateListMarkup.set(target, html);
  const details = target.querySelector('details');
  if (expanded && details) details.open = true;
  if (focused) {
    const matching = [...target.querySelectorAll('a,button,summary')].find(el =>
      (focused.matches('summary') && el.matches('summary')) ||
      (focused.href && el.href === focused.href) ||
      (focused.dataset.removeWatchlist && el.dataset.removeWatchlist === focused.dataset.removeWatchlist));
    matching?.focus({preventScroll:true});
  }
}

function privateListError(target, error, retry) {
  if (!target.isConnected) return;
  if (!privateListMarkup.has(target)) target.replaceChildren();
  let notice = target.querySelector('[data-private-error]');
  if (!notice) {
    notice = document.createElement('p');
    notice.dataset.privateError = '';
    notice.className = 'studio-empty';
    notice.setAttribute('role', 'status');
    target.append(notice);
  }
  notice.innerHTML = `${escapeHTML(error.message)} <button type="button" class="studio-action">重试</button>`;
  notice.querySelector('button').onclick = retry;
}

document.addEventListener('published-works-updated', () => {
  for (const target of document.querySelectorAll('#privateWatchlist,#watchHistory')) {
    incompletePrivateLists.get(target)?.();
  }
});

let privateListRead = 0;
async function loadPrivateWatchlist(target) {
  const user = currentUser(), read = ++privateListRead;
  const current = () => target.isConnected && currentUser() === user && read === privateListRead;
  try {
    await pendingWatchlistWrite;
    const response = await accountRequest('watchlist');
    if (!current()) return;
    let ids = response.workIds;
    function row(work) {
      const id = escapeHTML(work.id), title = escapeHTML(work.title);
      return `<div class="studio-row watchlist-row"><a href="#work-${id}">${thumb(work)}<strong>${title}</strong></a>
        <button type="button" class="studio-action" data-remove-watchlist="${id}" aria-label="从想看清单移除《${title}》">移除</button></div>`;
    }
    function draw() {
      if (!current()) return;
      const works = ids.map(getWork).filter(Boolean);
      if (works.length < ids.length) incompletePrivateLists.set(target, draw);
      else incompletePrivateLists.delete(target);
      const more = works.slice(5);
      let html = works.slice(0,5).map(row).join('') || '<p class="studio-empty">还没有想看的作品。<a class="text-link" href="#home">去发现 ›</a></p>';
      if (more.length) html += `<details class="history-more"><summary>还有 ${more.length} 部想看</summary>${more.map(row).join('')}</details>`;
      updatePrivateList(target, html);
    }
    draw();
    target.onclick = async event => {
      const button = event.target.closest('[data-remove-watchlist]');
      if (!button || button.disabled || currentUser() !== user) return;
      const id = button.dataset.removeWatchlist;
      const index = [...target.querySelectorAll('[data-remove-watchlist]')].indexOf(button);
      const restoreFocus = document.activeElement === button;
      button.disabled = true;
      try {
        await setWatchlistEntry(user, id, false);
        if (!target.isConnected || currentUser() !== user) return;
        if (current()) {
          ids = ids.filter(key => key !== id);
          draw();
        } else {
          await loadPrivateWatchlist(target);
        }
        if (restoreFocus) {
          const buttons = target.querySelectorAll('[data-remove-watchlist]');
          (buttons[Math.min(index, buttons.length - 1)] || target.querySelector('a'))?.focus({preventScroll:true});
        }
        showToast('已从想看清单移除');
      } catch (error) {
        if (button.isConnected && currentUser() === user) { button.disabled = false; showToast(error.message); }
      }
    };
  } catch (error) {
    if (current()) privateListError(target, error, () => loadPrivateWatchlist(target));
  }
}

function watchHistoryLink({item, routeId, work}, featured) {
  const hasTime = Number.isFinite(item.seconds) && item.seconds > 0;
  const detail = item.episode ? (hasTime ? item.episode + ' · ' + episodeTime(item.seconds) : '上次打开' + item.episode)
    : item.platform ? '上次打开了' + item.platform : '上次打开了作品';
  const when = new Date(item.opened * 1000).toLocaleString('zh-CN', {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
  const action = item.episode ? (hasTime ? '继续播放' : '播放这集') : '查看作品';
  return `<a class="studio-row ${featured ? 'resume-card' : ''}" href="#work-${escapeHTML(routeId)}"
    ${item.episode ? 'data-resume-work="' + escapeHTML(work.id) + '"' : ''}>${thumb(work)}
    <span><strong>${escapeHTML(work.title)}</strong><small>${escapeHTML(detail)}</small>
    <small>${escapeHTML(when)}</small></span><b class="row-link">${action} ›</b></a>`;
}

let historyListRead = 0;
async function loadWatchHistory(target) {
  const user = currentUser(), read = ++historyListRead;
  const current = () => target.isConnected && currentUser() === user && read === historyListRead;
  try {
    await progressWrites;
    const {items} = await accountRequest('history');
    function draw() {
      if (!current()) return;
      const entries = items.flatMap(item => {
        const routeId = animeSeasonById.has(item.id + '-all') && item.episode ? item.id + '-all' : item.id;
        const work = seasonPlaybackWork(routeId);
        return work ? [{item, routeId, work}] : [];
      });
      if (entries.length < items.length) incompletePrivateLists.set(target, draw);
      else incompletePrivateLists.delete(target);
      const featured = entries.find(entry => entry.item.episode && entry.item.seconds > 0) || entries[0];
      target.closest('section').querySelector('h2').textContent = !featured || featured.item.seconds > 0 ? '继续观看' : '最近打开';
      const others = entries.filter(entry => entry !== featured);
      let html = featured ? watchHistoryLink(featured, true) : '<p class="studio-empty">从作品页开始观看后，可以在这里找到记录。</p>';
      if (others.length) html += `<details class="history-more"><summary>其他观看记录（${others.length}）</summary>${others.map(entry => watchHistoryLink(entry, false)).join('')}</details>`;
      updatePrivateList(target, html);
    }
    draw();
  } catch (error) {
    if (current()) privateListError(target, error, () => loadWatchHistory(target));
  }
}
