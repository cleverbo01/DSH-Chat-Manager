#!/usr/bin/env node
/**
 * 历史对话管理 · 命令行版（界面之外的另一条入口）
 *
 *   node cli.mjs list [--all|--archived] [--here]
 *   node cli.mjs show   --id <id|前缀> | -n <序号> | --last
 *   node cli.mjs export --last [--from t2 --to t3] [--jsonl] [--no-tools]
 *   node cli.mjs keep   --last --at t3 --yes     保留到第 3 轮，砍掉其后
 *   node cli.mjs fork   --last --at t2 --yes [--title "标题"] [--register]
 *   node cli.mjs archive|unarchive --id <id>
 *   node cli.mjs delete --id <id> --yes
 *   node cli.mjs verify --id <id>
 *   node cli.mjs backups | restore --from <备份名> [--with-registry]
 */

import {
  scanSessions, findSession, getTurns, exportSession, truncateSession, forkSession,
  setArchived, deleteSession, listBackups, restoreBackup, validateSession,
  isPortListening, checkHome, SafetyError, EXPORT_DIR, DSH_HOME, searchAll,
} from './lib/store.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'list';
const has = (f) => argv.includes(`--${f}`);
const opt = (f, dflt) => {
  const i = argv.indexOf(`--${f}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};

const die = (msg) => {
  console.error(`错误：${msg}`);
  process.exit(1);
};

const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '—');
const fmtSize = (b) => (!b ? '—' : b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(2)} MB`);

function pick() {
  const all = scanSessions({ force: true });
  let pool = all;
  if (has('here')) {
    const cwd = process.cwd().toLowerCase();
    pool = pool.filter((s) => (s.cwd ?? '').toLowerCase() === cwd);
  }
  const id = opt('id');
  if (id) {
    const hit = pool.find((s) => s.id === id) ?? pool.find((s) => s.id.includes(id));
    if (!hit) die(`找不到匹配 --id ${id} 的会话`);
    return hit;
  }
  const visible = has('archived') ? pool.filter((s) => s.archived)
    : has('all') ? pool : pool.filter((s) => !s.archived);
  const n = opt('n');
  if (n) {
    const hit = visible[Number(n) - 1];
    if (!hit) die(`序号 ${n} 超出范围（共 ${visible.length} 条）`);
    return hit;
  }
  if (has('last')) {
    if (!visible.length) die('没有可选会话');
    return visible[0];
  }
  die('请指定会话：--last / --id <id|前缀> / -n <序号>');
}

/** 把 --at 的 t<轮次> 或纯数字解析成 seq（取该轮的结束点）。 */
function resolveAt(session, spec) {
  const { turns, lastSeq } = getTurns(session);
  if (spec === undefined || spec === null) return lastSeq;
  const turnMatch = /^t(?:urn)?(\d+)$/.exec(spec);
  if (turnMatch) {
    const t = turns.find((x) => x.turn === Number(turnMatch[1]));
    if (!t) die(`没有第 ${turnMatch[1]} 轮（共 ${turns.length} 轮）`);
    return t.endSeq;
  }
  const n = Number(spec);
  if (!Number.isFinite(n)) die(`无法解析位置 "${spec}"，用法：<seq> 或 t<轮次>`);
  return n;
}

async function guard(label) {
  if (has('force')) return;
  if (await isPortListening()) {
    die(`DSH 正在运行：${label}要改注册表，请先关掉 dsh，或加 --force 强制（不保证生效）`);
  }
}

// 先确认数据目录没配错，再动手
if (!['help', '--help', '-h'].includes(cmd)) {
  try {
    const home = checkHome({ allowUnusual: process.env.ALLOW_UNUSUAL_DSH_HOME === '1' });
    if (home.unusual) {
      console.warn(`警告：${DSH_HOME} 看起来不是 DSH 数据目录（已由 ALLOW_UNUSUAL_DSH_HOME 放行）`);
    }
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }
}

switch (cmd) {
  case 'list': case 'ls': {
    const all = scanSessions({ force: true });
    const pool = has('archived') ? all.filter((s) => s.archived)
      : has('all') ? all : all.filter((s) => !s.archived);
    pool.forEach((s, i) => {
      const tags = [];
      if (s.archived) tags.push('已归档');
      if (!s.registered && !s.archived) tags.push('未分组');
      if (s.error) tags.push('读取异常');
      console.log(`${String(i + 1).padStart(3)}  ${s.id}${tags.length ? `  [${tags.join(' · ')}]` : ''}`);
      console.log(`     ${fmtDate(s.lastTime ?? s.createdAt)}　${s.turnCount} 轮 / ${s.eventCount} 事件　${fmtSize(s.size)}`);
      console.log(`     ${s.cwd ?? '(无工作区)'}`);
      console.log(`     ${s.title || '(无标题)'}`);
    });
    console.log(`\n共 ${pool.length} 条。`);
    break;
  }

  case 'show': {
    const s = pick();
    const { turns, totalEvents } = getTurns(s);
    console.log(`${s.title || '(无标题)'}　${s.id}`);
    console.log(`${s.cwd ?? '(无工作区)'}　创建 ${fmtDate(s.createdAt)}`);
    console.log(`事件 ${totalEvents}　轮次 ${turns.length}　${fmtSize(s.size)}`);
    console.log('');
    for (const t of turns) {
      console.log(`第 ${String(t.turn).padStart(2)} 轮  seq ${String(t.startSeq).padStart(5)}–${String(t.endSeq).padStart(5)}  ${String(t.eventCount).padStart(4)} 事件  ${t.prompt.replace(/\s+/g, ' ').slice(0, 56)}`);
    }
    console.log('\n回溯：keep 保留到某轮结束，fork 从某轮结束分叉。');
    break;
  }

  case 'export': {
    const s = pick();
    const { turns } = getTurns(s);
    const at = (spec) => {
      if (spec === undefined) return undefined;
      const m = /^t(?:urn)?(\d+)$/.exec(spec);
      if (m) {
        const t = turns.find((x) => x.turn === Number(m[1]));
        if (!t) die(`没有第 ${m[1]} 轮`);
        return t;
      }
      const n = Number(spec);
      if (!Number.isFinite(n)) die(`无法解析 "${spec}"`);
      return { startSeq: n, endSeq: n };
    };
    const from = at(opt('from'));
    const to = at(opt('to'));
    const mode = has('handoff') ? 'handoff' : has('full') ? 'full' : 'chat';
    const r = exportSession(s, {
      from: from?.startSeq, to: to?.endSeq, mode,
      reasoning: has('reasoning'),
      format: has('jsonl') ? 'jsonl' : 'md',
    });
    console.log(`已导出 ${r.eventCount} 个事件（${mode}）-> ${r.path}`);
    break;
  }

  case 'search': {
    const q = opt('q') ?? argv[1] ?? '';
    if (!q || q.startsWith('--')) die('用法：search --q <关键词> [--all] [--archived only|exclude|include]');
    const r = searchAll(q, {
      mode: has('all') ? 'all' : 'conversation',
      archived: opt('archived') ?? 'include',
    });
    if (r.note) {
      console.log(r.note);
      break;
    }
    const label = (k) => (k === 'user' ? '你' : k === 'assistant' ? 'DSH' : k === 'tool' ? '工具' : '系统');
    console.log(`找到 ${r.total} 处，落在 ${r.sessions.length} 个会话（${r.elapsedMs}ms）`);
    for (const s of r.sessions) {
      console.log('');
      console.log(`── ${s.title || s.id}　[${s.cwd ?? '无工作区'}]${s.archived ? '（已归档）' : ''}`);
      for (const h of s.hits) {
        const where = h.turn ? `第${h.turn}轮 seq${h.seq}` : `seq${h.seq}`;
        console.log(`   ${where}　${label(h.kind)}：${h.snippet}`);
      }
    }
    break;
  }

  case 'keep': {
    const s = pick();
    const at = resolveAt(s, opt('at'));
    if (!has('yes')) {
      const { lastSeq } = getTurns(s);
      console.log(`会话 ${s.id}（${s.title ?? '无标题'}）`);
      console.log(`保留 seq 0 ~ ${at}，丢弃 seq ${at + 1} ~ ${lastSeq}`);
      console.log('\n这是预览，确认执行请加 --yes（会自动备份并导出被丢弃的部分）。');
      break;
    }
    await guard('截断会话日志');
    const r = truncateSession(s, { at, exportTail: true, tools: !has('no-tools') });
    console.log(`已截断：保留 ${r.kept} 个事件，丢弃 ${r.dropped} 个`);
    console.log(`备份 ${r.backup}`);
    if (r.tailFile) console.log(`被丢弃部分已导出 ${r.tailFile}`);
    break;
  }

  case 'fork': {
    const s = pick();
    const at = resolveAt(s, opt('at'));
    if (has('register')) await guard('注册新会话');
    if (!has('yes')) {
      console.log(`将把 seq 0 ~ ${at} 复制成一条新会话，原会话不动。`);
      console.log('\n这是预览，确认执行请加 --yes。');
      break;
    }
    const r = forkSession(s, { at, title: opt('title'), register: has('register') });
    console.log(`已创建 ${r.newId}（${r.eventCount} 个事件）`);
    console.log(r.target);
    break;
  }

  case 'archive': case 'unarchive': {
    const s = pick();
    await guard(cmd === 'archive' ? '归档' : '取消归档');
    const r = setArchived(s, cmd === 'archive');
    console.log(`${r.archived ? '已归档' : '已取消归档'}：${s.id}（归档名单现有 ${r.count} 条）`);
    break;
  }

  case 'delete': case 'rm': {
    const s = pick();
    console.log(`会话：${s.id}（${s.title ?? '无标题'}）`);
    console.log(`日志目录：${s.dir}`);
    if (!has('yes')) {
      console.log('\n这是预览，确认执行请加 --yes（会先自动备份）。');
      break;
    }
    await guard('删除会话');
    const r = deleteSession(s);
    console.log(`已彻底删除，删除前备份：${r.backup}`);
    break;
  }

  case 'verify': {
    const s = pick();
    const r = validateSession(s);
    console.log(`${s.id}　${r.frames} 帧　${r.events} 事件`);
    console.log(r.ok ? '通过：帧结构、头字段、seq 连续性、seq 引用全部合法。'
      : `发现 ${r.problems.length} 处问题：\n  - ` + r.problems.slice(0, 20).join('\n  - '));
    if (!r.ok) process.exitCode = 1;
    break;
  }

  case 'backups': {
    const items = listBackups();
    if (!items.length) {
      console.log('还没有备份。');
      break;
    }
    items.forEach((b, i) => {
      console.log(`${String(i + 1).padStart(3)}  ${b.name}`);
      console.log(`     ${b.manifest?.reason ?? '未知操作'}　原 ${b.manifest?.eventCount ?? '?'} 事件　${fmtSize(b.size)}`);
      console.log(`     ${b.manifest?.title ?? ''}`);
    });
    console.log(`\n恢复：node cli.mjs restore --from <名称>`);
    break;
  }

  case 'restore': {
    const name = opt('from') ?? argv[1];
    if (!name) die('用法：restore --from <备份名>');
    if (!has('yes')) {
      console.log(`将把备份 ${name} 恢复到原位置。确认请加 --yes。`);
      break;
    }
    const r = restoreBackup(name, { withRegistry: has('with-registry') });
    console.log(`已恢复会话 ${r.sessionId} -> ${r.logPath}`);
    break;
  }

  case 'help': case '--help': case '-h':
    console.log(`历史对话管理 · 命令行

  list [--all|--archived] [--here]     列出会话
  search --q <关键词> [--all]          跨会话检索（--all 连工具记录一起搜）
  show   <会话>                        轮次大纲（含 seq 区间）
  export <会话> [--from t2 --to t3]    导出：默认纯交流；--full 含工具；--handoff 接手包
  keep   <会话> --at t3 --yes          保留到第 3 轮，砍掉其后
  fork   <会话> --at t2 --yes          复制出到第 2 轮为止的新会话
  archive | unarchive <会话>           归档 / 恢复到正常位置
  delete <会话> --yes                  彻底删除（含缓存与注册记录）
  verify <会话>                        完整性检查
  backups | restore --from <名称>      备份列表 / 恢复

会话选择：--last / --id <id|前缀> / -n <序号>
导出目录：${EXPORT_DIR}
`);
    break;

  default:
    die(`未知命令 ${cmd}，用 help 查看用法`);
}
