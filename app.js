const STORAGE_KEY = 'luoban-static-v1';

const DEFAULT_TYPE_OPTIONS = ['原创', '动画', '轻改', '漫改', '游戏改', '特摄', '机战', '异世界', '热血', '奇幻', '玄幻', '科幻', '校园', '搞笑', '日常', '恋爱', '百合', '运动', '智斗', '偶像', '职场', '悬疑', '治愈', '冒险', '剧情', '动作', '历史', '推理', '后宫', '音乐', '犯罪'];
const IMPORTED_USERNAMES = ['罗', '硬', '金', '文', '鹏', '龙', '飞', '鲨', '任', '虎', '马'];
const REMOVED_TYPES = new Set(['游戏', '小说']);
const TEST_USERNAMES = new Set(['demo', 'riko', 'mulberry']);
const TEST_WORK_IDS = new Set(['tide-letter', 'summer-radio', 'zero-garden', 'mountain-shop', 'moon-post', 'mist-island', 'cinema-town', 'daylight-route', 'orange-lab', 'paper-universe', 'echo-far', 'night-orbit']);
const REGION_OPTIONS = ['中国', '日本', '欧美', '其他'];
const YEAR_OPTIONS = ['80年代及以前', '90年代', '00年代', '10年代', '20年代'];
const POSTER_OPTIONS = {
  mint: 'linear-gradient(145deg, #b8d7cc 0%, #4d8d7b 48%, #0f4f47 100%)',
  dusk: 'linear-gradient(145deg, #f2b28f 0%, #bd6d5d 46%, #5d373a 100%)',
  sky: 'linear-gradient(145deg, #b7d8df 0%, #6099a4 48%, #28556a 100%)',
  lavender: 'linear-gradient(145deg, #d8c9dc 0%, #9b789c 50%, #4d405d 100%)',
  lemon: 'linear-gradient(145deg, #f2e4a9 0%, #b5aa55 48%, #566331 100%)',
  ink: 'linear-gradient(145deg, #9ab1b2 0%, #4f6869 46%, #1e3036 100%)'
};

const RAW_SEED_WORKS = (window.LUOBAN_ANIMATION_WORKS || []).map(work => ({
  ...work,
  userRatings: work.userRatings && typeof work.userRatings === 'object' ? work.userRatings : {},
  rating: Number.isFinite(Number(work.rating)) && work.rating !== null && work.rating !== '' ? Number(work.rating) : null,
  votes: Number(work.votes) || 0,
  ratingSum: Number(work.ratingSum) || 0,
  comments: Array.isArray(work.comments) ? work.comments : []
}));

const SEED_WORKS = [...new Map(RAW_SEED_WORKS.map(work => [work.title.trim().toLowerCase(), work])).values()].filter(work => !TEST_WORK_IDS.has(work.id));

const defaultState = {
  users: IMPORTED_USERNAMES.map(username => ({ username, favoriteIds: [], featuredCommentIds: [] })),
  works: SEED_WORKS,
  types: DEFAULT_TYPE_OPTIONS,
  deletedWorkIds: [],
  query: '',
  filters: { types: [], regions: [], years: [], rank: '', scoreMin: 0, scoreMax: 10 },
  sort: 'hot'
};

let state = loadState();
saveState();
let shelfIndex = 0;
let shownCount = 18;
let filtersExpanded = false;
let scrollToCatalog = false;
let lastHomePosition = null;
const homeQuotes = shuffle(window.LUOBAN_QUOTES || []).slice(0, 3);
let selectedRating = null;
let featuredPopularIds = [];
let featuredNicheIds = [];
let toastTimer = null;


function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!saved) return structuredClone(defaultState);
    const deletedWorkIds = new Set(Array.isArray(saved.deletedWorkIds) ? saved.deletedWorkIds : []);
    const seedWorks = structuredClone(SEED_WORKS).filter(work => !deletedWorkIds.has(work.id));
    const savedWorks = Array.isArray(saved.works) ? saved.works.filter(work => !isBgmWork(work) && !isTestWork(work)) : [];
    const savedById = new Map(savedWorks.map(work => [work.id, work]));
    const mergedWorks = [
      ...seedWorks.map(seed => savedById.has(seed.id) ? mergeSeedWork(seed, savedById.get(seed.id)) : seed),
      ...savedWorks.filter(work => !seedWorks.some(seed => seed.id === work.id)).map(normalizeWork)
    ];
    const savedUsers = Array.isArray(saved.users) ? saved.users.filter(user => user.accountId || !TEST_USERNAMES.has(user.username)) : [];
    const users = [...new Set([...IMPORTED_USERNAMES, ...savedUsers.map(u => u.username)])].map(username => {
      const old = savedUsers.find(u => u.username === username);
      return { username, accountId: old?.accountId, favoriteIds: old?.favoriteIds || [], featuredCommentIds: old?.featuredCommentIds || [] };
    });
    return {
      ...structuredClone(defaultState),
      query: saved.query || '',
      sort: saved.sort || 'hot',
      types: Array.isArray(saved.types) && saved.types.length ? [...new Set(saved.types.filter(type => type && !REMOVED_TYPES.has(type)))] : [...DEFAULT_TYPE_OPTIONS],
      deletedWorkIds: [...deletedWorkIds],
      filters: { ...defaultState.filters, ...(saved.filters || {}), scoreMin: saved.filters?.scoreMin ?? saved.filters?.score ?? 0, scoreMax: saved.filters?.scoreMax ?? 10 },
      users,
      works: (mergedWorks.length ? mergedWorks : seedWorks).map(work => ({ ...work, types: [...new Set((work.types || []).filter(type => !REMOVED_TYPES.has(type)))] }))
    };
  } catch { return structuredClone(defaultState); }
}

