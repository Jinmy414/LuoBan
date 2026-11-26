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

function seasonPlaybackWork(id) {
  const season = animeSeasonById.get(id);
  if (!season) return getWork(id);
  const work = getWork(season.rootId);
  if (!work) return null;
  return {...work, id:season.playbackId || season.id, title:season.title || work.title + ' ' + season.label, year:season.year || work.year};
}

function seasonCaption(season, work) {
  const info = season.playbackId ? ['按原有集号连续播放'] : [season.title || work.title, season.year || work.year].filter(Boolean);
  const source = season.sourceUrl ? ` <a class="text-link" href="${escapeHTML(season.sourceUrl)}" target="_blank" rel="noopener">季度资料 ↗</a>` : '';
  return escapeHTML(info.join(' · ')) + source;
}

function renderSeasonPicker(work, activeId) {
  const seasons = animeSeries.get(work.id);
  if (!seasons) return '';
  const selected = animeSeasonById.get(activeId) || seasons[0];
  const choices = seasons.length > 7
    ? `<select class="select-compact" aria-label="选择季度" data-season-select>${seasons.map(s =>
      `<option value="${escapeHTML(s.id)}" ${s.id === selected.id ? 'selected' : ''}>${escapeHTML(s.label)}</option>`).join('')}</select>`
    : `<div class="season-options">${seasons.map(s =>
      `<button type="button" class="filter-chip" data-season-id="${escapeHTML(s.id)}" aria-pressed="${s.id === selected.id}">${escapeHTML(s.label)}</button>`).join('')}</div>`;
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
