/* 历史对话管理 · 界面逻辑
   刻意不用框架：一个页面、一套状态、一次重渲染，够用且没有构建步骤。 */

const state = {
  sessions: [],
  filter: 'active',
  query: '',
  currentId: null,
  current: null,
  turns: [],
  status: null,
  settings: null,
  searchResult: null,       // 非空时左栏显示检索结果
  searchScope: 'conversation',
  focusSeq: null,           // 打开会话后要滚动并高亮到的位置
};

const $ = (sel) => document.querySelector(sel);

// ── 小工具 ─────────────────────────────────────────────
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== undefined && value !== null) node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '—');

function fmtSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

const shortId = (id) => (id ?? '').replace(/^session-/, '').slice(0, 8);

function toast(kind, text, desc) {
  const node = el('div', { class: `toast toast-${kind}` }, [
    el('div', { text }),
    desc ? el('div', { class: 'toast-desc', text: desc }) : null,
  ]);
  $('#toast-wrap').append(node);
  setTimeout(() => node.remove(), kind === 'bad' ? 9000 : 5200);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (!res.ok) {
    const err = new Error(data?.error ?? `请求失败（${res.status}）`);
    err.status = res.status;
    err.needsForce = data?.needsForce === true;
    throw err;
  }
  return data;
}

// ── 确认对话框 ─────────────────────────────────────────
function askConfirm({ title, body, okText = '确定', danger = false, forceRow = false, extraField = null }) {
  return new Promise((resolve) => {
    const modal = $('#modal');
    $('#modal-title').textContent = title;
    const bodyNode = $('#modal-body');
    bodyNode.replaceChildren(...[].concat(body));
    const force = $('#force-row');
    force.hidden = !forceRow;
    $('#force-check').checked = false;

    if (extraField) {
      const input = el('input', {
        id: 'modal-extra',
        class: 'search',
        type: 'text',
        placeholder: extraField.placeholder ?? '',
        style: 'margin-top:12px',
      });
      bodyNode.append(el('div', {}, [el('label', { text: extraField.label, style: 'display:block;margin-top:14px;font-size:12.5px;color:var(--ink-2)' }), input]));
    }

    const okBtn = $('#modal-ok');
    okBtn.textContent = okText;
    okBtn.className = `btn ${danger ? 'btn-danger' : 'btn-solid'}`;

    const onClose = () => {
      modal.removeEventListener('close', onClose);
      const ok = modal.returnValue === 'ok';
      resolve({
        ok,
        force: $('#force-check').checked,
        extra: document.getElementById('modal-extra')?.value ?? '',
      });
    };
    modal.addEventListener('close', onClose);
    modal.showModal();
  });
}

// ── 渲染：状态栏 ───────────────────────────────────────
function renderStatus() {
  const s = state.status;
  const dot = $('#status .dot');
  const text = $('#status-text');
  if (!s) {
    dot.className = 'dot dot-idle';
    text.textContent = '正在读取…';
    return;
  }
  if (s.dshRunning) {
    dot.className = 'dot dot-warn';
    text.textContent = `DSH 运行中（端口 ${s.dshPort}）· 归档与删除需先关掉它`;
  } else {
    dot.className = 'dot dot-ok';
    text.textContent = `DSH 未运行 · 全部操作可用`;
  }
}

// ── 渲染：列表 ─────────────────────────────────────────
function visibleSessions() {
  const q = state.query.toLowerCase();
  return state.sessions.filter((s) => {
    if (state.filter === 'active' && s.archived) return false;
    if (state.filter === 'archived' && !s.archived) return false;
    if (!q) return true;
    return [s.title, s.cwd, s.id].filter(Boolean).some((v) => String(v).toLowerCase().includes(q));
  });
}