function saveState() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
function getWork(id) { return state.works.find(work => work.id === id); }
function getUser(username) { return state.users.find(user => user.username === username); }
function typeOptions() { return state?.types?.length ? state.types : DEFAULT_TYPE_OPTIONS; }
function isBgmWork(work) { return String(work?.createdBy || '').toLowerCase() === 'bgm' || String(work?.createdBy || '').toLowerCase() === 'bangumi' || String(work?.id || '').startsWith('bgm-') || String(work?.sourceUrl || '').includes('bgm.tv'); }
function isTestWork(work) { return TEST_WORK_IDS.has(work?.id); }
function normalizeWork(work) {
  if (!String(work?.sourceLabel || '').includes('动画名称.xlsx')) return work;
  const userRatings = work.userRatings && typeof work.userRatings === 'object' ? work.userRatings : {};
  const ratings = Object.values(userRatings).map(Number).filter(value => Number.isFinite(value));
  const ratingSum = ratings.reduce((sum, value) => sum + value, 0);
  return { ...work, ratingSum, votes: ratings.length, rating: ratings.length ? ratingSum / ratings.length : null, comments: Array.isArray(work.comments) ? work.comments.filter(comment => !String(comment.id).startsWith('sheet-comment-')) : [] };
}
function mergeSeedWork(seed, saved) {
  const userRatings = { ...(seed.userRatings || {}), ...((saved.userRatings && typeof saved.userRatings === 'object') ? saved.userRatings : {}) };
  const seedComments = Array.isArray(seed.comments) ? seed.comments : [];
  const savedComments = Array.isArray(saved.comments) ? saved.comments : [];
  const comments = [...seedComments, ...savedComments.filter(comment => !seedComments.some(item => item.id === comment.id))];
  const savedCover = String(saved.coverImage || '');
  const migratedCover = /^https?:\/\/lain\.bgm\.tv\//i.test(savedCover) && String(seed.coverImage || '').startsWith('assets/covers/') ? seed.coverImage : (saved.coverImage || seed.coverImage);
  return normalizeWork({
    ...seed,
    ...saved,
    coverImage: migratedCover,
    poster: saved.poster || seed.poster,
    userRatings,
    comments
  });
}
function currentRoute() { return location.hash.slice(1) || 'home'; }
function currentUser() { return activeAccount ? getUser(activeAccount.username) : null; }
function isAdmin(user = currentUser()) { return Boolean(user && ['admin','superadmin'].includes(activeAccount?.role) && user.accountId === activeAccount.id); }
function registeredUserCount() { return Math.max(1, state.users.filter(user => user.username !== 'admin').length); }

function applyAccount(account) {
  sessionRevision++;
  activeAccount = account;
  if (!account) return;
  let user = state.users.find(item => item.accountId === account.id);
  if (user && user.username !== account.username) {
    const previous = user.username;
    for (const work of state.works) {
      if (work.createdBy === previous) work.createdBy = account.username;
      if (Object.hasOwn(work.userRatings || {}, previous)) {
        work.userRatings[account.username] = work.userRatings[previous];
        delete work.userRatings[previous];
      }
      for (const comment of work.comments) {
        if (comment.user === previous) comment.user = account.username;
        if (comment.likedBy) comment.likedBy = [...new Set(comment.likedBy.map(name => name === previous ? account.username : name))];
      }
    }
    user.username = account.username;
  }
  if (!user) {
    user = getUser(account.username);
    if (!user) {
      user = { username: account.username, favoriteIds: [], featuredCommentIds: [] };
      state.users.push(user);
    }
    user.accountId = account.id;
  }
  saveState();
}
function popularityThreshold() { return registeredUserCount() / 3; }
function workRank(work) { const threshold = popularityThreshold(); if (work.votes > threshold) return 'hot'; if (work.votes < threshold) return 'cold'; return ''; }
function popularityThresholdLabel() { const threshold = popularityThreshold(); return Number.isInteger(threshold) ? String(threshold) : threshold.toFixed(1); }

