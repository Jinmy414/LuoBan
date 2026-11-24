function workCommentScore(work, name, saved) {
  const value = work.commentScores?.[name] ?? saved ?? work.userRatings?.[name];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10 ? value : null;
}
function commentScoreBadge(work, name, saved) {
  const value = workCommentScore(work, name, saved);
  return value === null ? '' : `<span class="comment-score" aria-label="对本作的评分：${value} 分">${value} 分</span>`;
}
function detailCommentMarkup(work, c, user) {
  const id = escapeHTML(c.id), workId = escapeHTML(work.id);
  const parent = c.replyTo;
  const quote = parent ? `<blockquote class="reply-quote">回复 ${memberLink(parent.user,parent.authorId)}<p>${escapeHTML(parent.text)}</p></blockquote>` : '';
  const canReply = c.sharedComment || c.id.startsWith('import-comment-');
  return `<article class="detail-comment" data-discussion-id="${id}"><div class="detail-comment-top"><div class="comment-byline">${memberLink(c.user,c.authorId)}${commentScoreBadge(work,c.user)}</div><span class="comment-date">${escapeHTML(c.date)}</span></div>
    ${quote}<p>${escapeHTML(c.text)}</p><div class="comment-actions"><button class="like-button ${user && c.likedBy?.includes(user.username) ? 'is-liked' : ''}" type="button" data-like-comment="${workId}" data-comment-id="${id}">♥ ${c.likes || 0}</button>
    ${canReply ? `<button class="reply-action" type="button" data-reply-comment="${id}">回复</button>` : ''}
    ${isAdmin(user) ? `<button class="button button-danger button-small comment-delete" type="button" data-delete-comment="${workId}" data-comment-id="${id}">删除评论</button>` : ''}</div></article>`;
}

function mergeDiscussion(activity) {
  for (const work of state.works) {
    const data = activity[work.id];
    const old = new Map(work.comments.filter(c => c.sharedComment).map(c => [c.id,c]));
    if (old.size || data?.comments.length) {
      work.comments = work.comments.filter(c => !c.sharedComment).concat((data?.comments || []).map(c => ({
        ...c, likes:old.get(c.id)?.likes || 0, likedBy:old.get(c.id)?.likedBy || []
      })));
    }
    work.commentScores = data?.commentScores || {};
    if (data?.votes !== undefined) {
      work.votes = data.votes;
      work.ratingSum = data.ratingSum;
      work.rating = data.votes ? data.ratingSum / data.votes : null;
    }
  }
}

document.addEventListener('click', event => {
  const reply = event.target.closest('[data-reply-comment]'), cancel = event.target.closest('[data-cancel-reply]');
  if (!reply && !cancel) return;
  if (!currentUser()) { openAuth('login'); return; }
  const form = document.getElementById('commentForm');
  if (!form) return;
  const context = form.querySelector('[data-reply-context]');
  const c = reply && getWork(form.dataset.workId)?.comments.find(c => c.id === reply.dataset.replyComment);
  context.hidden = !c;
  context.querySelector('span').textContent = c ? '回复 ' + c.user : '';
  form.dataset.replyTo = c?.id || '';
  form.querySelector('textarea').focus();
});

let noticeVersion = 0;
async function loadCommentNotices() {
  const target = document.getElementById('noticeStack'), user = currentUser();
  const version = ++noticeVersion;
  if (!target || !user || document.hidden) return;
  try {
    const data = await accountRequest('comment-notices');
    if (version !== noticeVersion || !target.isConnected || currentUser() !== user) return;
    const [item] = data.items;
    if (!item) { target.hidden = true; target.replaceChildren(); delete target.dataset.key; return; }
    const key = item.id + ':' + data.items.length;
    if (target.dataset.key === key) return;
    target.dataset.key = key;
    const heading = item.kind === 'reply' ? ' 回复了你的评论' : ' 评论了你的作品';
    target.hidden = false;
    target.dataset.depth = String(Math.min(3, data.items.length));
    target.innerHTML = `<button class="notice-card" type="button"><span class="notice-top"><strong>评论提醒</strong><small>${data.items.length} 条未读</small></span>
      <b>${escapeHTML(item.author + heading)}</b><span class="notice-excerpt">${escapeHTML(item.text)}</span><small>《${escapeHTML(item.title)}》 · 点开阅览 ›</small></button>`;
    target.querySelector('button').onclick = () => {
      const sheet = openSheet('评论提醒', `<div class="notice-reader"><p>${memberLink(item.author,item.authorId)}${escapeHTML(heading)}</p>
        <blockquote>${escapeHTML(item.text)}</blockquote><a class="studio-action" href="#work-${escapeHTML(item.workId)}">查看《${escapeHTML(item.title)}》的讨论 ›</a><p role="status"></p></div>`, target.querySelector('button'));
      const markRead = async () => {
        try {
          await accountRequest('comment-notices',{accountId:user.accountId,commentId:item.id});
          if (currentUser() === user) loadCommentNotices();
          sheet.querySelector('[role=status]').textContent = '';
        } catch {
          const status = sheet.querySelector('[role=status]');
          status.innerHTML = '已读状态保存失败。 <button class="studio-action" type="button">重试</button>';
          status.querySelector('button').onclick = markRead;
        }
      };
      markRead();
      sheet.addEventListener('close', () => {
        if (target.isConnected && !target.contains(document.activeElement)) {
          (target.querySelector('button') || document.getElementById('app'))?.focus({preventScroll:true});
        }
      }, {once:true});
      sheet.querySelector('a[href^="#work-"]').onclick = () => { pendingDiscussion = {workId:item.workId,id:item.id}; };
    };
  } catch { /* A later visit or poll retries without clearing the unread state. */ }
}
let pendingDiscussion = null;
function focusNoticeComment() {
  if (!pendingDiscussion || currentRoute() !== 'work-' + pendingDiscussion.workId) return;
  const el = [...document.querySelectorAll('[data-discussion-id]')].find(n => n.dataset.discussionId === pendingDiscussion.id);
  if (el) {
    pendingDiscussion = null;
    el.tabIndex = -1;
    el.focus({preventScroll:true});
    el.scrollIntoView({block:'center',behavior:'instant'});
  }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadCommentNotices(); });
setInterval(() => { if (currentRoute() === 'home' && !document.hidden) loadCommentNotices(); }, 30000);