function renderList() {
  if (state.searchResult) return renderSearchResults();
  const list = $('#session-list');
  const items = visibleSessions();
  list.replaceChildren();

  $('#list-meta').textContent = `${items.length} 条 · 共 ${state.sessions.length} 条`;

  if (!items.length) {
    list.append(el('li', {}, [
      el('div', { class: 'empty', style: 'padding:40px 20px' }, [
        el('div', { class: 'empty-title', text: '这里没有卷宗' }),
        el('p', { text: state.query ? '换个关键词试试，或切换到「全部」。' : '换个分组看看。' }),
      ]),
    ]));
    return;
  }

  for (const s of items) {
    const pills = [];
    if (s.archived) pills.push(el('span', { class: 'pill pill-arch', text: '已归档' }));
    if (!s.registered && !s.archived) pills.push(el('span', { class: 'pill pill-free', text: '未分组' }));
    if (s.error) pills.push(el('span', { class: 'pill pill-bad', text: '读取异常' }));
    if (s.idSafe === false) pills.push(el('span', { class: 'pill pill-bad', text: 'ID 可疑' }));

    const row = el('li', {
      class: `row${s.id === state.currentId ? ' is-on' : ''}`,
      onclick: () => selectSession(s.id),
    }, [
      el('div', { class: 'row-title', text: s.title || `（无标题）${shortId(s.id)}` }),
      el('div', { class: 'row-sub' }, [
        el('span', { text: fmtDate(s.lastTime ?? s.createdAt) }),
        el('span', { text: `${s.turnCount} 轮` }),
        el('span', { text: fmtSize(s.size) }),
        ...pills,
      ]),
      el('div', { class: 'row-cwd', text: s.cwd ?? '（无工作区）', title: s.cwd ?? '' }),
    ]);
    list.append(row);
  }
}

// ── 渲染：检索结果 ─────────────────────────────────────
const kindLabel = (k) => (k === 'user' ? '你' : k === 'assistant' ? 'DSH' : k === 'tool' ? '工具' : '系统');

function renderSearchResults() {
  const list = $('#session-list');
  const meta = $('#list-meta');
  const r = state.searchResult;
  list.replaceChildren();

  if (r.searching) {
    meta.textContent = '正在检索…';
    list.append(el('li', {}, [el('div', { class: 'search-hint', text: `正在全部会话里找「${r.query}」…` })]));
    return;
  }
  if (r.note) {
    meta.textContent = r.note;
    list.append(el('li', {}, [el('div', { class: 'search-hint', text: r.note })]));
    return;
  }

  meta.textContent = `${r.total} 处命中 · ${r.sessions.length} 个会话 · ${r.elapsedMs}ms`
    + `${r.mode === 'all' ? ' · 含工具记录' : ''}${r.truncated ? ' · 已截断' : ''}`;

  if (!r.sessions.length) {
    list.append(el('li', {}, [el('div', { class: 'search-hint', text: `没有找到「${r.query}」` })]));
    return;
  }

  for (const s of r.sessions) {
    list.append(el('li', { class: 'search-group' }, [
      el('div', { class: 'search-group-title', text: s.title || `（无标题）${shortId(s.sessionId)}` }),
      el('div', { class: 'search-group-sub', text: `${s.hits.length} 处 · ${s.cwd ?? '（无工作区）'}` }),
    ]));
    for (const h of s.hits) {
      list.append(el('li', {
        class: `search-hit hit-${h.kind}`,
        onclick: () => openAt(s.sessionId, h.seq),
      }, [
        el('div', { class: 'search-hit-head' }, [
          el('span', { class: 'hit-kind', text: kindLabel(h.kind) }),
          el('span', { class: 'hit-where', text: `${h.turn ? `第 ${h.turn} 轮 · ` : ''}seq ${h.seq}` }),
        ]),
        el('div', { class: 'search-hit-text', text: h.snippet }),
      ]));
    }
  }
}

/** 从检索结果跳到某条会话的某个位置。 */
async function openAt(sessionId, seq) {
  state.focusSeq = seq;
  await selectSession(sessionId);
}

function focusTurn(seq) {
  const nodes = [...document.querySelectorAll('.turn')];
  const target = nodes.find((n) => Number(n.dataset.start) <= seq && seq <= Number(n.dataset.end)) ?? nodes[0];
  state.focusSeq = null;
  if (!target) return;
  target.classList.add('is-focus');
  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  setTimeout(() => target.classList.remove('is-focus'), 2600);
}

