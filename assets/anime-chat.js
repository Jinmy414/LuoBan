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
  const prefix = '{"recommendations":[{"title":"';
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

  function recommendationContext(question, items) {
    const recent = turns.slice(-3).map(turn => ({
      问: turn.question.slice(0, 150), 答: turn.reply.slice(0, 65),
      推荐: turn.picks.map(p => p.title)
    }));
    const history = JSON.stringify(recent);
    const names = [...items.values()].map(w => w.title);
    // Keep named and previously discussed works in the window as the catalogue grows.
    const mentioned = titleKey(question + history);
    const subject = question + recent.map(turn => turn.问 + turn.推荐.join(' ')).join(' ');
    const priority = names.filter(name => mentioned.includes(titleKey(name)));
    for (const [theme, titles] of shelves) {
      if (theme.test(subject)) priority.push(...titles.split(' ').filter(t => items.has(titleKey(t))));
    }
    let list = '';
    // Start with relevant works and sample across the imported catalogue, including newer entries.
    const varied = Array.from({length:names.length}, (_, i) => names[(i % 5) * Math.ceil(names.length / 5) + Math.floor(i / 5)]).filter(Boolean);
    for (const name of new Set([...priority, ...varied, ...names])) {
      if (list.length + name.length > 850) break;
      list += (list ? '｜' : '') + name;
    }
    return {question, titles:list, history};
  }

  function hordePrompt({question, titles, history}) {
    const clean = text => text.replace(/<\|[^\n]*?\|>/g, '').replace(/<\/?think>/gi, '');
    return '<|im_start|>system\n你是罗瓣的中文动漫推荐助手。根据用户的口味从候选片名中推荐，不剧透。返回 JSON：{"recommendations":[{"title":"候选片名原文","reason":"为什么适合对方"}],"reply":"一句回应或追问"}。无法推荐时用空片名并在 reply 中回应。<|im_end|>\n'
      + '<|im_start|>user\n最近聊过：' + clean(history) + '\n候选片名：' + clean(titles)
      + '\n观众说：' + clean(question) + '\n结合观众的要求，在上面选一到两部，在 recommendations 中逐部写中文理由。追问时参考之前的对话；换几部时避开刚推荐的作品。/no_think<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n' + prefix;
  }

  function readAnswer(generation, items) {
    const raw = String(generation?.text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const complete = raw.match(/^\s*(?:```(?:json)?\s*)?(\{\s*"(?:(?:recommendations)|(?:reply))"[\s\S]*\})/i);
    const combined = complete ? complete[1] : prefix + raw;
    let parsed;
    try {
      parsed = JSON.parse(combined.slice(0, combined.lastIndexOf('}') + 1));
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
    // Some workers put a recommendation in their reply despite requesting structured cards.
    if (!picks.length && reply) {
      for (const match of reply.matchAll(/《([^》]+)》/g)) {
        const work = items.get(titleKey(match[1]));
        if (work && getWork(work.id) && !picks.some(p => p.id === work.id)) picks.push({id:work.id, title:work.title, reason:''});
        if (picks.length === 2) break;
      }
    }
    if (!picks.length && (parsed.recommendations.some(r => r?.title) || !reply)) throw new Error('这次没有匹配到片库里的作品，可以换个说法或重试。');
    return {picks, reply, model:String(generation.model || '').split('/').pop()};
  }

  function abandon(job) {
    if (job?.id) {
      const id = job.id;
      job.id = null;
      fetch(api + 'status/' + id, {method:'DELETE', credentials:'omit', referrerPolicy:'no-referrer'}).catch(() => {});
    }
  }

  async function request(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(api + path, {...options, credentials:'omit', referrerPolicy:'no-referrer', signal:controller.signal});
      if (response.status === 429) throw new Error('免费模型现在请求较多，请稍后重试。');
      if (!response.ok) throw new Error('免费模型暂时无法响应，请稍后重试。');
      return await response.json();
    } catch (error) {
      if (error.name === 'AbortError' || error instanceof TypeError) throw new Error('暂时连不上模型服务，请检查网络后重试。');
      throw error;
    } finally { clearTimeout(timeout); }
  }

  async function hordeGeneration(job, context) {
    const ticket = await request('async', {method:'POST',
      headers:{'Content-Type':'application/json', apikey:'0000000000', 'Client-Agent':'Luoban:1.0:https://jinmengyao.pythonanywhere.com'},
      body:JSON.stringify({models, prompt:hordePrompt(context), params:{max_length:320,
        max_context_length:4096, temperature:0.45, stop_sequence:['<|im_end|>']}})});
    if (!/^[a-f0-9-]{36}$/i.test(ticket.id || '')) throw new Error('模型服务未接收这条消息，请重试。');
    job.id = ticket.id;
    if (pending !== job) { abandon(job); return; }
    const deadline = Date.now() + 150000;
    while (pending === job && Date.now() < deadline) {
      const result = await request('status/' + job.id);
      if (pending !== job) return;
      if (result.faulted || result.is_possible === false && !result.done) throw new Error('免费模型暂时没有空闲节点，请稍后重试。');
      if (result.done) {
        job.id = null;
        return result.generations?.[0];
      }
      status = result.processing ? '正在挑选作品、整理推荐理由…' :
        result.queue_position > 0 ? '正在等候免费模型，队列位置 ' + result.queue_position + '…' : '已排队，正在等待免费模型…';
      paintStatus();
      await new Promise(resolve => setTimeout(resolve, 2400));
    }
    if (pending === job) throw new Error('等候时间较长，可以稍后重试。');
  }

  async function send(question) {
    question = question.trim().slice(0, 360);
    if (pending || !question) return;
    const items = catalogue();
    if (!items.size) { status = '片库中暂时没有可推荐的动漫。'; paint(); return; }
    const job = {question, id:null};
    pending = job;
    draft = '';
    retryText = '';
    status = '正在连接免费模型…';
    paint();
    try {
      const context = recommendationContext(question, items);
      const {llama} = await cloudflareAccess.config();
      if (pending !== job) return;
      let answer;
      if (llama) {
        status = '正在用 Llama 3.3 70B 挑选作品…';
        paintStatus();
        const result = await accountRequest('anime-recommend', context);
        if (pending !== job) return;
        if (!result.fallback) {
          try { answer = readAnswer(result, items); } catch { /* Try the other model if the first reply is unusable. */ }
        }
        if (!answer) { status = '正在转用备用 Qwen 模型…'; paintStatus(); }
      }
      if (!answer) {
        const generation = await hordeGeneration(job, context);
        if (pending !== job) return;
        answer = readAnswer(generation, items);
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
