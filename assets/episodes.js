let activeEpisodePlayer = null;
let hlsLibrary;
const episodeEmbedProviders = {
  bilibili: { pattern: /^https:\/\/player\.bilibili\.com\/player\.html\?(?:bvid=BV[0-9A-Za-z]{10}&p=[1-9]\d{0,3}|episodeId=[1-9]\d{0,11})$/, example: 'https://player.bilibili.com/player.html?episodeId=…' },
  youtube: { pattern: /^https:\/\/www\.youtube\.com\/embed\/[0-9A-Za-z_-]{11}(?:\?start=(0|[1-9][0-9]{0,4})&end=([1-9][0-9]{0,4}))?$/, example: 'https://www.youtube.com/embed/视频ID' }
};

function validEpisodeUrl(url, source) {
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  const provider = episodeEmbedProviders[source];
  if (!provider) return url.pathname.toLowerCase().endsWith('.m3u8');
  const match = provider.pattern.exec(url.href);
  return Boolean(match && (!match[1] || Number(match[1]) < Number(match[2])));
}

function parseEpisodeGroups(input, workTitle, source = 'custom') {
  const text = input.replace(/^\uFEFF/, '').trim();
  if (!text || text.length > 8_000_000) throw Error('请粘贴分集数据，或选择 8 MB 以内的文件。');
  const json = /^[\[{]/.test(text) ? JSON.parse(text) : { vod_name: workTitle, vod_play_url: text };
  const rows = Array.isArray(json) ? json : json?.list || [json];
  if (!Array.isArray(rows)) throw Error('这个 JSON 缺少剧集列表。');
  const choices = [];
  for (const row of rows) {
    if (!row || typeof row.vod_play_url !== 'string') continue;
    const flags = String(row.vod_play_from || '').split('$$$');
    row.vod_play_url.split('$$$').forEach((group, index) => {
      const entries = group
        .trim()
        .split(/#|\r?\n/)
        .map((x) => x.trim())
        .filter(Boolean);
      if (!entries.length || entries.length > 3000) return;
      const episodes = [],
        labels = new Set();
      for (const entry of entries) {
        const split = entry.indexOf('$'),
          bare = /^https:\/\//i.test(entry);
        const label = bare ? '第' + (episodes.length + 1) + '集' : entry.slice(0, split).trim();
        const raw = bare ? entry : entry.slice(split + 1).trim();
        if ((!bare && split < 1) || !label || label.length > 80 || labels.has(label)) return;
        let url;
        try {
          url = new URL(raw);
        } catch {
          return;
        }
        if (!validEpisodeUrl(url, source)) return;
        labels.add(label);
        episodes.push({ label, url: url.href });
      }
      const title = String(row.vod_name || workTitle);
      const description = [title, row.vod_year, row.type_name, flags[index], episodes.length + ' 集']
        .filter(Boolean)
        .join(' · ');
      choices.push({ title, description, episodes });
    });
  }
  if (!choices.length)
    throw Error(
      episodeEmbedProviders[source] ? '请逐行填写集名和所选平台的嵌入地址。' : '未找到完整的 HTTPS HLS 分集。请使用包含 vod_play_url 的详情 JSON，或每行填写「集名$https://…m3u8」。'
    );
  return choices;
}

function openEpisodeImport(work, catalogue, opener, updated) {
  const options = catalogue.providers
    .map((p) => `<option value="${escapeHTML(p.id)}">${escapeHTML(p.name)}</option>`)
    .join('');
  const dialog = openSheet(
    '导入分集',
    `<div class="sheet-scroll episode-import"><p>为《${escapeHTML(work.title)}》添加站内播放线路。</p>
    <label class="studio-field">片源<select name="source">${options}</select></label>
    <a class="text-link" data-lookup target="_blank" rel="noopener noreferrer">打开这部作品的片源目录 ↗</a>
    <label class="studio-field">分集数据<textarea name="payload" rows="4" placeholder="粘贴片源目录返回的 JSON，或每行一条 集名$https://…m3u8"></textarea></label>
    <div class="episode-import-tools"><label class="studio-action file-label">读取文件<input type="file" accept=".json,.txt,application/json,text/plain" name="catalogueFile"></label><button type="button" class="studio-action" data-parse>解析分集</button></div>
    <div data-preview hidden><label class="studio-field">核对片名、季度和线路<select name="candidate"></select></label><div data-labels></div></div>
    <p data-existing></p><p class="form-error" role="alert"></p></div>
    <div class="sheet-foot"><button data-remove type="button" class="button button-ghost" hidden>移除线路</button><button class="button button-primary" data-save type="button" disabled>保存分集</button></div>`,
    opener
  );
  const q = (selector) => dialog.querySelector(selector);
  const source = q('[name=source]'),
    payload = q('[name=payload]'),
    candidate = q('[name=candidate]');
  const preview = q('[data-preview]'),
    save = q('[data-save]'),
    remove = q('[data-remove]'),
    error = q('[role=alert]');
  let choices = [],
    busy = false,
    fileGeneration = 0;
  function reset() {
    choices = [];
    preview.hidden = true;
    save.disabled = true;
    error.textContent = '';
  }
  function currentLine() {
    return catalogue.lines.find((line) => line.source === source.value);
  }
  function displaySource() {
    reset();
    const selected = catalogue.providers.find((p) => p.id === source.value);
    const lookup = q('[data-lookup]');
    lookup.hidden = !selected.host;
    if (selected.host)
      lookup.href =
        'https://' + selected.host + '/api.php/provide/vod/?ac=videolist&wd=' + encodeURIComponent(work.title);
    payload.placeholder = episodeEmbedProviders[selected.id]
      ? '每行一集：第1集$' + episodeEmbedProviders[selected.id].example
      : '粘贴片源目录返回的 JSON，或每行一条 集名$https://…m3u8';
    const current = currentLine();
    q('[data-existing]').textContent = current
      ? `当前线路为《${current.title}》，共 ${current.episodes.length} 集。保存时将更新这条线路。`
      : '';
    remove.hidden = !current;
  }
  function selectCandidate() {
    const item = candidate.value === '' ? null : choices[Number(candidate.value)];
    save.disabled = !item;
    const labels = item?.episodes.map((e) => e.label) || [];
    q('[data-labels]').textContent =
      labels.length > 8 ? [...labels.slice(0, 5), '…', ...labels.slice(-2)].join(' · ') : labels.join(' · ');
  }
  function parse() {
    reset();
    try {
      choices = parseEpisodeGroups(payload.value, work.title, source.value);
      candidate.innerHTML =
        '<option value="">选择要导入的版本</option>' +
        choices.map((c, i) => `<option value="${i}">${escapeHTML(c.description)}</option>`).join('');
      preview.hidden = false;
      if (choices.length === 1) candidate.value = '0';
      selectCandidate();
      candidate.focus();
    } catch (e) {
      error.textContent = e instanceof SyntaxError ? 'JSON 格式有误，请复制完整内容。' : e.message;
    }
  }
  source.addEventListener('change', () => {
    fileGeneration++;
    payload.value = '';
    q('[name=catalogueFile]').value = '';
    displaySource();
  });
  payload.addEventListener('input', () => {
    fileGeneration++;
    reset();
  });
  q('[data-parse]').onclick = parse;
  candidate.onchange = selectCandidate;
  q('[name=catalogueFile]').onchange = async (event) => {
    const file = event.target.files[0],
      generation = ++fileGeneration;
    if (!file) return;
    reset();
    if (file.size > 8_000_000) {
      error.textContent = '请选择 8 MB 以内的文件。';
      return;
    }
    try {
      const value = await file.text();
      if (fileGeneration === generation) {
        payload.value = value;
        parse();
      }
    } catch {
      error.textContent = '读取失败，请重新选择文件。';
    }
  };
  async function commit(removing) {
    if (busy || (!removing && save.disabled)) return;
    if (removing && !window.confirm('移除这部作品的当前线路？')) return;
    const current = currentLine(),
      item = choices[Number(candidate.value)];
    busy = true;
    save.disabled = true;
    remove.disabled = true;
    try {
      const data = { source: source.value, revision: current?.revision || null };
      if (removing) data.action = 'remove';
      else Object.assign(data, { title: item.title, episodes: item.episodes });
      await accountRequest('episodes/' + encodeURIComponent(work.id), data);
      dialog.close();
      await updated();
      showToast(removing ? '播放线路已移除' : '分集已保存');
    } catch (e) {
      error.textContent = e.message;
    } finally {
      busy = false;
      remove.disabled = false;
      selectCandidate();
    }
  }
  save.onclick = () => commit(false);
  remove.onclick = () => commit(true);
  displaySource();
}

function loadHlsLibrary() {
  if (window.Hls) return Promise.resolve(window.Hls);
  if (!hlsLibrary)
    hlsLibrary = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'assets/vendor/hls-1.7.4/hls.min.js';
      script.onload = () => resolve(window.Hls);
      script.onerror = () => {
        script.remove();
        hlsLibrary = null;
        reject(Error('播放器加载失败，请重试。'));
      };
      document.head.appendChild(script);
    });
  return hlsLibrary;
}

let youtubeLibrary;
function loadYouTubeLibrary() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (!youtubeLibrary) {
    youtubeLibrary = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const failed = () => {
        clearTimeout(timer);
        script.remove();
        youtubeLibrary = null;
        reject(Error('未能连接 YouTube 进度服务。'));
      };
      const timer = setTimeout(failed, 12000);
      window.onYouTubeIframeAPIReady = () => { clearTimeout(timer); resolve(window.YT); };
      script.src = 'https://www.youtube.com/iframe_api';
      script.onerror = failed;
      document.head.appendChild(script);
    });
  }
  return youtubeLibrary;
}