// ── 渲染：详情 ─────────────────────────────────────────
function renderDetail() {
  const pane = $('#detail');

  if (!state.current) {
    pane.replaceChildren(el('div', { class: 'empty' }, [
      el('div', { class: 'empty-title', text: '从左边的卷宗里挑一条' }),
      el('p', { text: '这里会显示它的每一轮对话。你可以导出、回溯，或者把它归档、删掉。' }),
    ]));
    return;
  }

  const s = state.current;
  const nodes = [];

  const facts = [
    el('span', {}, ['轮次 ', el('b', { text: String(s.turnCount) })]),
    el('span', {}, ['事件 ', el('b', { text: String(s.eventCount) })]),
    el('span', {}, ['大小 ', el('b', { text: fmtSize(s.size) })]),
    el('span', {}, ['创建 ', el('b', { text: fmtDate(s.createdAt) })]),
    el('span', {}, ['最后活动 ', el('b', { text: fmtDate(s.lastTime) })]),
    el('span', {}, [el('code', { text: s.id })]),
  ];

  const actions = [];
  actions.push(el('button', { class: 'btn btn-solid', onclick: () => doExport(), text: '导出' }));
  actions.push(el('button', { class: 'btn', onclick: () => doVerify(), text: '检查完整性' }));
  if (s.archived) {
    actions.push(el('button', { class: 'btn', onclick: () => doArchive(false), text: '取消归档' }));
  } else {
    actions.push(el('button', { class: 'btn', onclick: () => doArchive(true), text: '归档' }));
  }
  actions.push(el('button', { class: 'btn btn-danger', onclick: () => doDelete(), text: '彻底删除' }));

  nodes.push(el('div', { class: 'detail-head' }, [
    el('h1', { class: 'detail-title', text: s.title || `（无标题）${shortId(s.id)}` }),
    el('div', { class: 'detail-facts' }, facts),
    el('div', { class: 'detail-cwd', style: 'margin-top:8px;font-size:12.5px;color:var(--ink-2);word-break:break-all', text: s.cwd ?? '（无工作区）' }),
    el('div', { class: 'detail-actions' }, actions),
  ]));

  if (s.error) {
    nodes.push(el('div', { class: 'note note-bad', text: `读取这个会话时出错：${s.error}` }));
  }
  if (s.idSafe === false) {
    nodes.push(el('div', {
      class: 'note note-bad',
      text: '这条会话的 ID 不是安全标识。工具仍会把它列出来供你查看，但拒绝对它做任何改写、归档或删除——免得被构造过的 ID 把操作引到别的文件上。',
    }));
  }
  if (!s.formatOk) {
    nodes.push(el('div', { class: 'note', text: `这是旧格式（v${s.version}）的日志，本工具只处理当前格式，请勿在此改写。` }));
  }
  if (state.status?.dshRunning && !s.archived) {
    nodes.push(el('div', { class: 'note', text: 'DSH 正在运行。如果这条会话此刻正开在 dsh 里，请先关掉它再回溯，否则你的改动会被 dsh 覆盖。' }));
  }

  nodes.push(el('div', { class: 'section-label', text: `对话轮次 · ${state.turns.length}` }));
  const turnList = el('ul', { class: 'turn-list' });

  for (const t of state.turns) {
    turnList.append(el('li', { class: 'turn', 'data-start': String(t.startSeq), 'data-end': String(t.endSeq) }, [
      el('div', { class: 'turn-no' }, [el('div', { text: String(t.turn).padStart(2, '0') }), el('small', { text: '轮' })]),
      el('div', {}, [
        el('div', { class: 'turn-prompt', text: t.prompt || '（这一轮没有用户消息）' }),
        t.answer ? el('div', { class: 'turn-answer', text: t.answer }) : null,
        el('div', { class: 'turn-meta', text: `seq ${t.startSeq}–${t.endSeq} · ${t.eventCount} 事件 · ${t.toolCalls} 次工具调用 · ${fmtDate(t.time)}` }),
      ]),
      el('div', { class: 'turn-acts' }, [
        el('button', { class: 'btn btn-sm', text: '保留到此', title: '砍掉这一轮之后的所有内容', onclick: () => doTruncate(t) }),
        el('button', { class: 'btn btn-sm', text: '从此分叉', title: '复制出一份到这一轮为止的新会话，原会话不动', onclick: () => doFork(t) }),
      ]),
    ]));
  }
  nodes.push(turnList);

  pane.replaceChildren(...nodes);
}

