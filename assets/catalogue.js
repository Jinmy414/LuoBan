// Start fetching the first editorial cover while the rest of the catalogue loads.
if (['', '#home'].includes(location.hash)) {
  const cover = document.createElement('link');
  cover.rel = 'preload';
  cover.as = 'image';
  cover.href = 'assets/covers/cover-6.jpg';
  cover.fetchPriority = 'high';
  document.head.append(cover);
}

let avatarRevision = 0;
let publishedRevision = 0;
let lastPublishedAt = 0;
let lastDiscussion = null;
let playbackOverrides = {};

const routeScripts = new Map();
let pendingRoute = null;

function studioRoute(route) {
  return ['create', 'admin', 'profile'].includes(route) || /^(edit|review|submission)-/.test(route);
}

function loadRouteScript(name) {
  if (routeScripts.has(name)) return routeScripts.get(name);
  const script = document.createElement('script');
  const ready = new Promise((resolve, reject) => {
    script.onload = resolve;
    script.onerror = () => {
      routeScripts.delete(name);
      script.remove();
      reject(Error('页面暂时未能加载'));
    };
  });
  routeScripts.set(name, ready);
  script.src = 'assets/' + name + '.js?v=20261129';
  document.head.append(script);
  return ready;
}

function prepareRoute(route, app) {
  let script;
  if (route.startsWith('work-') && typeof loadEpisodeAccess !== 'function') script = 'episodes';
  if (studioRoute(route) && typeof loadStudioSections !== 'function') script = 'studio';
  if (route === 'anime-chat' && typeof animeChat === 'undefined') {
    script = 'anime-chat';
    if (!document.getElementById('chatStyles')) {
      const link = document.createElement('link');
      link.id = 'chatStyles';
      link.rel = 'stylesheet';
      link.href = 'assets/anime-chat.css?v=1';
      document.head.append(link);
    }
  }
  if (!script) { pendingRoute = null; return true; }
  if (pendingRoute === route) return false;
  pendingRoute = route;
  app.innerHTML = '<p class="empty-state" role="status">正在加载…</p>';
  loadRouteScript(script).then(() => {
    if (currentRoute() === route && pendingRoute === route) renderApp();
  }).catch(() => {
    if (currentRoute() !== route || pendingRoute !== route) return;
    pendingRoute = null;
    app.innerHTML = '<div class="empty-state" role="status">页面加载失败 <button type="button" class="studio-action">重试</button></div>';
    app.querySelector('button').onclick = renderApp;
  });
  return false;
}