function stopEpisodePlayer() {
  activeEpisodePlayer?.stop();
  activeEpisodePlayer = null;
}

function playEpisodes(work, catalogue, initialSource, initialLabel, initialSeconds, resumeRequested) {
  stopEpisodePlayer();
  const room = document.getElementById('episodeRoom');
  if (!room) return;
  room.hidden = false;
  const cover = safeImage(work.coverImage);
  room.innerHTML = `<div class="episode-player-head"><h2>站内播放</h2><span data-count></span></div>
    <div class="episode-stage">
      <button type="button" class="episode-preview" data-play-episodes>
        ${cover ? `<img src="${escapeHTML(cover)}" alt="">` : ''}
        <span class="episode-preview-content"><span class="episode-play-icon" aria-hidden="true">▶</span>
          <strong data-play-label></strong></span>
      </button>
      <video hidden controls playsinline preload="none" aria-label="${escapeHTML(work.title)}"></video>
    </div>
    <div class="episode-player-controls"><label>信号源<select name="line"></select></label>
    <label><span data-pick-label>选集</span><select name="episode"></select></label><button type="button" class="studio-action" data-next>下一集</button></div>
    <div class="episode-feedback" role="status"></div>
    <a class="text-link" data-open-episode hidden target="_blank" rel="noopener noreferrer"></a>`;
  const video = room.querySelector('video'),
    source = room.querySelector('[name=line]'),
    picker = room.querySelector('[name=episode]');
  const next = room.querySelector('[data-next]'),
    feedback = room.querySelector('[role=status]');
  const preview = room.querySelector('[data-play-episodes]');
  const stage = room.querySelector('.episode-stage');
  const playLabel = room.querySelector('[data-play-label]');
  const openEpisode = room.querySelector('[data-open-episode]');
  const lines = catalogue.lines.map((line, index) => ({ ...line, displayName: `信号源${index + 1}` }));
  const labels = [...new Set(lines.flatMap(l => l.episodes.map(e => e.label)))];
  const episodeLabel = /^第(\d+)集([上下])?$/;
  const numberedEpisodes = labels.every(label => episodeLabel.test(label));
  if (numberedEpisodes) {
    const partOrder = label => label.endsWith('上') ? 1 : label.endsWith('下') ? 2 : 0;
    labels.sort((a,b) => parseInt(a.slice(1)) - parseInt(b.slice(1)) || partOrder(a) - partOrder(b));
  }
  picker.innerHTML = labels.map((label, i) => `<option value="${i}">${escapeHTML(label)}</option>`).join('');
  const issues = labels.map(label => /^第(\d+)期(?:[上下])?$/.exec(label));
  const collectionCount = labels.filter(label => /合集|合辑/.test(label)).length;
  if (issues.every(Boolean)) {
    room.querySelector('[data-count]').textContent = '共 ' + new Set(issues.map(m => m[1])).size + ' 期';
    room.querySelector('[data-pick-label]').textContent = '选期';
    next.textContent = labels.some(label => /[上下]$/.test(label)) ? '下一段' : '下一期';
  } else if (numberedEpisodes && labels.some(label => /[上下]$/.test(label))) {
    const count = new Set(labels.map(label => parseInt(label.slice(1)))).size;
    room.querySelector('[data-count]').textContent = '已接入 ' + count + ' 集 · ' + labels.length + ' 段';
    next.textContent = '下一段';
  } else if (collectionCount) {
    const episodes = labels.length - collectionCount;
    const counts = episodes ? [episodes + ' 集', collectionCount + ' 个合集'] : [collectionCount + ' 个合集'];
    room.querySelector('[data-count]').textContent = '已接入 ' + counts.join(' · ');
    room.querySelector('[data-pick-label]').textContent = episodes ? '选集或合集' : '选合集';
    next.textContent = episodes ? '下一条' : '下一个合集';
  } else {
    room.querySelector('[data-count]').textContent = '已接入 ' + labels.length + ' 集';
  }
  if (lines.length === 1 && lines[0].source === 'youtube' && !document.querySelector('[data-season-caption]'))
    room.querySelector('[data-count]').append(' · 需连接 YouTube');
  const nextLabel = next.textContent;
  let missingBeforeNext = '';
  const failed = new Set();
  let frame, loadTimer, youtubePlayer, youtubeTimer, clipStart = 0;
  let line,
    entry,
    hls = null,
    recorded = -1,
    hasPlayed = false,
    resume = 0,
    generation = 0,
    stopped = false,
    attaching = false;
  const accountId = activeAccount?.id;
  function report(message, retry = false) {
    feedback.textContent = message;
    if (retry) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'studio-action';
      b.textContent = '重试本集';
      b.onclick = () => start(line, entry.label, position() || resume);
      feedback.append(' ', b);
    }
  }
  function position() {
    const time = frame ? (youtubePlayer?.getCurrentTime?.() ?? 0) - clipStart : video.currentTime;
    return Number.isFinite(time) ? Math.max(0, Math.floor(time)) : 0;
  }
  function persist() {
    if (!hasPlayed || !entry || !accountId || activeAccount?.id !== accountId || attaching) return;
    const seconds = position();
    if (!seconds || seconds === recorded) return;
    recorded = seconds;
    const data = { accountId, source: line.source, revision: line.revision, label: entry.label, seconds };
    progressWrites = progressWrites
      .then(async () => {
        if (activeAccount?.id !== accountId) return;
        const response = await fetch('api/episode-progress/' + encodeURIComponent(work.id), {
          method: 'POST',
          credentials: 'same-origin',
          keepalive: true,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });
        if (!response.ok) throw Error();
      })
      .catch(() => {
        if (!stopped && entry.label === data.label && line.source === data.source) {
          recorded = -1;
          report('进度同步失败，仍可继续观看。');
        }
      });
  }
  function release() {
    attaching = true;
    clearTimeout(loadTimer);
    clearInterval(youtubeTimer);
    youtubePlayer?.destroy();
    youtubePlayer = null;
    clipStart = 0;
    frame?.remove();
    frame = null;
    video.pause();
    hls?.destroy();
    hls = null;
    video.removeAttribute('src');
    if (!video.hidden) video.load();
    hasPlayed = false;
    recorded = -1;
  }
  function stop() {
    persist();
    stopped = true;
    generation++;
    release();
    room.hidden = true;
    room.replaceChildren();
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', persist);
  }
  const onVisibility = () => {
    if (document.hidden) persist();
  };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', persist);
  activeEpisodePlayer = { stop };
  function tryPlay(token) {
    video.play().catch((e) => {
      if (generation !== token || stopped || e.name === 'AbortError') return;
      if (e.name === 'NotAllowedError') report('轻点视频上的播放键开始。');
    });
  }
  function select(chosenLine, label, seconds) {
    line = chosenLine;
    entry = line.episodes.find((e) => e.label === label) || line.episodes[0];
    stage.classList.toggle('youtube-stage', line.source === 'youtube');
    openEpisode.hidden = true;
    openEpisode.removeAttribute('href');
    if (episodeEmbedProviders[line.source]) {
      const url = new URL(entry.url);
      if (line.source === 'youtube') {
        const watch = new URL('https://www.youtube.com/watch');
        watch.searchParams.set('v', url.pathname.split('/').pop());
        if (url.searchParams.has('start')) watch.searchParams.set('t', url.searchParams.get('start') + 's');
        openEpisode.href = watch.href;
      } else if (line.source === 'bilibili') {
        const episode = url.searchParams.get('episodeId');
        openEpisode.href = episode ? 'https://www.bilibili.com/bangumi/play/ep' + episode
          : 'https://www.bilibili.com/video/' + url.searchParams.get('bvid') + '/?p=' + url.searchParams.get('p');
      }
      if (openEpisode.hasAttribute('href')) {
        openEpisode.textContent = '在' + line.name + '打开本集 ↗';
        openEpisode.hidden = false;
      }
    }
    resume = seconds;
    const available = choices(entry.label);
    source.innerHTML = available.map(l => `<option value="${escapeHTML(l.source)}">${l.displayName}</option>`).join('') ||
      '<option value="">本集暂不可用</option>';
    if (available.includes(line)) source.value = line.source;
    source.disabled = available.length < 2;
    const index = labels.indexOf(entry.label);
    picker.value = String(index);
    const following = labels[index + 1];
    next.disabled = !following;
    missingBeforeNext = '';
    const currentNumber = episodeLabel.exec(entry.label);
    const nextNumber = episodeLabel.exec(following || '');
    if (currentNumber && nextNumber) {
      const first = Number(currentNumber[1]) + 1, last = Number(nextNumber[1]) - 1;
      if (first <= last) missingBeforeNext = (first === last ? '第' + first + '集' : '第' + first + '至' + last + '集') + '暂缺';
    }
    next.textContent = missingBeforeNext ? missingBeforeNext + '，跳至' + following : nextLabel;
    playLabel.textContent = seconds > 0 ? '续看' + entry.label + ' · ' + episodeTime(seconds) : '播放' + entry.label;
  }
  function choices(label) {
    return lines.filter(l => l.episodes.some(e => e.label === label && !failed.has(e.url)));
  }
  function unavailable(token) {
    if (stopped || generation !== token || attaching) return;
    if (!navigator.onLine) {
      clearTimeout(loadTimer);
      report('网络已断开，连接后可以重试。', true);
      return;
    }
    const seconds = position() || resume;
    failed.add(entry.url);
    const alternative = choices(entry.label)[0];
    if (alternative) {
      start(alternative, entry.label, seconds);
      return;
    }
    persist();
    generation++;
    release();
    select(line, entry.label, seconds);
    video.hidden = true;
    preview.hidden = false;
    playLabel.textContent = '重新检测' + entry.label;
    report('本集信号源暂时无法播放，可以重新检测或选择其他集。');
  }
  function rememberEmbeddedEpisode() {
    if (!accountId) return;
    const token = generation;
    const data = { accountId, source: line.source, revision: line.revision, label: entry.label, kind:'opened', seconds:null };
    progressWrites = progressWrites.then(() => {
      if (activeAccount?.id === accountId) return accountRequest('episode-progress/' + encodeURIComponent(work.id), data);
    }).catch(() => { if (generation === token) report('本集观看记录未同步。'); });
  }
  openEpisode.onclick = rememberEmbeddedEpisode;
  openEpisode.addEventListener('auxclick', event => {
    if (event.button === 1) rememberEmbeddedEpisode();
  });
  async function start(chosenLine, label, seconds) {
    persist();
    const token = ++generation;
    release();
    select(chosenLine, label, seconds);
    preview.hidden = true;
    video.hidden = false;
    report('正在连接' + line.displayName + '…');
    if (episodeEmbedProviders[line.source]) {
      video.hidden = true;
      frame = document.createElement('iframe');
      frame.title = work.title + ' · ' + entry.label + ' · ' + line.displayName + ' 播放器';
      frame.allow = 'autoplay; fullscreen; picture-in-picture';
      frame.allowFullscreen = true;
      frame.referrerPolicy = 'strict-origin-when-cross-origin';
      const embedUrl = new URL(entry.url);
      embedUrl.searchParams.set('autoplay', '1');
      const isYouTube = line.source === 'youtube';
      if (isYouTube) {
        clipStart = Number(embedUrl.searchParams.get('start') || 0);
        const end = Number(embedUrl.searchParams.get('end'));
        if (seconds > 0 && (!end || clipStart + seconds < end - 1))
          embedUrl.searchParams.set('start', String(clipStart + seconds));
        embedUrl.searchParams.set('enablejsapi','1');
        embedUrl.searchParams.set('playsinline','1');
        embedUrl.searchParams.set('origin',location.origin);
      }
      frame.src = embedUrl.href;
      stage.append(frame);
      frame.onload = () => { if (generation === token) report(''); };
      attaching = false;
      if (!isYouTube) {
        rememberEmbeddedEpisode();
        return;
      }
      try {
        const yt = await loadYouTubeLibrary();
        if (generation !== token || stopped) return;
        const track = state => {
          if (generation !== token || stopped) return;
          if (state === yt.PlayerState.PLAYING) {
            hasPlayed = true;
            persist();
          } else if (state === yt.PlayerState.PAUSED || state === yt.PlayerState.ENDED) {
            persist();
          }
        };
        youtubePlayer = new yt.Player(frame, {events:{
          onReady: event => track(event.target.getPlayerState()),
          onStateChange: event => track(event.data),
          onError: () => unavailable(token)
        }});
        youtubeTimer = setInterval(() => {
          if (hasPlayed && (recorded < 0 || Math.abs(position() - recorded) >= 15)) persist();
        }, 1000);
      } catch {
        if (generation === token && !stopped) rememberEmbeddedEpisode();
      }
      return;
    }
    try {
      const hasMediaSource = window.MediaSource || window.ManagedMediaSource;
      const Hls = hasMediaSource ? await loadHlsLibrary() : null;
      if (token !== generation || stopped) return;
      loadTimer = setTimeout(() => { if (video.readyState < 2) unavailable(token); }, 20000);
      if (!Hls?.isSupported()) {
        if (video.canPlayType('application/vnd.apple.mpegurl')) {
          attaching = false;
          video.src = entry.url;
          tryPlay(token);
        } else {
          clearTimeout(loadTimer);
          report('此浏览器不支持 HLS 播放。');
        }
        return;
      }
      hls = new Hls({ capLevelToPlayerSize: true });
      hls.on(Hls.Events.ERROR, (_, d) => {
        if (d.fatal) unavailable(token);
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (token === generation) tryPlay(token);
      });
      attaching = false;
      hls.loadSource(entry.url);
      hls.attachMedia(video);
    } catch (e) {
      if (token === generation) report(e.message, true);
    }
  }
  video.onloadeddata = () => clearTimeout(loadTimer);
  video.onloadedmetadata = () => {
    if (resume > 0 && Number.isFinite(video.duration)) {
      if (resume < video.duration - 1) video.currentTime = resume;
      resume = 0;
    }
  };
  video.onplaying = () => {
    if (!attaching) {
      hasPlayed = true;
      report('');
      persist();
    }
  };
  video.ontimeupdate = () => {
    if (hasPlayed && !video.seeking && !video.paused && (recorded < 0 || Math.abs(video.currentTime - recorded) >= 15)) persist();
  };
  video.onpause = () => {
    if (!stopped) persist();
  };
  video.onseeked = () => {
    if (!attaching) persist();
  };
  video.onerror = () => {
    if (video.error) unavailable(generation);
  };
  function choose(chosenLine, label, seconds) {
    if (preview.hidden) start(chosenLine, label, seconds);
    else select(chosenLine, label, seconds);
  }
  function chooseEpisode(label) {
    const available = choices(label);
    const selected = available.includes(line) ? line : available[0];
    if (selected) { report(''); choose(selected, label, 0); }
    else {
      const original = lines.find(l => l.episodes.some(e => e.label === label));
      persist();
      generation++;
      release();
      select(original, label, 0);
      video.hidden = true;
      preview.hidden = false;
      playLabel.textContent = '重新检测' + label;
      report('本集信号源暂时无法播放。');
    }
  }
  const advance = () => {
    const label = labels[Number(picker.value) + 1];
    if (label) chooseEpisode(label);
  };
  video.onended = () => {
    persist();
    if (missingBeforeNext) report(missingBeforeNext + '，可手动选择后续集数。');
    else if (!next.disabled) advance();
  };
  source.onchange = () => {
    const chosen = lines.find((l) => l.source === source.value);
    const match = chosen.episodes.find((e) => e.label === entry.label);
    choose(chosen, match?.label || chosen.episodes[0].label, match ? (position() || resume) : 0);
  };
  picker.onchange = () => chooseEpisode(labels[Number(picker.value)]);
  next.onclick = advance;
  select(lines.find((l) => l.source === initialSource) || lines[0], initialLabel, initialSeconds || 0);
  preview.onclick = () => {
    if (!choices(entry.label).length) {
      for (const candidate of lines) {
        const e = candidate.episodes.find(e => e.label === entry.label);
        if (e) failed.delete(e.url);
      }
    }
    start(line, entry.label, resume);
    (frame || video).focus({ preventScroll: true });
  };
  if (resumeRequested) {
    preview.click();
    room.scrollIntoView({ block: 'start', behavior: 'instant' });
  }
}