// ── 数据加载 ───────────────────────────────────────────
async function loadStatus() {
  state.status = await api('/api/status');
  renderStatus();
}

async function loadSessions() {
  const data = await api('/api/sessions?filter=all&force=1');
  state.sessions = data.sessions;
  renderList();
}

async function selectSession(id) {
  state.currentId = id;
  state.current = state.sessions.find((s) => s.id === id) ?? null;
  renderList();
  if (!state.current) {
    state.turns = [];
    renderDetail();
    return;
  }
  $('#detail').replaceChildren(el('div', { class: 'empty' }, [el('p', { text: '正在读取轮次…' })]));
  try {
    const data = await api(`/api/sessions/${encodeURIComponent(id)}/turns`);
    state.current = data.session;
    state.turns = data.turns;
  } catch (err) {
    state.turns = [];
    toast('bad', '读取轮次失败', err.message);
  }
  renderDetail();
  if (state.focusSeq !== null) focusTurn(state.focusSeq);
}

// ── 动作 ───────────────────────────────────────────────
async function doExport() {
  const s = state.current;
  if (!s) return;
  const choice = await askExport(s);
  if (!choice) return;
  try {
    const r = await api(`/api/sessions/${encodeURIComponent(s.id)}/export`, { method: 'POST', body: choice });
    toast('ok', `已导出 ${r.eventCount} 个事件`, `${r.name} → ${r.dir}`);
  } catch (err) {
    toast('bad', '导出失败', err.message);
  }
}

/** 导出对话框：选范围、选粒度、选格式。 */
function askExport(session) {
  const turns = state.turns;
  const first = turns.length ? turns[0].turn : 1;
  const last = turns.length ? turns.at(-1).turn : 1;

  return new Promise((resolve) => {
    const modal = $('#modal');
    $('#modal-title').textContent = '导出这段对话';
    $('#force-row').hidden = true;

    const allCheck = el('input', { type: 'checkbox' });
    allCheck.checked = true;
    const fromInput = el('input', { class: 'num', type: 'number', min: '1', max: String(last), value: String(first) });
    const toInput = el('input', { class: 'num', type: 'number', min: '1', max: String(last), value: String(last) });
    const syncRange = () => {
      fromInput.disabled = allCheck.checked;
      toInput.disabled = allCheck.checked;
    };
    allCheck.addEventListener('change', syncRange);
    syncRange();

    const name = 'export-mode';
    const radio = (value, label, checked) => {
      const input = el('input', { type: 'radio', name, value });
      if (checked) input.checked = true;
      return el('label', { class: 'radio-row' }, [input, el('span', { text: label })]);
    };

    const formatSel = el('select', { class: 'select' }, [
      el('option', { value: 'md', text: 'Markdown（人可读，推荐）' }),
      el('option', { value: 'jsonl', text: 'JSONL（原始事件流，给程序用）' }),
    ]);

    $('#modal-body').replaceChildren(
      el('div', { class: 'field' }, [
        el('div', { class: 'field-label', text: '导出范围' }),
        el('label', { class: 'radio-row' }, [allCheck, el('span', { text: `全部轮次（共 ${turns.length} 轮）` })]),
        el('div', { class: 'range-row' }, [
          el('span', { text: '第' }), fromInput,
          el('span', { text: '轮到第' }), toInput, el('span', { text: '轮' }),
        ]),
      ]),
      el('div', { class: 'field' }, [
        el('div', { class: 'field-label', text: '导出内容' }),
        radio('chat', '纯交流记录 —— 只有你的提问和 DSH 回给你的正文', true),
        radio('full', '完整 —— 连工具调用和执行结果一起导出'),
        radio('handoff', '接手包 —— 给别的 agent 工具读，读完就能接着干这个项目'),
      ]),
      el('div', { class: 'field' }, [
        el('div', { class: 'field-label', text: '文件格式' }),
        formatSel,
        el('div', { class: 'field-hint', text: '接手包固定输出 Markdown。' }),
      ]),
    );

    $('#modal-ok').textContent = '导出';
    $('#modal-ok').className = 'btn btn-solid';

    const onClose = () => {
      modal.removeEventListener('close', onClose);
      if (modal.returnValue !== 'ok') return resolve(null);
      const mode = $('#modal-body').querySelector(`input[name="${name}"]:checked`)?.value ?? 'chat';
      let from;
      let to;
      if (!allCheck.checked) {
        const t1 = turns.find((t) => t.turn === Number(fromInput.value));
        const t2 = turns.find((t) => t.turn === Number(toInput.value));
        if (!t1 || !t2) {
          toast('bad', '轮次范围不对', `这条会话只有第 ${first} 到第 ${last} 轮`);
          return resolve(null);
        }
        from = t1.startSeq;
        to = t2.endSeq;
      }
      return resolve({ from, to, mode, format: mode === 'handoff' ? 'md' : formatSel.value });
    };
    modal.addEventListener('close', onClose);
    modal.showModal();
  });
}