function escapeHTML(value = '') { return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }
function safeImage(value = '') { return /^\/api\/works\/entry-[a-f0-9]{32}\/cover\?v=\d+$/.test(value) || /^https?:\/\//i.test(value) || /^(?:\.\/)?assets\/covers\//i.test(value) || /^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(value) ? value : ''; }
function formatRating(value, votes = null) { return votes === 0 || value === null || value === undefined || value === '' ? '—' : Number(value).toFixed(1); }
function displayYear(year) { return year ? String(year) : '年份待补'; }
function displayRating(work) { if (!work.votes) return null; return state.sort === 'score' ? work.rating : Math.min(10, work.rating + (workRank(work) === 'hot' ? 1 : 0)); }
function yearBucket(year) {
  if (year <= 1989) return '80年代及以前';
  if (year <= 1999) return '90年代';
  if (year <= 2009) return '00年代';
  if (year <= 2019) return '10年代';
  return '20年代';
}
function shuffle(items) { return [...items].sort(() => Math.random() - .5); }
function refreshFeatured() {
  const popular = state.works.filter(work => workRank(work) === 'hot' && work.rating > 8);
  const niche = state.works.filter(work => workRank(work) === 'cold' && work.rating > 8);
  featuredPopularIds = shuffle(popular).slice(0, 3).map(work => work.id);
  featuredNicheIds = shuffle(niche).slice(0, 3).map(work => work.id);
}

function coverMarkup(work, extraClass = '') {
  const image = safeImage(work.coverImage);
  const style = image ? `style="background-image:url('${escapeHTML(image)}')"` : `style="--cover:${work.poster || POSTER_OPTIONS.mint}"`;
  return `<div class="work-cover ${extraClass} ${image ? 'has-image' : ''}" ${style}>
    <span class="cover-symbol">${escapeHTML(work.title.slice(0, 1))}</span>
    <span class="cover-title">${escapeHTML(work.title)}</span>
  </div>`;
}

function workCard(work, feature = false) {
  const tagHTML = work.types.slice(0, 3).map(type => `<span class="type-tag">${escapeHTML(type)}</span>`).join('');
  const rank = workRank(work);
  const rankTag = rank === 'hot' ? '<span class="type-tag hot">热门</span>' : rank === 'cold' ? '<span class="type-tag cold">冷门</span>' : '';
  if (feature) return `<a class="feature-card" href="#work-${escapeHTML(work.id)}">
    ${coverMarkup(work)}
    <div class="feature-info"><strong>${escapeHTML(work.title)}</strong><div class="feature-meta"><span>${displayYear(work.year)} · ${escapeHTML(work.region)}</span><span class="rating">${formatRating(displayRating(work), work.votes)}</span></div></div>
  </a>`;
  return `<a class="work-card" href="#work-${escapeHTML(work.id)}">
    ${coverMarkup(work)}
    <div class="feature-info"><strong>${escapeHTML(work.title)}</strong><div class="feature-meta"><span>${displayYear(work.year)} · ${escapeHTML(work.region)}</span><span class="rating">${formatRating(displayRating(work), work.votes)}</span></div><div class="type-list">${tagHTML}${rankTag}</div></div>
  </a>`;
}

function renderHeader() {
  const route = currentRoute();
  const active = route.startsWith('profile') ? 'profile' : route.startsWith('create') || route.startsWith('edit') ? 'create' : route === 'admin' ? 'admin' : 'home';
  document.querySelectorAll('[data-nav]').forEach(link => {
    const selected = link.dataset.nav === active;
    link.classList.toggle('is-active', selected);
    if (selected) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  const user = currentUser();
  document.getElementById('headerUser').innerHTML = user
    ? `${isAdmin(user) ? '<a class="admin-link" href="#admin" data-nav="admin">管理后台</a>' : ''}<button class="user-button" type="button" data-nav-profile="${escapeHTML(user.username)}"><img class="nav-avatar" src="${avatarURL(user.username)}" alt=""><span>${escapeHTML(user.username)}</span></button><button class="text-link" type="button" data-logout>退出</button>`
    : '<button class="login-link" type="button" data-login>登录 / 注册</button>';
  const search = document.getElementById('globalSearch');
  if (search && search.value !== state.query) search.value = state.query;
}

const editorialPicks = [
  { title: '灌篮高手', color: 'court', line: '从湘北的体育馆出发，重回那个为篮球着迷的夏天。' },
  { title: '冰菓', color: 'forest', line: '走进神山高中的古典部，在日常的小事里寻找谜底。' },
  { title: '龙珠', color: 'night', line: '跟着悟空与伙伴踏上旅途，从寻找第一颗龙珠开始。' }
];

function renderSpotlight() {
  const picks = editorialPicks.map(pick => ({ ...pick, work: state.works.find(w => w.title === pick.title) })).filter(pick => pick.work);
  if (!picks.length) return '';
  shelfIndex = (shelfIndex % picks.length + picks.length) % picks.length;
  const pick = picks[shelfIndex];
  const deck = picks.map((entry, i) => {
    const slot = (i - shelfIndex + picks.length) % picks.length;
    return `<img class="shelf-poster pos-${slot}" src="${escapeHTML(safeImage(entry.work.coverImage) || 'assets/logo-snail.png')}" alt="" draggable="false">`;
  }).join('');
  return `<section class="spotlight ${pick.color}" aria-label="本期选片"><div class="spot-copy">
    <div class="spot-label"><i></i>本期选片</div><div class="spot-caption" aria-live="polite"><h2>${escapeHTML(pick.title)}</h2><p>${pick.line}</p></div>
    <a href="#work-${escapeHTML(pick.work.id)}" class="spot-action">查看作品 <span aria-hidden="true">↗</span></a>
    </div><div class="poster-deck" aria-hidden="true">${deck}</div>
    <div class="shelf-controls"><button type="button" data-shift="-1" aria-label="上一部选片">‹</button><span>${shelfIndex + 1} / ${picks.length}</span><button type="button" data-shift="1" aria-label="下一部选片">›</button></div></section>`;
}

function shiftPick(direction) {
  const old = document.querySelector('.spotlight');
  if (!old) return;
  shelfIndex += direction;
  const template = document.createElement('template');
  template.innerHTML = renderSpotlight();
  const next = template.content.firstElementChild;
  old.className = next.className;
  old.querySelector('.spot-caption').replaceWith(next.querySelector('.spot-caption'));
  old.querySelector('.spot-action').href = next.querySelector('.spot-action').href;
  old.querySelector('.shelf-controls span').textContent = next.querySelector('.shelf-controls span').textContent;
  next.querySelectorAll('.shelf-poster').forEach((img, i) => { old.querySelectorAll('.shelf-poster')[i].className = img.className; });
}

function renderHome() {
  const filtered = filteredWorks();
  const rail = (label, ids) => `<section class="pick-group"><h3>${label}</h3><div class="feature-grid">${ids.length ? ids.map(getWork).filter(Boolean).map(w => workCard(w, true)).join('') : '<p class="empty-state">还没有符合条件的作品。</p>'}</div></section>`;
  const date = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
  return `<div class="home-heading"><h1>发现</h1><span>${date}</span></div>${renderSpotlight()}
    <section class="discover-section" id="discover"><div class="section-heading"><h2>高分片单</h2><button class="text-link" type="button" data-refresh-picks>换一组 ↻</button></div><div class="pick-groups">${rail('热门高分', featuredPopularIds)}${rail('冷门高分', featuredNicheIds)}</div></section>
    <section id="catalog" class="works-section"><div class="section-heading"><h2>作品库</h2><span class="result-count" role="status">${filtered.length} 部作品</span></div>${renderFilters()}
      <div class="works-grid">${filtered.length ? filtered.slice(0, shownCount).map(w => workCard(w)).join('') : '<div class="empty-state"><strong>没有找到匹配的作品</strong><button class="button button-ghost" type="button" data-clear-filters>清除搜索与筛选</button></div>'}</div>
      ${filtered.length > shownCount ? '<button class="button button-ghost load-more" type="button" data-more>显示更多作品</button>' : ''}</section>
    ${homeQuotes.length ? `<section class="quotes-section"><h2>台词摘录</h2><div class="quote-grid">${homeQuotes.map(item => `<figure><blockquote>${escapeHTML(item.quote)}</blockquote><figcaption>《${escapeHTML(item.work)}》</figcaption></figure>`).join('')}</div></section>` : ''}`;
}

function renderFilters() {
  const f = state.filters;
  const chip = (kind, value, selected) => `<button class="filter-chip ${selected ? 'is-selected' : ''}" type="button" aria-pressed="${selected}" data-filter-${kind}="${escapeHTML(value)}">${escapeHTML(value)}</button>`;
  const exactYears = Array.from({ length: 16 }, (_, i) => 2010 + i).filter(year => year <= new Date().getFullYear());
  const rankChip = (value, label) => `<button class="filter-chip rank-chip rank-${value} ${f.rank === value ? 'is-selected' : ''}" type="button" data-filter-rank="${value}">${label}</button>`;
  const count = f.types.length + f.years.length + f.regions.length + Number(Boolean(f.rank)) + Number(f.scoreMin !== 0 || f.scoreMax !== 10);
  return `<div class="filter-panel"><details class="filter-details" ${filtersExpanded ? 'open' : ''}><summary>筛选条件${count ? ' · ' + count : ''}</summary>
    <div class="filter-row"><span class="filter-label">类型</span><div class="filter-options">${typeOptions().map(value => chip('type', value, f.types.includes(value))).join('')}${rankChip('hot', '热门')}${rankChip('cold', '冷门')}</div></div>
    <div class="filter-row"><span class="filter-label">地区</span><div class="filter-options">${REGION_OPTIONS.map(value => chip('region', value, f.regions.includes(value))).join('')}</div></div>
    <div class="filter-row"><span class="filter-label">年代</span><div class="filter-options">${YEAR_OPTIONS.map(value => chip('year', value, f.years.includes(value))).join('')}<select class="select-compact" id="exactYear" aria-label="选择具体年份"><option value="">具体年份</option>${exactYears.map(year => `<option value="${year}" ${f.years.includes(String(year)) ? 'selected' : ''}>${year}</option>`).join('')}</select></div></div>
    <div class="filter-row"><span class="filter-label">评分</span><div class="score-filter score-range"><input id="scoreMin" type="range" min="0" max="10" step="0.5" value="${f.scoreMin}" aria-label="最低评分" /><input id="scoreMax" type="range" min="0" max="10" step="0.5" value="${f.scoreMax}" aria-label="最高评分" /><span class="score-value">${f.scoreMin === 0 && f.scoreMax === 10 ? '不限评分' : `${f.scoreMin} – ${f.scoreMax} 分`}</span></div></div>
    </details><div class="sort-bar"><div class="sort-tabs"><button class="sort-tab ${state.sort === 'hot' ? 'is-selected' : ''}" type="button" data-sort="hot">热门优先</button><button class="sort-tab ${state.sort === 'score' ? 'is-selected' : ''}" type="button" data-sort="score">高分优先</button><button class="sort-tab ${state.sort === 'new' ? 'is-selected' : ''}" type="button" data-sort="new">最新加入</button></div><span class="result-count">${filteredWorks().length} 部作品 · ${state.sort === 'score' ? '按真实评分' : '热门作品展示分 +1'}</span></div>
  </div>`;
}

function filteredWorks() {
  const f = state.filters;
  const query = state.query.trim().toLowerCase();
  const result = state.works.filter(work => {
    const searchable = [work.title, work.region, ...work.types].join(' ').toLowerCase();
    const typeMatch = !f.types.length || f.types.every(type => work.types.includes(type));
    const regionMatch = !f.regions.length || f.regions.some(region => work.region === region);
    const yearMatch = !f.years.length || f.years.some(year => String(work.year) === year || (work.year && yearBucket(work.year) === year));
    const rankMatch = !f.rank || workRank(work) === f.rank;
    const scoreMatch = work.rating >= Number(f.scoreMin ?? 0) && work.rating <= Number(f.scoreMax ?? 10);
    return (!query || searchable.includes(query)) && typeMatch && regionMatch && yearMatch && rankMatch && scoreMatch;
  });
  return result.sort((a, b) => state.sort === 'score' ? b.rating - a.rating : state.sort === 'new' ? Number(b.year || 0) - Number(a.year || 0) : (b.votes * b.rating) - (a.votes * a.rating));
}

function loginRequired(title, description) {
  return `<div class="login-required"><div class="mini-symbol">✦</div><h2>${title}</h2><p>${description}</p><button class="button button-primary" type="button" data-login>登录 / 注册</button></div>`;
}

function renderAdmin() {
  const user = currentUser();
  if (!user || !isAdmin(user)) return `<div class="login-required"><div class="mini-symbol">⌘</div><h2>管理员入口</h2><p>这里可以管理所有作品、类型和封面。请输入管理员账号进入。</p><button class="button button-primary" type="button" data-admin-login>管理员登录</button></div>`;
  const works = [...state.works].sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
  const rows = works.map(work => `<div class="admin-work-row"><div class="admin-work-title"><button class="text-link" type="button" data-open-work="${escapeHTML(work.id)}">${escapeHTML(work.title)}</button><span>${escapeHTML(work.region)} · ${displayYear(work.year)}</span></div><div class="admin-work-types">${work.types.map(type => `<span class="type-tag">${escapeHTML(type)}</span>`).join('') || '<span class="muted">未分类</span>'}</div><div class="admin-work-source">${work.coverImage ? '有封面' : '无封面'} · ${formatRating(work.rating, work.votes)} 分</div><div class="admin-work-actions"><button class="button button-ghost button-small" type="button" data-edit-work="${escapeHTML(work.id)}">编辑</button><button class="button button-danger button-small" type="button" data-delete-work="${escapeHTML(work.id)}">删除</button></div></div>`).join('');
  const typeRows = typeOptions().map(type => `<div class="admin-type-row"><span>${escapeHTML(type)}</span><button class="button button-danger button-small" type="button" data-delete-type="${escapeHTML(type)}">删除</button></div>`).join('');
  const accounts = [...state.users].sort((a, b) => a.username.localeCompare(b.username, 'en'));
  const accountRows = accounts.map(account => `<div class="admin-user-row"><span class="admin-user-name">${escapeHTML(account.username)}${isAdmin(account) ? '<small>管理员</small>' : ''}</span><span>${state.works.filter(work => work.createdBy === account.username).length} 部作品</span></div>`).join('');
  return `<section class="page-intro"><div class="eyebrow">Admin / Archive desk</div><h1>管理员工作台</h1><p>统一整理罗瓣的作品、类型和封面。评分只统计罗瓣用户自己的打分。</p></section><section class="studio-panel queue-panel"><h2>作品审核</h2><div id="adminQueue" aria-live="polite">正在读取…</div></section>${activeAccount.role === 'superadmin' ? '<section class="studio-panel"><h2>管理员权限</h2><div id="editorRoles">正在读取账号…</div></section><section class="studio-panel"><details class="member-admin"><summary>老成员首次登录 · 11 人</summary><p>为成员生成认领码，私下交给本人。认领码七天内有效。</p><div id="memberInvites"></div></details></section>' : ''}<div class="admin-layout"><section class="admin-panel"><div class="admin-panel-heading"><div><h2>作品档案</h2><p>${works.length} 部作品 · 点击编辑可以补封面或重新分配类型</p></div><button class="button button-primary button-small" type="button" data-open-create>新建作品</button></div><div class="admin-work-list">${rows || '<div class="empty-state">还没有作品。</div>'}</div></section><aside class="admin-side"><section class="admin-panel"><h2>类型管理</h2><p class="admin-note">删除类型后，它会从现有作品中移除。</p><form class="type-form" id="typeForm"><input name="typeName" required maxlength="12" placeholder="新增一个类型" /><button class="button button-primary button-small" type="submit">添加</button></form><div class="admin-type-list">${typeRows}</div></section><section class="admin-panel"><h2>本机作品成员</h2><div class="admin-user-list">${accountRows || '<div class="empty-state">还没有注册账号。</div>'}</div></section><section class="admin-panel admin-safety"><h2>权限说明</h2><p>当前管理员：${escapeHTML(user.username)}</p><p>可编辑所有作品、管理类型、上传封面和删除作品。</p><p class="admin-note">这是静态网站，修改保存在当前浏览器；要让所有访客看到，需要将修改后的数据重新发布。</p></section></aside></div>`;
}

function renderDetail(id) {
  const work = getWork(id);
  if (!work) return `<div class="empty-state"><strong>找不到这部作品</strong><button class="button button-ghost" type="button" data-back-home>回到发现页</button></div>`;
  const user = currentUser();
  const favorite = user?.favoriteIds?.includes(work.id);
  const canEdit = user && (user.username === work.createdBy || isAdmin(user));
  const sortedComments = [...work.comments].sort((a, b) => b.likes - a.likes || b.text.length - a.text.length);
  const ratingButtons = Array.from({ length: 21 }, (_, i) => i / 2).map(score => `<button class="rating-option ${selectedRating === score ? 'is-selected' : ''}" type="button" data-rating="${score}">${score % 1 ? score.toFixed(1) : score}</button>`).join('');
  return `<a class="back-link" href="#home">← 返回发现</a><section class="detail-hero"><div class="detail-cover">${coverMarkup(work)}</div><div class="detail-copy"><div class="detail-heading"><h1>${escapeHTML(work.title)}</h1><div class="detail-meta"><span>${displayYear(work.year)}</span><span>${escapeHTML(work.region)}</span>${work.types.map(type => `<span>${escapeHTML(type)}</span>`).join('')}</div><div class="detail-score"><strong>${formatRating(work.rating, work.votes)}</strong><span>罗瓣评分<br />${work.votes} 人参与</span></div></div><div class="detail-playback" id="playbackLinks" data-work="${escapeHTML(work.id)}"></div><p class="detail-summary">${escapeHTML(work.summary || '这部作品还没有一句介绍，等你来补充。')}</p><div class="detail-actions"><button class="button ${favorite ? 'button-coral' : 'button-ghost'} button-small" type="button" data-favorite="${work.id}">${favorite ? '♥ 已收藏' : '♡ 收藏到我的罗瓣'}</button>${canEdit ? `<button class="button button-ghost button-small" type="button" data-edit-work="${work.id}">编辑作品</button>` : ''}${isAdmin(user) ? `<button class="button button-danger button-small" type="button" data-delete-work="${work.id}">删除作品</button>` : ''}</div></div></section><section hidden class="episode-room" id="episodeRoom" aria-label="分集播放器"></section><section class="detail-columns"><div><section class="detail-section"><h2>留下你的分数</h2><div class="rating-box"><p>从 0 到 10，每次半分都算数。${user ? '' : '登录后即可评分。'}</p><div class="rating-options">${ratingButtons}</div><div style="margin-top:13px"><button class="button button-primary button-small" type="button" data-submit-rating="${work.id}">提交评分</button></div></div></section><section class="detail-section"><h2>评论 <span class="result-count">${work.comments.length}</span></h2>${user ? `<form class="comment-form" id="commentForm" data-work-id="${work.id}"><textarea name="text" required placeholder="说说你为什么记住它……"></textarea><div style="display:flex;justify-content:flex-end"><button class="button button-primary button-small" type="submit">发布评论</button></div></form>` : loginRequired('想留下一句话吗？', '登录后可以评分、评论，也能给别人的评论点个赞。')}<div class="detail-comment-list">${sortedComments.length ? sortedComments.map(comment => `<article class="detail-comment"><div class="detail-comment-top"><button class="comment-author" type="button" data-open-profile="${escapeHTML(comment.user)}">${escapeHTML(comment.user)}</button><span class="comment-date">${escapeHTML(comment.date)}</span></div><p>${escapeHTML(comment.text)}</p><button class="like-button ${user && comment.likedBy?.includes(user.username) ? 'is-liked' : ''}" type="button" data-like-comment="${work.id}" data-comment-id="${comment.id}">♥ ${comment.likes}</button>${isAdmin(user) ? `<button class="button button-danger button-small comment-delete" type="button" data-delete-comment="${work.id}" data-comment-id="${comment.id}">删除评论</button>` : ''}</article>`).join('') : '<div class="empty-state">还没有评论，来做第一个说话的人。</div>'}</div></section></div><aside><section class="detail-section"><h2>作品信息</h2><div class="info-list"><div class="info-row"><span>类型</span><span>${work.types.map(escapeHTML).join(' / ')}</span></div><div class="info-row"><span>地区</span><span>${escapeHTML(work.region)}</span></div><div class="info-row"><span>年份</span><span>${displayYear(work.year)}</span></div><div class="info-row"><span>创建者</span><span><button class="text-link" type="button" data-open-profile="${escapeHTML(work.createdBy)}">${escapeHTML(work.createdBy)}</button></span></div>${work.sourceUrl ? `<div class="info-row"><span>资料来源</span><a class="text-link" href="${escapeHTML(work.sourceUrl)}" target="_blank" rel="noopener">Bangumi</a></div>` : ''}${work.sourceLabel ? `<div class="info-row"><span>资料来源</span><span>${escapeHTML(work.sourceLabel)}</span></div>` : ''}<div class="info-row"><span>自动标签</span><span>${autoTags(work).join(' / ')}</span></div></div></section><section class="detail-section"><h2>也许你会喜欢</h2><div class="comment-list">${state.works.filter(item => item.id !== work.id && item.types.some(type => work.types.includes(type))).slice(0, 3).map(item => `<button class="button button-ghost" style="justify-content:space-between" type="button" data-open-work="${item.id}"><span>${escapeHTML(item.title)}</span><span class="rating">${formatRating(item.rating, item.votes)}</span></button>`).join('')}</div></section></aside></section>`;
}

function autoTags(work) {
  const tags = [workRank(work) === 'hot' ? '热门' : workRank(work) === 'cold' ? '冷门' : '', work.rating > 8 ? '高分' : '', work.rating < 4 ? '赤石' : ''].filter(Boolean);
  return tags.length ? tags : ['待观察'];
}

function renderApp() {
  stopEpisodePlayer();
  closeStudioDialogs();
  renderHeader();
  const route = currentRoute();
  const app = document.getElementById('app');
  selectedRating = null;
  if (route === 'home') {
    const controls = [...app.querySelectorAll('.filter-panel button, .filter-panel select, .filter-panel input')];
    const focusIndex = controls.indexOf(document.activeElement);
    app.innerHTML = renderHome();
    if (focusIndex >= 0) app.querySelectorAll('.filter-panel button, .filter-panel select, .filter-panel input')[focusIndex]?.focus({ preventScroll: true });
  }
  else if (route === 'profile') app.innerHTML = currentUser() ? renderProfile() : loginRequired('登录后查看你的罗瓣', '收藏三部最爱作品，再留下三条最想被看见的评论。');
  else if (route.startsWith('profile-')) app.innerHTML = renderProfile(decodeURIComponent(route.slice(8)));
  else if (route === 'create') app.innerHTML = renderEditor();
  else if (route.startsWith('edit-entry-')) app.innerHTML = '<div id="submissionEditor" class="empty-state" role="status">正在读取作品…</div>';
  else if (route.startsWith('edit-')) app.innerHTML = renderEditor(route.slice(5));
  else if (route.startsWith('review-') || route.startsWith('submission-')) app.innerHTML = '<div class="empty-state" id="submissionEditor" role="status">正在读取稿件…</div>';
  else if (route === 'admin') app.innerHTML = renderAdmin();
  else if (route.startsWith('work-')) app.innerHTML = renderDetail(route.slice(5));
  else { location.hash = '#home'; return; }
  loadStudioSections(route);
  if (route === 'home' && scrollToCatalog) { scrollToCatalog = false; requestAnimationFrame(() => document.getElementById('catalog')?.scrollIntoView()); }
}

function navigate(route) {
  if (location.hash === `#${route}`) renderApp();
  else location.hash = `#${route}`;
}

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message; toast.classList.add('is-visible');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2600);
}

function updateFilter(kind, value) {
  const list = state.filters[`${kind}s`];
  const index = list.indexOf(value);
  if (index >= 0) list.splice(index, 1); else list.push(value);
  saveState(); renderApp();
}

function updateRank(value) {
  state.filters.rank = state.filters.rank === value ? '' : value;
  saveState(); renderApp();
}

async function deleteWorkById(id) {
  if (!isAdmin()) { openAuth('admin'); return; }
  const work = getWork(id);
  if (!work || !window.confirm(`确定删除《${work.title}》吗？${work.shared ? '删除后所有人将无法查看。' : '删除后本设备的作品记录将被移除。'}`)) return;
  if (work.shared) {
    try { await accountRequest('reviews', { id, version: work.version, action: 'delete' }); }
    catch (error) { showToast(error.message); return; }
  }
  state.works = state.works.filter(item => item.id !== id);
  state.deletedWorkIds = [...new Set([...(state.deletedWorkIds || []), id])];
  state.users.forEach(user => {
    user.favoriteIds = (user.favoriteIds || []).filter(workId => workId !== id);
    user.featuredCommentIds = (user.featuredCommentIds || []).filter(key => !key.startsWith(`${id}:`));
  });
  saveState(); refreshFeatured(); navigate('admin'); showToast('作品已删除');
}

function deleteTypeByName(type) {
  if (!isAdmin()) { openAuth('admin'); return; }
  if (typeOptions().length <= 1) { showToast('至少保留一个作品类型'); return; }
  if (!window.confirm(`删除“${type}”类型？它会从现有作品中移除。`)) return;
  state.types = typeOptions().filter(item => item !== type);
  state.filters.types = state.filters.types.filter(item => item !== type);
  state.works.forEach(work => {
    work.types = (work.types || []).filter(item => item !== type);
    if (!work.types.length && state.types.length) work.types = [state.types[0]];
  });
  saveState(); renderApp(); showToast(`类型“${type}”已删除`);
}

function deleteComment(workId, commentId) {
  if (!isAdmin()) { openAuth('admin'); return; }
  const work = getWork(workId);
  if (!work) return;
  const comment = work.comments.find(item => item.id === commentId);
  if (!comment) return;
  if (!window.confirm('删除这条评论？')) return;
  work.comments = work.comments.filter(item => item.id !== commentId);
  saveState(); renderApp(); showToast('评论已删除');
}

document.addEventListener('toggle', event => {
  if (event.target.matches('.filter-details') && event.target.isConnected) filtersExpanded = event.target.open;
}, true);

let touchOrigin = null;
document.addEventListener('touchstart', event => {
  const touch = event.touches[0];
  touchOrigin = event.touches.length === 1 && event.target.closest('.spotlight') ? [touch.clientX, touch.clientY] : null;
}, { passive: true });
document.addEventListener('touchend', event => {
  if (!touchOrigin) return;
  const touch = event.changedTouches[0];
  const dx = touch.clientX - touchOrigin[0], dy = touch.clientY - touchOrigin[1];
  touchOrigin = null;
  if (Math.abs(dx) > 50 && Math.abs(dx) > 2 * Math.abs(dy)) shiftPick(dx < 0 ? 1 : -1);
}, { passive: true });
document.addEventListener('touchcancel', () => { touchOrigin = null; });

document.addEventListener('click', async event => {
  const target = event.target;
  if (target.closest('.skip-link')) {
    event.preventDefault();
    document.getElementById('app').focus();
    return;
  }
  if (currentRoute() === 'home' && target.closest('a[href^="#work-"]')) {
    lastHomePosition = { top: window.scrollY, work: target.closest('a').getAttribute('href') };
  }
  const shift = target.closest('[data-shift]');
  if (shift) { shiftPick(Number(shift.dataset.shift)); return; }
  if (target.closest('[data-more]')) {
    const items = filteredWorks().slice(shownCount, shownCount + 18);
    shownCount += items.length;
    document.querySelector('.works-grid').insertAdjacentHTML('beforeend', items.map(w => workCard(w)).join(''));
    if (shownCount >= filteredWorks().length) target.closest('button').remove();
    if (items.length) document.querySelectorAll('.works-grid > a')[shownCount - items.length]?.focus({ preventScroll: true });
    return;
  }
  if (target.closest('[data-refresh-picks]')) { refreshFeatured(); renderApp(); document.querySelector('[data-refresh-picks]').focus({ preventScroll: true }); return; }
  const openWork = target.closest('[data-open-work]');
  if (openWork) { navigate(`work-${openWork.dataset.openWork}`); return; }
  const openProfile = target.closest('[data-open-profile], [data-nav-profile]');
  if (openProfile) { navigate(`profile-${encodeURIComponent(openProfile.dataset.openProfile || openProfile.dataset.navProfile)}`); return; }
  if (target.closest('[data-login]')) { openAuth('login'); return; }
  if (target.closest('[data-admin-entry], [data-admin-login]')) { openAuth('admin'); return; }
  if (target.closest('[data-open-create]')) { navigate('create'); return; }
  if (target.closest('[data-back-home]')) { navigate('home'); return; }

  const deleteWork = target.closest('[data-delete-work]'); if (deleteWork) { deleteWorkById(deleteWork.dataset.deleteWork); return; }
  const deleteType = target.closest('[data-delete-type]'); if (deleteType) { deleteTypeByName(deleteType.dataset.deleteType); return; }
  const deleteCommentButton = target.closest('[data-delete-comment]'); if (deleteCommentButton) { deleteComment(deleteCommentButton.dataset.deleteComment, deleteCommentButton.dataset.commentId); return; }
  if (target.closest('.filter-panel')) shownCount = 18;
  const filterType = target.closest('[data-filter-type]'); if (filterType) { updateFilter('type', filterType.dataset.filterType); return; }
  const filterRank = target.closest('[data-filter-rank]'); if (filterRank) { updateRank(filterRank.dataset.filterRank); return; }
  const filterRegion = target.closest('[data-filter-region]'); if (filterRegion) { updateFilter('region', filterRegion.dataset.filterRegion); return; }
  const filterYear = target.closest('[data-filter-year]'); if (filterYear) { updateFilter('year', filterYear.dataset.filterYear); return; }
  const sort = target.closest('[data-sort]'); if (sort) { state.sort = sort.dataset.sort; saveState(); renderApp(); return; }
  if (target.closest('[data-clear-filters]')) { state.query = ''; state.filters = { types: [], regions: [], years: [], rank: '', scoreMin: 0, scoreMax: 10 }; saveState(); renderApp(); return; }
  const rate = target.closest('[data-rating]'); if (rate) { selectedRating = Number(rate.dataset.rating); document.querySelectorAll('[data-rating]').forEach(button => button.classList.toggle('is-selected', Number(button.dataset.rating) === selectedRating)); return; }
  const submitRating = target.closest('[data-submit-rating]');
  if (submitRating) {
    if (!currentUser()) { openAuth('login'); return; }
    if (selectedRating === null) { showToast('先选择一个分数吧'); return; }
    const work = getWork(submitRating.dataset.submitRating); const user = currentUser();
    work.userRatings = work.userRatings || {};
    const old = work.userRatings[user.username];
    if (old === undefined) { work.ratingSum += selectedRating; work.votes += 1; } else { work.ratingSum += selectedRating - old; }
    work.userRatings[user.username] = selectedRating; work.rating = work.votes ? work.ratingSum / work.votes : 0;
    saveState(); renderApp(); showToast(old === undefined ? '评分已记录，谢谢你的半分' : '评分已更新'); return;
  }
  const favorite = target.closest('[data-favorite]');
  if (favorite) {
    if (!currentUser()) { openAuth('login'); return; }
    const user = currentUser(); user.favoriteIds = user.favoriteIds || [];
    const index = user.favoriteIds.indexOf(favorite.dataset.favorite);
    if (index >= 0) { user.favoriteIds.splice(index, 1); showToast('已从最爱作品移除'); } else { if (user.favoriteIds.length >= 3) { showToast('三部最爱已选满，可以在「我的罗瓣」更换'); return; } user.favoriteIds.push(favorite.dataset.favorite); showToast('已放进你的三部最爱'); }
    saveState(); renderApp(); return;
  }
  const like = target.closest('[data-like-comment]');
  if (like) {
    if (!currentUser()) { openAuth('login'); return; }
    const work = getWork(like.dataset.likeComment); const comment = work.comments.find(item => item.id === like.dataset.commentId); const user = currentUser();
    comment.likedBy = comment.likedBy || [];
    const index = comment.likedBy.indexOf(user.username);
    if (index >= 0) { comment.likedBy.splice(index, 1); comment.likes = Math.max(0, comment.likes - 1); } else { comment.likedBy.push(user.username); comment.likes += 1; }
    saveState(); renderApp(); return;
  }
  const edit = target.closest('[data-edit-work]'); if (edit) { navigate(`edit-${edit.dataset.editWork}`); return; }
  if (target.closest('[data-logout]')) {
    try { await accountRequest('logout', {}); applyAccount(null); navigate('home'); showToast('已退出登录'); }
    catch (error) { showToast(error.message); }
    return;
  }
  if (target.closest('[data-scroll]')) { document.getElementById(target.closest('[data-scroll]').dataset.scroll)?.scrollIntoView({ behavior: 'smooth' }); return; }
});

document.addEventListener('submit', async event => {
  if (event.target.id === 'headerSearch') { event.preventDefault(); shownCount = 18; scrollToCatalog = true; state.query = new FormData(event.target).get('q')?.toString() || ''; saveState(); navigate('home'); return; }
  if (event.target.id === 'typeForm') {
    event.preventDefault();
    if (!isAdmin()) { openAuth('admin'); return; }
    const name = new FormData(event.target).get('typeName').toString().trim();
    if (!name) return;
    if (typeOptions().includes(name)) { showToast('这个类型已经存在'); return; }
    state.types.push(name); saveState(); renderApp(); showToast(`类型“${name}”已添加`); return;
  }
  if (event.target.id === 'commentForm') {
    event.preventDefault(); if (!currentUser()) { openAuth('login'); return; }
    const form = new FormData(event.target); const work = getWork(event.target.dataset.workId); work.comments.push({ id: `c-${Date.now()}`, user: currentUser().username, text: form.get('text').toString().trim(), likes: 0, date: new Date().toISOString().slice(0, 10) }); const user = currentUser(); user.commentCount = (user.commentCount || 0) + 1; saveState(); renderApp(); showToast('评论已经留下'); return;
  }

});

document.addEventListener('change', event => {
  if (event.target.id === 'exactYear') { const value = event.target.value; if (value && !state.filters.years.includes(value)) state.filters.years.push(value); else if (!value) state.filters.years = state.filters.years.filter(year => !/^\d{4}$/.test(year)); saveState(); renderApp(); }
  if (event.target.id === 'scoreMin' || event.target.id === 'scoreMax') {
    const min = event.target.id === 'scoreMin' ? Number(event.target.value) : Number(state.filters.scoreMin ?? 0);
    const max = event.target.id === 'scoreMax' ? Number(event.target.value) : Number(state.filters.scoreMax ?? 10);
    state.filters.scoreMin = Math.min(min, max);
    state.filters.scoreMax = Math.max(min, max);
    saveState(); renderApp();
  }
});

window.addEventListener('hashchange', event => {
  const searching = scrollToCatalog;
  renderApp();
  if (searching) return;
  const restore = currentRoute() === 'home' && new URL(event.oldURL).hash.startsWith('#work-') && lastHomePosition;
  const focus = restore && [...document.querySelectorAll('#app a')].find(a => a.getAttribute('href') === restore.work);
  window.scrollTo({ top: restore ? restore.top : 0, behavior: 'instant' });
  (focus || document.getElementById('app')).focus({ preventScroll: true });
  if (currentRoute() === 'home') lastHomePosition = null;
});
window.addEventListener('keydown', event => {
  if (!document.querySelector('dialog[open]') && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); document.getElementById('globalSearch').focus(); }

});

refreshFeatured();
renderApp();
refreshSession();
refreshPublished();
