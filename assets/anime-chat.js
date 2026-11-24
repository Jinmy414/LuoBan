// AI Horde's documented public anonymous key works without an account or billing.
const animeChat = (() => {
  const api = 'https://aihorde.net/api/v2/generate/text/';
  const models = ['koboldcpp/Qwen3-14B', 'koboldcpp/Qwen3-4B-Instruct-2507',
    'Qwen/Qwen3-4B-Instruct-2507', 'koboldcpp/Qwen3.5-9B'];
  const suggestions = ['想看热血的团队运动番', '喜欢《冰菓》，还有类似的吗？', '推荐一部下班后看的轻松喜剧'];
  const shelves = [
    [/运动|竞技|热血|篮球|排球|足球|球类|灌篮|乒乓|跑步|团队/u, '灌篮高手 排球少年 黑子的篮球 乒乓 网球王子 赛马娘 四驱兄弟 棋魂'],
    [/推理|悬疑|侦探|解谜|智斗|冰菓|烧脑/u, '冰菓 名侦探柯南 奇巧计程车 只有我不在的街道 夏日重现 命运石之门 死亡笔记'],
    [/轻松|搞笑|日常|喜剧|下饭|开心|解压|下班/u, '月刊少女野崎君 齐木楠雄的灾难 男子高中生的日常 猫和老鼠 荒川爆笑团 干物妹小埋'],
    [/恋爱|浪漫|校园|告白|甜|心动/u, '辉夜大小姐想让我告白 龙与虎 月色真美 擅长捉弄的高木同学 五等分的新娘'],
    [/亲情|温暖|治愈|温馨|催泪/u, '紫罗兰永恒花园 花开伊吕波 哆啦A梦 月色真美'],
    [/科幻|机甲|高达|时间|赛博/u, '命运石之门 机动战士高达SEED EVA 赛博朋克边缘行者 石纪元'],
    [/奇幻|冒险|异世界|美食|料理/u, '迷宫饭 异世界食堂 钢之炼金术师FA 中华小当家 魔女之旅 为美好的世界献上祝福'],
    [/乐队|音乐|偶像|摇滚|合奏/u, '孤独摇滚 吹响吧！上低音号 佐贺偶像是传奇'],
    [/战斗|动作|少年漫|伙伴/u, '火影忍者 钢之炼金术师FA 鬼灭之刃 海贼王 一拳超人 咒术回战']
  ];
  const actionPrefix = '{"action":"';
  let prompts;
  const pickPrefix = '{"recommendations":[{"title":"';
  let turns = [];
  let draft = '';
  let pending = null;
  let retryText = '';
  let status = '';
  let owner;

  function titleKey(value) {
    return value.normalize('NFKC').toLowerCase().replace(/[\s!！]+/gu, '');
  }

  function catalogue() {
    const published = new Map(SEED_WORKS.map(work => [work.id, work]));
    for (const work of state.works) if (work.shared) published.set(work.id, work);
    const visible = new Set(state.works.map(work => work.id));
    const items = new Map();
    for (const work of published.values()) {
      if (!visible.has(work.id) || !work.types?.some(type => ['动画','动漫'].includes(type))) continue;
      if (['XXXX学院', '小魔女之旅'].includes(work.title)) continue;
      items.set(titleKey(work.title), work);
    }
    return items;
  }

  function conversationHistory() {
    const recent = turns.slice(-3);
    // Keep the last recommendation available even when several social turns intervene.
    const lastPicks = turns.slice().reverse().find(turn => turn.picks.length);
    if (lastPicks && !recent.includes(lastPicks)) recent.unshift(lastPicks);
    const summary = recent.map(turn => ({
      用户:turn.question.slice(0, 180), 助手:turn.reply.slice(0, 150),
      推荐:turn.picks.map(p => ({片名:p.title.slice(0, 90), 理由:p.reason.slice(0, 125)}))
    }));
    while (summary.length && JSON.stringify(summary).length > 4000) summary.shift();
    return JSON.stringify(summary);
  }

  function candidates(question, query) {
    const shown = new Set(turns.flatMap(turn => turn.picks.map(p => p.id)));
    const items = catalogue();
    const names = [...items.values()].filter(work => !shown.has(work.id)).map(work => work.title);
    const subject = question + ' ' + query;
    const mentioned = titleKey(subject);
    const priority = names.filter(name => mentioned.includes(titleKey(name)));
    for (const [theme, titles] of shelves) {
      if (theme.test(subject)) priority.push(...titles.split(' ').filter(t => names.includes(t)));
    }
    const selected = new Map();
    let length = 0;
    // Start with relevant works and sample across the imported catalogue, including newer entries.
    const varied = Array.from({length:names.length}, (_, i) => names[(i % 5) * Math.ceil(names.length / 5) + Math.floor(i / 5)]).filter(Boolean);
    for (const name of new Set([...priority, ...varied, ...names])) {
      if (length + name.length + 1 > 850) continue;
      const key = titleKey(name);
      selected.set(key, items.get(key));
      length += name.length + 1;
    }
    return selected;
  }

  async function hordePrompt({question, titles, history, query, phase}) {
    if (!prompts) prompts = await request('assets/anime-prompts.json?v=1');
    const message = {最近对话:JSON.parse(history), 当前消息:question};
    if (phase === 'recommend') Object.assign(message, {选片条件:query, 候选片名:titles});
    const input = JSON.stringify(message).replace(/<\|[^\n]*?\|>/g, '').replace(/<\/?think>/gi, '');
    const prefix = phase === 'conversation' ? actionPrefix : pickPrefix;
    return '<|im_start|>system\n' + prompts[phase].join('\n') + '<|im_end|>\n<|im_start|>user\n'
      + input + '\n/no_think<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n' + prefix;
  }

  function jsonText(generation, prefix) {
    const raw = String(generation?.text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim().replace(/^```(?:json)?\s*/i, '');
    const combined = raw.startsWith('{') ? raw : prefix + raw;
    return combined.slice(0, combined.lastIndexOf('}') + 1);
  }

  function readDecision(generation) {
    const decision = JSON.parse(jsonText(generation, actionPrefix));
    if (decision?.action === 'reply' && typeof decision.reply === 'string' && decision.reply.trim()) {
      return {reply:decision.reply.trim().slice(0, 600), picks:[], model:modelName(generation)};
    }
    if (decision?.action === 'search' && typeof decision.query === 'string' && decision.query.trim()) {
      return {query:decision.query.trim().slice(0, 360)};
    }
    throw new Error('暂时无法理解这条消息，请重试。');
  }

  function modelName(generation) { return String(generation.model || '').split('/').pop(); }

  function readAnswer(generation, items) {
    const combined = jsonText(generation, pickPrefix);
    let parsed;
    try {
      parsed = JSON.parse(combined);
    } catch {
      // A worker can omit a closing brace. Recover only complete JSON string fields.
      const pairs = combined.matchAll(/"title"\s*:\s*("(?:[^"\\]|\\.)*")\s*,\s*"reason"\s*:\s*("(?:[^"\\]|\\.)*")/gu);
      const recommendations = [];
      for (const pair of pairs) {
        try { recommendations.push({title:JSON.parse(pair[1]), reason:JSON.parse(pair[2])}); } catch { /* Invalid escape. */ }
      }
      const reply = combined.match(/"reply"\s*:\s*("(?:[^"\\]|\\.)*")/u);
      if (recommendations.length) {
        parsed = {recommendations};
        if (reply) try { parsed.reply = JSON.parse(reply[1]); } catch { /* Cards still have complete reasons. */ }
      }
    }
    if (!Array.isArray(parsed?.recommendations)) throw new Error('模型的回复不完整，可以重试。');
    const picks = [];
    for (const entry of parsed.recommendations) {
      const work = typeof entry?.title === 'string' && items.get(titleKey(entry.title));
      if (!work || !getWork(work.id) || typeof entry.reason !== 'string' || !entry.reason.trim() || picks.some(p => p.id === work.id)) continue;
      picks.push({id:work.id, title:work.title, reason:entry.reason.trim().slice(0, 230)});
      if (picks.length === 2) break;
    }
    const reply = typeof parsed.reply === 'string' ? parsed.reply.trim().slice(0, 240) : '';
    if (!picks.length && (parsed.recommendations.some(r => r?.title) || !reply)) throw new Error('这次没有匹配到片库里的作品，可以换个说法或重试。');
    return {picks, reply, model:modelName(generation)};
  }

  function abandon(job) {
    if (job?.id) {
      const id = job.id;
      job.id = null;
      fetch(api + 'status/' + id, {method:'DELETE', credentials:'omit', referrerPolicy:'no-referrer'}).catch(() => {});
    }
  }

  async function request(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, {...options, credentials:'omit', referrerPolicy:'no-referrer', signal:controller.signal});
      if (response.status === 429) throw new Error('免费模型现在请求较多，请稍后重试。');
      if (!response.ok) throw new Error('免费模型暂时无法响应，请稍后重试。');
      return await response.json();
    } catch (error) {
      if (error.name === 'AbortError' || error instanceof TypeError) throw new Error('暂时连不上模型服务，请检查网络后重试。');
      throw error;
    } finally { clearTimeout(timeout); }
  }

  async function hordeGeneration(job, context) {
    const prompt = await hordePrompt(context);
    if (pending !== job) return;
    const ticket = await request(api + 'async', {method:'POST',
      headers:{'Content-Type':'application/json', apikey:'0000000000', 'Client-Agent':'Luoban:1.0:https://jinmengyao.pythonanywhere.com'},
      body:JSON.stringify({models, prompt, params:{max_length:320,
        max_context_length:4096, temperature:0.45, stop_sequence:['<|im_end|>']}})});
    if (!/^[a-f0-9-]{36}$/i.test(ticket.id || '')) throw new Error('模型服务未接收这条消息，请重试。');
    job.id = ticket.id;
    if (pending !== job) { abandon(job); return; }
    const deadline = Date.now() + 150000;
    while (pending === job && Date.now() < deadline) {
      const result = await request(api + 'status/' + job.id);
      if (pending !== job) return;
      if (result.faulted || result.is_possible === false && !result.done) throw new Error('免费模型暂时没有空闲节点，请稍后重试。');
      if (result.done) {
        job.id = null;
        return result.generations?.[0];
      }
      status = result.processing ? '正在生成回复…' :
        result.queue_position > 0 ? '正在等候免费模型，队列位置 ' + result.queue_position + '…' : '已排队，正在等待免费模型…';
      paintStatus();
      await new Promise(resolve => setTimeout(resolve, 2400));
    }
    if (pending === job) throw new Error('等候时间较长，可以稍后重试。');
  }

  async function generate(job, context, decode) {
    if (job.llama) {
      const result = await accountRequest('anime-recommend', context);
      if (pending !== job) return;
      if (!result.fallback) {
        try { return decode(result); } catch { /* Let the backup model retry this same task. */ }
      }
      status = '正在转用备用模型…';
      paintStatus();
    }
    const result = await hordeGeneration(job, context);
    if (pending !== job) return;
    try { return decode(result); } catch { throw new Error('模型回复不完整，请重试。'); }
  }

  async function send(question) {
    question = question.trim().slice(0, 360);
    if (pending || !question) return;
    const job = {question, id:null};
    pending = job;
    draft = '';
    retryText = '';
    status = '正在回复…';
    paint();
    try {
      job.llama = (await cloudflareAccess.config()).llama;
      if (pending !== job) return;
      const history = conversationHistory();
      const decision = await generate(job, {phase:'conversation', question, history}, readDecision);
      if (pending !== job) return;
      let answer = decision;
      if (decision.query) {
        const items = candidates(question, decision.query);
        if (!items.size) {
          answer = {reply:'片库里暂时没有更多动漫可以推荐。', picks:[], model:''};
        } else {
          status = '正在片库中挑选作品…';
          paintStatus();
          const titles = [...items.values()].map(work => work.title).join('｜');
          answer = await generate(job, {phase:'recommend', question, query:decision.query, history, titles},
            generation => readAnswer(generation, items));
          if (pending !== job) return;
        }
      }
      turns.push({question, ...answer});
      turns = turns.slice(-12);
      status = '';
    } catch (error) {
      if (pending !== job) return;
      abandon(job);
      status = error.message;
      retryText = question;
    } finally {
      if (pending === job) { pending = null; paint(); }
    }
  }

  function cancel() {
    const job = pending;
    pending = null;
    abandon(job);
    if (job) draft = job.question;
    status = '';
    retryText = '';
  }

  function paintStatus() {
    const el = document.getElementById('animeStatus');
    if (el && el.textContent !== status) el.textContent = status;
  }

  function card(pick) {
    const work = getWork(pick.id);
    if (!work) return '';
    return '<a class="anime-pick" href="#work-' + escapeHTML(work.id) + '">' + thumb(work) + '<span><strong>' +
      escapeHTML(work.title) + '</strong><span>' + escapeHTML(pick.reason) + '</span></span><b aria-hidden="true">›</b></a>';
  }

  function paint() {
    const root = document.getElementById('animeChat');
    if (!root) return;
    const bubble = text => '<p class="anime-question">' + escapeHTML(text) + '</p>';
    root.querySelector('.anime-log').innerHTML = turns.map(t => '<article class="anime-turn">' + bubble(t.question) +
      '<div class="anime-answer">' + (t.reply ? '<p>' + escapeHTML(t.reply) + '</p>' : '') + t.picks.map(card).join('') +
      '<small>' + escapeHTML(t.model) + '</small></div></article>').join('') + ((pending || retryText) ? bubble(pending?.question || retryText) : '');
    const log = root.querySelector('.anime-log');
    log.scrollTop = log.scrollHeight;
    root.querySelector('.anime-welcome').hidden = Boolean(turns.length || pending || retryText);
    root.querySelector('[data-chat-reset]').hidden = !turns.length && !pending && !retryText;
    root.querySelector('[data-chat-cancel]').hidden = !pending;
    root.querySelector('[data-chat-retry]').hidden = !retryText;
    const input = root.querySelector('textarea');
    input.value = draft;
    root.querySelector('[type=submit]').disabled = !!pending || !draft.trim();
    paintStatus();
  }

  function mount(app) {
    const account = currentUser()?.accountId ?? 'guest';
    if (account !== owner) { cancel(); owner = account; turns = []; draft = ''; paint(); }
    if (app.querySelector('#animeChat')) return;
    app.innerHTML = '<section class="anime-chat" id="animeChat" aria-labelledby="animeChatTitle">' +
      '<div class="anime-tools"><a class="back-link" href="#home">← 返回发现</a><button type="button" data-chat-reset hidden>新对话</button></div>' +
      '<header class="anime-heading"><img src="assets/logo-snail.png" alt=""><div><h1 id="animeChatTitle">动漫推荐</h1><p>和罗瓣聊聊下一部看什么</p></div></header>' +
      '<div class="anime-welcome"><h2>今天想看什么？</h2><div>' + suggestions.map(s => '<button type="button" data-chat-suggest>' + s + '</button>').join('') + '</div></div>' +
      '<div class="anime-log" role="log" aria-label="推荐对话" aria-live="polite" aria-relevant="additions"></div>' +
      '<div class="anime-feedback"><span id="animeStatus" role="status"></span><button type="button" data-chat-retry hidden>重试</button><button type="button" data-chat-cancel hidden>取消</button></div>' +
      '<form class="anime-form"><label for="animeQuestion">告诉罗瓣你的动漫偏好</label><textarea id="animeQuestion" maxlength="360" rows="2" placeholder="说说你喜欢的作品、题材或心情…" aria-describedby="animePrivacy"></textarea><button type="submit">发送</button></form>' +
      '<p class="anime-privacy" id="animePrivacy">推荐模型会收到本次对话和公开片名。服务由 Cloudflare 或 AI Horde 提供，请勿输入个人信息。</p></section>';
    const root = app.querySelector('#animeChat');
    const input = root.querySelector('textarea');
    const submit = root.querySelector('[type=submit]');
    root.querySelector('form').onsubmit = event => { event.preventDefault(); send(input.value); };
    input.oninput = () => { draft = input.value; submit.disabled = !!pending || !draft.trim(); };
    input.onkeydown = event => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); send(input.value); }
    };
    root.onclick = event => {
      const button = event.target.closest('button');
      if (!button) return;
      if (button.hasAttribute('data-chat-suggest')) send(button.textContent);
      if (button.hasAttribute('data-chat-retry')) send(retryText);
      if (button.hasAttribute('data-chat-cancel')) { cancel(); paint(); }
      if (button.hasAttribute('data-chat-reset')) { cancel(); turns = []; draft = ''; paint(); input.focus(); }
    };
    paint();
  }

  return {mount};
})();