/** 设置对话框：自定义导出目录。 */
async function askSettings() {
  const s = state.settings ?? await api('/api/settings');
  const input = el('input', { class: 'path-input', type: 'text', value: s.exportDir ?? '', placeholder: s.defaultExportDir });

  const modal = $('#modal');
  $('#modal-title').textContent = '设置';
  $('#force-row').hidden = true;
  $('#modal-body').replaceChildren(
    el('div', { class: 'field' }, [
      el('div', { class: 'field-label', text: '导出的 Markdown / JSONL 存到哪儿' }),
      input,
      el('div', { class: 'field-hint', text: `留空则用默认目录：${s.defaultExportDir}` }),
      el('div', { class: 'field-hint', text: '不能填 DSH 数据目录（.dsh）里面的位置，免得和会话数据、备份混在一起。' }),
    ]),
  );
  $('#modal-ok').textContent = '保存';
  $('#modal-ok').className = 'btn btn-solid';

  const ok = await new Promise((resolve) => {
    const onClose = () => {
      modal.removeEventListener('close', onClose);
      resolve(modal.returnValue === 'ok');
    };
    modal.addEventListener('close', onClose);
    modal.showModal();
  });
  if (!ok) return;

  try {
    const next = await api('/api/settings', { method: 'POST', body: { exportDir: input.value } });
    state.settings = next;
    await loadStatus();
    toast('ok', '已保存', `导出目录：${next.effectiveExportDir}`);
  } catch (err) {
    toast('bad', '保存失败', err.message);
  }
}

async function doVerify() {
  const s = state.current;
  if (!s) return;
  try {
    const r = await api(`/api/sessions/${encodeURIComponent(s.id)}/verify`);
    if (r.ok) toast('ok', '检查通过', `${r.frames} 帧 · ${r.events} 事件，格式与引用都正常`);
    else toast('bad', `发现 ${r.problems.length} 处问题`, r.problems.slice(0, 3).join('；'));
  } catch (err) {
    toast('bad', '检查失败', err.message);
  }
}