function avatarURL(name) {
  return 'api/avatars/' + encodeURIComponent(name) + '?v=' + avatarRevision;
}
function closeStudioDialogs() {
  document.querySelectorAll('.studio-dialog[open]').forEach(dialog => dialog.close());
}
function profileComments(user) {
  const username = user.username;
  const local = state.works.flatMap(work => work.comments.filter(c => c.authorId ? c.authorId === user.accountId : c.user === username)
    .map(comment => ({...comment, work, key: work.id + ':' + comment.id})))
    .sort((a, b) => b.date.localeCompare(a.date));
  const remote = (user.featuredComments || []).map(c => ({
    ...c, work:getWork(c.workId), key:c.workId + ':' + c.id, likes:0
  })).filter(c => c.work && !local.some(item => item.key === c.key));
  return [...local, ...remote];
}
function thumb(work) {
  const url = safeImage(work.coverImage);
  return url ? `<img class="studio-thumb" src="${escapeHTML(url)}" alt="" loading="lazy">`
    : `<span class="studio-thumb initial" aria-hidden="true">${escapeHTML(work.title.slice(0, 1))}</span>`;
}
function openSheet(title, content, opener) {
  const dialog = document.createElement('dialog');
  dialog.className = 'studio-dialog';
  const label = 'sheet-' + document.querySelectorAll('.studio-dialog').length;
  dialog.setAttribute('aria-labelledby', label);
  dialog.innerHTML = `<div class="sheet-head"><h2 id="${label}">${title}</h2><button class="sheet-close" type="button" aria-label="关闭" data-close>×</button></div>${content}`;
  document.body.append(dialog);
  dialog.addEventListener('click', event => {
    if (event.target.closest('[data-close]')) dialog.close();
  });
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (opener?.isConnected) opener.focus({preventScroll:true});
  }, {once:true});
  dialog.showModal();
  return dialog;
}
async function refreshPublished(redraw = true) {
  const revision = ++publishedRevision;
  const viewer = activeAccount?.id;
  const likesAtStart = commentLikeRevision;
  try {
    const {works, playback = {},memberNames = {}, discussion = {}, viewerId = null} = await accountRequest('works');
    if (revision !== publishedRevision || viewer !== activeAccount?.id) return;
    if (likesAtStart !== commentLikeRevision) return refreshPublished(redraw);
    lastPublishedAt = Date.now();
    const changedSources = JSON.stringify(playbackOverrides) !== JSON.stringify(playback);
    playbackOverrides = playback;
    let renamed = false;
    for (const work of state.works) {
      for (const comment of work.comments) {
        if (Object.hasOwn(memberNames,comment.user)) { comment.user = memberNames[comment.user]; renamed = true; }
      }
      for (const [oldName,newName] of Object.entries(memberNames)) {
        if (Object.hasOwn(work.userRatings || {},oldName)) {
          work.userRatings[newName] ??= work.userRatings[oldName];
          delete work.userRatings[oldName]; renamed = true;
        }
      }
    }
    const prior = state.works.filter(w => w.shared);
    const discussionKey = JSON.stringify([viewerId, discussion]);
    const changedDiscussion = discussionKey !== lastDiscussion;
    if (!changedDiscussion && !changedSources && !renamed && works.length === prior.length && works.every(w => { const old = getWork(w.id); return old?.version === w.version && old.createdBy === w.createdBy && old.authorId === w.authorId; })) return;
    const merged = works.map(w => {
      const old = getWork(w.id);
      return {...{rating:null,votes:0,ratingSum:0,comments:[],userRatings:{}}, ...old, ...w, shared:true,poster:POSTER_OPTIONS[w.poster] || POSTER_OPTIONS.mint};
    });
    state.works = [...merged, ...state.works.filter(w => !w.shared)];
    mergeDiscussion(discussion, viewerId);
    lastDiscussion = discussionKey;
    document.dispatchEvent(new Event('published-works-updated'));
    refreshFeatured(true);
    try { saveState(); } catch { /* Published works remain available in memory. */ }
    if (redraw && currentRoute().startsWith('work-')) refreshDetailContent();
    else if (redraw && currentRoute() === 'home') refreshHomeResults();
    else if (redraw && !document.querySelector('dialog[open],#workForm,#requestForm') &&
      /^(admin|members|member-.+|profile-.+)$/.test(currentRoute())) renderApp();
  } catch { /* Static hosts and offline readers can still browse the local catalogue. */ }
}
window.addEventListener('hashchange', () => {
  const route = currentRoute();
  const missing = route.startsWith('work-') && !seasonPlaybackWork(route.slice(5));
  if ((missing || Date.now() - lastPublishedAt > 15000) && /^(home|admin|profile|member-|work-)/.test(route)) refreshPublished();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    refreshPublished();
    if (typeof loadStudioSections === 'function' && document.querySelector('#adminQueue,#mySubmissions')) loadStudioSections(currentRoute());
  }
});
let progressWrites = Promise.resolve();
let requestedResume = null;
document.addEventListener('click', (event) => {
  const link = event.target.closest('[data-resume-work]');
  if (link && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey)
    requestedResume = link.dataset.resumeWork;
});
window.addEventListener('hashchange', () => {
  const route = currentRoute();
  if (requestedResume && (!route.startsWith('work-') || seasonPlaybackWork(route.slice(5))?.id !== requestedResume)) requestedResume = null;
});

function episodeTime(seconds) {
  const value = Math.max(0, Math.floor(seconds || 0));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor(value / 60) % 60;
  return (
    (hours ? hours + ':' + String(minutes).padStart(2, '0') : String(minutes)) +
    ':' +
    String(value % 60).padStart(2, '0')
  );
}
