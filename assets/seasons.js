// A season has its own playback history, while the original work owns its reviews and rating.
const animeSeries = new Map();
const animeSeasonById = new Map();
for (const group of window.LUOBAN_ANIME_SEASONS || []) {
  const first = {id:group.combined ? group.rootId + '-s1' : group.rootId, rootId:group.rootId, n:1,
    label:group.firstLabel || '第一季', year:group.year, sourceUrl:group.sourceUrl};
  const seasons = [first, ...group.seasons.map(season => ({
    ...season, id:group.rootId + '-s' + season.n, rootId:group.rootId
  }))];
  if (group.combined) seasons.push({id:group.rootId + '-all', playbackId:group.rootId, rootId:group.rootId, label:'原有连播'});
  animeSeries.set(group.rootId, seasons);
  animeSeasonById.set(group.rootId, first);
  for (const season of seasons) animeSeasonById.set(season.id, season);
}

let playbackSummaries = null;
let platformWorkIds = new Set();
let summaryRequest = null;
let summaryFetched = 0;

function hasPlaybackSummaries() {
  return playbackSummaries !== null;
}

function loadPlaybackSummaries(force = false) {
  if (!force && summaryRequest) return summaryRequest;
  if (!force && Date.now() - summaryFetched < 300000) return Promise.resolve(false);
  const pending = accountRequest('playback-summary').then(data => {
    if (summaryRequest !== pending) return false;
    const changed = !playbackSummaries || JSON.stringify(data.works) !== JSON.stringify(playbackSummaries)
      || data.platforms.length !== platformWorkIds.size || data.platforms.some(id => !platformWorkIds.has(id));
    playbackSummaries = data.works;
    platformWorkIds = new Set(data.platforms);
    summaryFetched = Date.now();
    if (changed || force) {
      for (const choice of document.querySelectorAll('[data-season-id], [data-season-select] option')) {
        const season = animeSeasonById.get(choice.dataset.seasonId || choice.value);
        if (season) choice.textContent = seasonChoiceLabel(season);
      }
      const caption = document.querySelector('[data-season-caption]');
      if (caption) {
        const current = animeSeasonById.get(document.getElementById('playbackLinks')?.dataset.work);
        if (current) caption.innerHTML = seasonCaption(current, getWork(current.rootId));
      }
      document.dispatchEvent(new Event('playback-summaries-updated'));
    }
    return changed;
  }).catch(() => false).finally(() => { if (summaryRequest === pending) summaryRequest = null; });
  summaryRequest = pending;
  return pending;
}

function seasonPlaybackSummary(id, season) {
  if (!hasPlaybackSummaries()) return {playable:false, text:''};
  const item = playbackSummaries[id];
  if (!item) return {playable:false, text:platformWorkIds.has(id) ? '前往平台' : '暂无线路'};
  const counts = [];
  if (item.episodes) counts.push(item.episodes + ' 集');
  if (item.issues) counts.push(item.issues + ' 期');
  if (item.collections) counts.push(item.collections + ' 个合集');
  if (item.other) counts.push(item.other + ' 个节目');
  const complete = item.sequential && item.episodes === season?.episodeCount && counts.length === 1;
  return {playable:true, text:(complete ? '全 ' : '已接入 ') + counts.join(' · ')};
}

function workPlaybackSummary(id) {
  const seasons = animeSeries.get(id);
  if (!seasons || !hasPlaybackSummaries()) return seasonPlaybackSummary(id, animeSeasonById.get(id));
  const available = seasons.filter(s => !s.playbackId && playbackSummaries[s.id]);
  if (available.length) return {playable:true, text:available.length + ' 季有站内分集'};
  if (seasons.some(s => s.playbackId && playbackSummaries[s.playbackId])) return {playable:true, text:'有站内连播'};
  const external = seasons.some(s => platformWorkIds.has(s.playbackId || s.id));
  return {playable:false, text:external ? '前往平台' : '暂无线路'};
}

function firstPlayableSeason(id) {
  if (!hasPlaybackSummaries()) return id;
  const season = animeSeries.get(id)?.find(s => playbackSummaries[s.playbackId || s.id]);
  return season?.id || id;
}

function seasonChoiceLabel(season) {
  const status = seasonPlaybackSummary(season.playbackId || season.id, season).text;
  return status ? season.label + ' · ' + status : season.label;
}

function seasonPlaybackWork(id) {
  const season = animeSeasonById.get(id);
  if (!season) return getWork(id);
  const work = getWork(season.rootId);
  if (!work) return null;
  return {...work, id:season.playbackId || season.id, title:season.title || work.title + ' ' + season.label, year:season.year || work.year};
}

function seasonCaption(season, work) {
  const info = season.playbackId ? ['按原有集号连续播放'] : [season.title || work.title, season.year || work.year].filter(Boolean);
  if (playbackSummaries?.[season.playbackId || season.id]?.youtubeOnly) info.push('此季需连接 YouTube');
  const source = season.sourceUrl ? ` <a class="text-link" href="${escapeHTML(season.sourceUrl)}" target="_blank" rel="noopener">季度资料 ↗</a>` : '';
  return escapeHTML(info.join(' · ')) + source;
}

function renderSeasonPicker(work, activeId) {
  const seasons = animeSeries.get(work.id);
  if (!seasons) return '';
  const selected = animeSeasonById.get(activeId) || seasons[0];
  const choices = seasons.length > 7
    ? `<select class="select-compact" aria-label="选择季度" data-season-select>${seasons.map(s =>
      `<option value="${escapeHTML(s.id)}" ${s.id === selected.id ? 'selected' : ''}>${escapeHTML(seasonChoiceLabel(s))}</option>`).join('')}</select>`
    : `<div class="season-options">${seasons.map(s =>
      `<button type="button" class="filter-chip" data-season-id="${escapeHTML(s.id)}" aria-pressed="${s.id === selected.id}">${escapeHTML(seasonChoiceLabel(s))}</button>`).join('')}</div>`;
  return `<section class="season-picker" aria-label="选择季度"><h2>选季</h2>${choices}
    <p data-season-caption aria-live="polite">${seasonCaption(selected, work)}</p></section>`;
}

function selectAnimeSeason(id) {
  const season = animeSeasonById.get(id);
  const target = document.getElementById('playbackLinks');
  const current = animeSeasonById.get(target?.dataset.work);
  if (!season || current?.rootId !== season.rootId || current.id === id) return;
  const work = seasonPlaybackWork(id);
  if (!work) return;
  stopEpisodePlayer();
  history.replaceState(history.state, '', '#work-' + id);
  const picker = document.querySelector('.season-picker');
  for (const button of picker.querySelectorAll('[data-season-id]'))
    button.setAttribute('aria-pressed', String(button.dataset.seasonId === id));
  picker.querySelector('[data-season-caption]').innerHTML = seasonCaption(season, getWork(season.rootId));
  target.dataset.work = id;
  target.replaceChildren();
  loadEpisodeAccess(work, target);
}

document.addEventListener('click', event => {
  const choice = event.target.closest('[data-season-id]');
  if (choice) selectAnimeSeason(choice.dataset.seasonId);
});
document.addEventListener('change', event => {
  if (event.target.matches('[data-season-select]')) selectAnimeSeason(event.target.value);
});