async function doTruncate(turn) {
  const s = state.current;
  if (!s) return;
  const droppedEvents = s.eventCount - (turn.endSeq + 1);
  const droppedTurns = state.turns.filter((t) => t.turn > turn.turn).length;
  if (droppedEvents <= 0) {
    toast('bad', '这一轮已经是最后一轮了', '没有可砍掉的内容');
    return;
  }
  const { ok, force } = await askConfirm({
    title: `保留到第 ${turn.turn} 轮`,
    okText: '确认截断',
    danger: true,
    forceRow: false,
    body: [
      el('p', { text: `会砍掉第 ${turn.turn} 轮之后的全部内容：${droppedTurns} 轮、${droppedEvents} 个事件。` }),
      el('ul', {}, [
        el('li', { text: `保留：seq 0 ~ ${turn.endSeq}（${turn.endSeq + 1} 个事件）` }),
        el('li', { text: `丢弃：seq ${turn.endSeq + 1} 起，共 ${droppedEvents} 个事件` }),
      ]),
      el('p', {}, ['被丢弃的部分会' , el('b', { text: '自动导出一份 Markdown' }), '到导出目录，原文件也会先整份备份，所以随时能翻回来。']),
      el('p', { text: '这一步直接改写原会话文件，DSH 里那条会话会变成到这里为止的样子。' }),
    ],
  });
  if (!ok) return;
  const attempt = (force) => api(`/api/sessions/${encodeURIComponent(s.id)}/truncate`, {
    method: 'POST',
    body: { at: turn.endSeq, exportTail: true, tools: true, force },
  });
  try {
    let r;
    try {
      r = await attempt(false);
    } catch (err) {
      if (!err.needsForce) throw err;
      const again = await askConfirm({
        title: 'DSH 正在运行',
        okText: '仍然截断',
        danger: true,
        forceRow: true,
        body: [
          el('p', { text: err.message }),
          el('p', { text: '如果这条会话此刻正开在 dsh 里，改动会被它覆盖，它甚至可能读到半截日志。最稳的做法是先切到别的会话，或直接关掉 dsh。' }),
        ],
      });
      if (!again.ok) return;
      r = await attempt(again.force);
    }
    toast('ok', `已截断：保留 ${r.kept} 个事件，丢弃 ${r.dropped} 个`, `备份 ${r.backup.split('\\').pop()}`);
    if (r.tailFile) toast('ok', '被截断的部分已导出', r.tailFile);
    await loadSessions();
    await selectSession(s.id);
  } catch (err) {
    toast('bad', '截断失败', err.message);
  }
}

async function doFork(turn) {
  const s = state.current;
  if (!s) return;
  const { ok, extra } = await askConfirm({
    title: `从第 ${turn.turn} 轮分叉`,
    okText: '创建副本',
    extraField: { label: '新会话标题（可留空）', placeholder: `例如：${(s.title || '这条会话').slice(0, 24)} · 回溯版` },
    body: [
      el('p', { text: `把 seq 0 ~ ${turn.endSeq} 的内容复制成一条新会话（${turn.endSeq + 1} 个事件）。` }),
      el('p', { text: '原会话一个字节都不会动，所以这是最保险的回溯方式——想扔掉后面那些内容，去那条新会话里继续聊就行。' }),
      el('p', { text: '新会话不会挤进任何工作区分组，它会出现在 DSH 侧边栏的「未分组」下面，照样能打开接着聊。' }),
    ],
  });
  if (!ok) return;
  try {
    const r = await api(`/api/sessions/${encodeURIComponent(s.id)}/fork`, {
      method: 'POST',
      body: { at: turn.endSeq, title: extra.trim() || undefined, register: false },
    });
    toast('ok', `已创建副本 ${shortId(r.newId)}`, `${r.eventCount} 个事件 · 去 DSH 的「未分组」里找它`);
    await loadSessions();
  } catch (err) {
    toast('bad', '分叉失败', err.message);
  }
}

async function doArchive(archived) {
  const s = state.current;
  if (!s) return;
  const attempt = async (force) => {
    await api(`/api/sessions/${encodeURIComponent(s.id)}/${archived ? 'archive' : 'unarchive'}`, {
      method: 'POST',
      body: { force },
    });
  };
  try {
    await attempt(false);
  } catch (err) {
    if (!err.needsForce) return toast('bad', '操作失败', err.message);
    const { ok, force } = await askConfirm({
      title: archived ? '归档这条会话' : '取消归档',
      okText: '强制执行',
      danger: true,
      forceRow: true,
      body: [el('p', { text: err.message })],
    });
    if (!ok) return;
    try {
      await attempt(force);
    } catch (e2) {
      return toast('bad', '操作失败', e2.message);
    }
  }
  toast('ok', archived ? '已归档（DSH 里不再显示）' : '已恢复到正常位置');
  await loadSessions();
  const still = state.sessions.find((x) => x.id === s.id);
  if (still) await selectSession(s.id);
}