async function loadEpisodeAccess(work, target) {
  const access = document.createElement('div');
  access.className = 'episode-access';
  target.prepend(access);
  async function refresh() {
    try {
      await progressWrites;
      const catalogue = await accountRequest('episodes/' + encodeURIComponent(work.id));
      if (!access.isConnected) return;
      const resumeRequested = requestedResume === work.id;
      const records = resumeRequested ? [catalogue.lastOpened, catalogue.progress] : [catalogue.progress, catalogue.lastOpened];
      const progress = records.find(record => record && catalogue.lines.some(l =>
        l.source === record.source && l.episodes.some(e => e.label === record.label)));
      const line = catalogue.lines.find(l => l.source === progress?.source) || catalogue.lines[0];
      access.innerHTML = catalogue.providers ? '<button type="button" class="studio-action" data-import>导入分集</button>' : '';
      if (resumeRequested) requestedResume = null;
      if (line) {
        playEpisodes(work, catalogue, line.source, progress?.label || line.episodes[0].label,
          progress?.seconds || 0, resumeRequested);
      }
      const links = (catalogue.officialLinks || []).filter(link => link.url.startsWith('https://'));
      if (links.length) {
        const buttons = links.map(link =>
          `<a class="studio-action" data-official href="${escapeHTML(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(link.platform)} ↗</a>`
        );
        const visibleCount = 4;
        const more = buttons.length > visibleCount
          ? `<details class="season-more-platforms"><summary>更多平台（${buttons.length - visibleCount}）</summary><div class="detail-actions">${buttons.slice(visibleCount).join('')}</div></details>` : '';
        const platforms = `<p>可观看地区和会员要求以平台页面为准。</p><div class="detail-actions">${buttons.slice(0, visibleCount).join('')}</div>${more}`;
        access.insertAdjacentHTML('afterbegin', line
          ? `<details><summary>官方播放平台（${links.length}）</summary>${platforms}</details>`
          : `<section><h2>前往官方平台观看</h2><p>本站暂无可播放的分集。</p>${platforms}</section>`);
      } else if (!line) {
        access.insertAdjacentHTML('afterbegin', '<p class="studio-empty">暂无已验证的信号源。</p>');
      }
      const opener = access.querySelector('[data-import]');
      if (opener)
        opener.onclick = () =>
          openEpisodeImport(work, catalogue, opener, async () => {
            stopEpisodePlayer();
            loadPlaybackSummaries(true);
            await refresh();
          });
    } catch (e) {
      if (access.isConnected) {
        access.textContent = e.message + ' ';
        const retry = document.createElement('button');
        retry.textContent = '重新读取分集';
        retry.className = 'studio-action';
        retry.onclick = refresh;
        access.append(retry);
      }
    }
  }
  function rememberOfficial(event) {
    const link = event.target.closest('a[data-official]');
    const accountId = activeAccount?.id;
    if (!link || !accountId || (event.type === 'auxclick' && event.button !== 1)) return;
    const url = link.getAttribute('href');
    progressWrites = progressWrites.then(() => {
      if (activeAccount?.id === accountId) return accountRequest('history', {id:work.id, url});
    }).catch(() => { if (access.isConnected) showToast('观看记录未能同步'); });
  }
  access.addEventListener('click', rememberOfficial);
  access.addEventListener('auxclick', rememberOfficial);
  await refresh();
}
