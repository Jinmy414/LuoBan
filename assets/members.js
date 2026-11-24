// Member links work for guests and can be shared or opened in a new tab.
function memberHref(name, id) {
  return Number.isSafeInteger(id) && id > 0 ? '#member-' + id : '#profile-' + encodeURIComponent(name);
}

function memberLink(name, id) {
  if (!name || name === '罗瓣社区') return escapeHTML(name);
  return `<a class="member-name" href="${memberHref(name, id)}" aria-label="查看${escapeHTML(name)}的主页">${escapeHTML(name)}</a>`;
}

function memberAvatar(member) {
  return member.hasAvatar
    ? `<img class="member-avatar" src="${avatarURL(member.username)}" loading="lazy" alt="">`
    : `<span class="member-avatar member-initial" aria-hidden="true">${escapeHTML(Array.from(member.username)[0])}</span>`;
}

function showMemberError(target, error, retry) {
  if (!target.isConnected) return;
  target.innerHTML = `<p role="status">${escapeHTML(error.message)}</p>` +
    (error.status === 404 ? '<a class="studio-action" href="#members">浏览成员</a>' : '<button class="studio-action" type="button">重新加载</button>');
  const button = target.querySelector('button');
  if (button) button.onclick = retry;
}

async function memberData(path) {
  try {
    return await accountRequest(path);
  } catch (e) {
    if (e.code !== 'STATIC_SITE') throw e;
    const members = IMPORTED_USERNAMES.map(username => ({id:null, username, original:username, hasAvatar:false}));
    if (path === 'members') return {members};
    const person = members.find(m => path === 'members/name/' + encodeURIComponent(m.username));
    if (person) return {...person, favoriteIds:[], featuredComments:[], workIds:[]};
    throw Object.assign(Error('这个主页需要在罗瓣主站打开。'), {status:404});
  }
}

async function loadMemberDirectory(target) {
  try {
    const {members} = await memberData('members');
    if (!target.isConnected) return;
    const sorted = members.sort((a, b) => a.username.localeCompare(b.username, 'zh-CN'));
    target.innerHTML = `<label class="picker-search member-search"><span class="search-icon" aria-hidden="true"></span>
      <input type="search" aria-label="搜索成员" placeholder="搜索成员名字"></label><div class="member-grid"></div>`;
    const input = target.querySelector('input'), grid = target.querySelector('.member-grid');
    function draw() {
      const term = input.value.normalize('NFKC').trim().toLowerCase();
      const found = sorted.filter(m => [m.username,m.original].some(s => s?.toLowerCase().includes(term)));
      grid.innerHTML = found.map(m => `<a class="member-tile" href="${memberHref(m.username, m.id)}">
        ${memberAvatar(m)}<strong>${escapeHTML(m.username)}</strong><span aria-hidden="true">›</span></a>`).join('') ||
        '<p class="studio-empty" role="status">没有找到这位成员。</p>';
    }
    input.oninput = draw;
    draw();
  } catch (e) { showMemberError(target, e, () => loadMemberDirectory(target)); }
}

async function loadPublicMember(target, route) {
  try {
    const path = route.startsWith('member-') ? 'id/' + encodeURIComponent(route.slice(7))
      : 'name/' + encodeURIComponent(decodeURIComponent(route.slice(8)));
    const member = await memberData('members/' + path);
    if (!target.isConnected) return;
    const publishedWork = id => getWork(id) || SEED_WORKS.find(w => w.id === id);
    const favorites = member.favoriteIds.map(publishedWork).filter(Boolean);
    const created = member.workIds.map(publishedWork).filter(Boolean);
    const localReviews = member.original ? SEED_WORKS.flatMap(w => w.comments.filter(c => c.user === member.original)
      .map(c => ({workId:w.id, id:c.id, text:c.text}))) : [];
    const featured = member.featuredComments;
    const recent = member.id ? state.works.flatMap(w => w.comments.filter(c => c.sharedComment && c.authorId === member.id)
      .map(c => ({...c,workId:w.id}))).sort((a,b) => b.date.localeCompare(a.date)) : [];
    const quotes = (featured.length ? featured : [...recent,...localReviews].slice(0, 3)).map(c => {
      const work = publishedWork(c.workId);
      return work ? `<article class="profile-quote">${commentScoreBadge(work,member.username,c.score ?? work.userRatings?.[member.original])}<p>${escapeHTML(c.text)}</p><a href="#work-${escapeHTML(work.id)}">《${escapeHTML(work.title)}》</a></article>` : '';
    }).join('');
    target.className = 'studio-page member-page';
    target.innerHTML = `<a class="back-link" href="#members">← 罗瓣成员</a>
      <header class="profile-banner">${memberAvatar(member)}<h1>${escapeHTML(member.username)}的罗瓣</h1>
      ${member.id && member.id === activeAccount?.id ? '<a class="studio-action" href="#profile">编辑我的主页</a>' : ''}</header>
      <section class="studio-panel"><div class="panel-heading"><h2>三部最爱</h2></div>
      ${favorites.length ? '<div class="favorite-shelf">' + favorites.map(w => workCard(w,true)).join('') + '</div>' : '<p class="studio-empty">还没有展示最爱作品。</p>'}</section>
      <div class="profile-columns"><section class="studio-panel"><div class="panel-heading"><h2>${featured.length ? '展示评论' : '作品短评'}</h2></div>
      ${quotes || '<p class="studio-empty">还没有展示短评。</p>'}</section>
      <section class="studio-panel"><div class="panel-heading"><h2>已发布作品</h2></div>
      ${created.map(w => `<a class="studio-row" href="#work-${escapeHTML(w.id)}">${thumb(w)}<span>${escapeHTML(w.title)}</span><small>${displayYear(w.year)}</small></a>`).join('') || '<p class="studio-empty">还没有发布作品。</p>'}</section></div>`;
  } catch (e) { showMemberError(target, e, () => loadPublicMember(target, route)); }
}

let ownShowcase = null;
function applyShowcase(user, data) {
  if (currentUser() !== user) return;
  user.favoriteIds = data.favoriteIds;
  user.featuredComments = data.featuredComments;
  user.featuredCommentIds = data.featuredComments.map(c => c.workId + ':' + c.id);
  try { saveState(); } catch { /* The server has the saved selections. */ }
}

function featuredSelection(user, ids) {
  const comments = new Map(profileComments(user).map(c => [c.key, c]));
  return ids.map(id => comments.get(id)).filter(Boolean).map(c => ({id:c.id, workId:c.work.id, text:c.text, score:workCommentScore(c.work,user.username,c.score)}));
}

function ensureOwnShowcase(user) {
  if (ownShowcase?.user === user) return ownShowcase.promise;
  const pending = {user};
  ownShowcase = pending;
  const legacy = {};
  if (user.favoriteIds.length) legacy.favoriteIds = user.favoriteIds;
  const featured = featuredSelection(user, user.featuredCommentIds);
  if (featured.length) legacy.featuredComments = featured;
  pending.promise = (Object.keys(legacy).length
    ? accountRequest('member-showcase', {accountId:user.accountId, initialize:true, ...legacy})
    : accountRequest('members/id/' + user.accountId))
    .then(data => { if (ownShowcase === pending) applyShowcase(user, data); })
    .catch(e => { if (ownShowcase === pending) ownShowcase = null; throw e; });
  return pending.promise;
}

async function saveShowcase(user, changes) {
  await ensureOwnShowcase(user);
  if (currentUser() !== user) throw Error('请重新登录后再保存。');
  applyShowcase(user, await accountRequest('member-showcase', {accountId:user.accountId, ...changes}));
}