async function doDelete() {
  const s = state.current;
  if (!s) return;
  const attempt = async (force) => api(`/api/sessions/${encodeURIComponent(s.id)}`, { method: 'DELETE', body: { force } });
  let firstError = null;
  const { ok } = await askConfirm({
    title: '彻底删除这条会话',
    okText: '删除',
    danger: true,
    forceRow: false,
    body: [
      el('p', {}, ['这不是归档，是', el('b', { text: '真的删掉' }), '。三处一起清空：']),
      el('ul', {}, [
        el('li', {}, ['日志目录 ', el('code', { text: s.dir })]),
        el('li', { text: '它的界面缓存' }),
        el('li', { text: '工作区分组与归档名单里的记录' }),
      ]),
      el('p', { text: '删除前会自动整份备份到 backups 目录，并且可以在「备份」里恢复。' }),
      el('p', {}, ['会话：', el('code', { text: s.id })]),
    ],
  });
  if (!ok) return;
  try {
    await attempt(false);
  } catch (err) {
    firstError = err;
    if (!err.needsForce) return toast('bad', '删除失败', err.message);
    const again = await askConfirm({
      title: 'DSH 正在运行',
      okText: '强制执行',
      danger: true,
      forceRow: true,
      body: [el('p', { text: err.message })],
    });
    if (!again.ok) return;
    try {
      await attempt(again.force);
    } catch (e2) {
      return toast('bad', '删除失败', e2.message);
    }
  }
  toast('ok', '已彻底删除', firstError ? '（强制执行）' : undefined);
  state.currentId = null;
  state.current = null;
  state.turns = [];
  await loadSessions();
  renderDetail();
}

async function revealExports() {
  try {
    await api('/api/reveal', { method: 'POST', body: { path: state.status?.exportDir } });
  } catch {
    toast('bad', '打不开目录', '请手动前往导出目录');
  }
}

// ── 事件绑定与启动 ─────────────────────────────────────
let searchTimer = null;

/** 跨会话全文检索（防抖触发）。 */
async function runSearch() {
  const q = state.query;
  if (q.length < 2) return;
  state.searchResult = { searching: true, query: q, total: 0, sessions: [] };
  renderList();
  try {
    const r = await api(`/api/search?q=${encodeURIComponent(q)}&mode=${state.searchScope}`);
    if (state.query !== q) return;   // 期间又改了输入，丢弃这次结果
    state.searchResult = r;
  } catch (err) {
    state.searchResult = { query: q, total: 0, sessions: [], note: `检索失败：${err.message}` };
  }
  renderList();
}

$('#q').addEventListener('input', (e) => {
  state.query = e.target.value.trim();
  clearTimeout(searchTimer);
  if (state.query.length >= 2) {
    searchTimer = setTimeout(runSearch, 420);
  } else {
    state.searchResult = null;
    renderList();
  }
});

$('#scope').addEventListener('change', (e) => {
  state.searchScope = e.target.checked ? 'all' : 'conversation';
  if (state.query.length >= 2) runSearch();
});

$('#tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  state.filter = tab.dataset.filter;
  $('#tabs').querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-on', t === tab));
  renderList();
});

$('#btn-refresh').addEventListener('click', async () => {
  try {
    await loadStatus();
    await loadSessions();
    if (state.currentId) await selectSession(state.currentId);
    toast('ok', '已刷新');
  } catch (err) {
    toast('bad', '刷新失败', err.message);
  }
});

$('#btn-exports').addEventListener('click', revealExports);
$('#btn-settings').addEventListener('click', askSettings);

(async function boot() {
  try {
    await loadStatus();
    state.settings = await api('/api/settings');
    await loadSessions();
  } catch (err) {
    toast('bad', '加载失败', err.message);
  }
  renderDetail();
})();
