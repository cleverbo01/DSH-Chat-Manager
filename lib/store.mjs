/**
 * DSH 会话存储读写核心。
 *
 * 只做两件「动历史」的事，且都只保留连续前缀，因此不需要重排 seq、也不需要
 * 修任何引用（前缀内的引用天然指向更早的事件）：
 *   - truncate：就地砍掉某点之后的内容
 *   - fork：把某点之前的内容复制成一个新会话，原会话一个字节不动
 *
 * 日志写入契约（读自 @deepseek-ai/dsh-session-persistence-jsonl）：
 *   1. 文件是多帧 zstd 拼接；第 1 帧解压后必须恰好一行 header + 换行；
 *      其后每帧解压后是若干行 JSONL 事件 + 结尾换行。
 *   2. Node 的 zstdDecompressSync 只解第一帧，多帧必须走 CLI 或按魔数切帧。
 *   3. 头字段有白名单，超出的字段会被判为「不是 session 头」。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, copyFileSync, renameSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, basename, resolve, sep, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import * as zlib from 'node:zlib';
import net from 'node:net';

// 用命名空间方式取 zstd：低版本 Node 上这两个函数不存在，
// 这样能给出清楚的中文提示，而不是抛一个看不懂的链接期错误。
const { zstdCompressSync, zstdDecompressSync } = zlib;
if (typeof zstdCompressSync !== 'function' || typeof zstdDecompressSync !== 'function') {
  throw new Error(
    `本工具依赖 Node.js 内置的 Zstandard 支持，需要 Node.js 22.15 或更高版本（当前 ${process.version}）。\n`
    + '请升级 Node.js 后重试：https://nodejs.org/',
  );
}

export const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');
export const SESSIONS_ROOT = join(DSH_HOME, 'sessions');
export const STORAGES = join(DSH_HOME, 'storages');
export const WORKSPACE_FILE = join(STORAGES, 'workspace.json');
export const PROJCACHE_DIR = join(STORAGES, 'session_projcache', 'sessions');
export const BACKUP_DIR = join(DSH_HOME, 'backups');
// 项目根目录（路径含中文，必须用 fileURLToPath 解码，不能直接用 URL.pathname）
export const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const EXPORT_DIR = join(PROJECT_ROOT, 'data', 'exports');
export const FORMAT_VERSION = 3;
export const DSH_WEB_PORT = 3080;

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

// ───────────────────────── 安全围栏 ─────────────────────────
/**
 * 这个工具只该动 DSH 数据目录里的「对话」相关内容。所有会写、会删的路径
 * 都必须先过下面三道检查，否则宁可拒绝执行也不冒险。
 */
export class SafetyError extends Error {}

/** 目标路径必须严格位于 base 之内（不允许等于 base 本身）。 */
export function assertInside(base, target, what = '路径') {
  const b = resolve(base);
  const t = resolve(target);
  if (t === b) throw new SafetyError(`${what}指向受保护的根目录本身，已拒绝：${t}`);
  if (!t.startsWith(b + sep)) throw new SafetyError(`${what}位于预期目录之外，已拒绝：${t}（应在 ${b} 之内）`);
  return t;
}

/** 会话 id 只接受自己认识的安全标识：不含分隔符、不含 ..、不以点开头。 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,198}$/;
export function isSafeId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id) && !id.includes('..');
}

export function assertSessionId(id) {
  if (!isSafeId(id)) throw new SafetyError(`会话 id 不是安全标识，已拒绝操作：${JSON.stringify(id)}`);
  return id;
}

/**
 * 会话的日志与目录必须落在 sessions 根目录下、且层次正好是
 * sessions/<项目>/<会话>/，否则拒绝。
 */
export function assertSessionLocation(session) {
  assertSessionId(session.id);
  const log = assertInside(SESSIONS_ROOT, session.logPath, '会话日志');
  const dir = assertInside(SESSIONS_ROOT, session.dir, '会话目录');
  const baseDepth = resolve(SESSIONS_ROOT).split(sep).length;
  if (resolve(dir).split(sep).length !== baseDepth + 2) {
    throw new SafetyError(`会话目录层次异常，已拒绝：${dir}（应为 sessions/项目/会话）`);
  }
  if (dirname(log) !== dir) throw new SafetyError(`会话日志不在它自己的目录里，已拒绝：${log}`);
  // DSH 用 encodeSegment(id) 作为会话目录名；对不上说明文件被搬动过，不碰
  if (basename(dir) !== encodeSegment(session.id)) {
    throw new SafetyError(`会话目录名与 id 不匹配，已拒绝：目录 ${basename(dir)}，id ${session.id}`);
  }
  return { log, dir };
}

/** 备份目录里的任何名字都必须留在备份目录内。 */
export function assertBackupName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 200) {
    throw new SafetyError(`备份名不合法：${JSON.stringify(name)}`);
  }
  if (name.includes('..') || name.includes('/') || name.includes('\\')) {
    throw new SafetyError(`备份名含路径分隔符，已拒绝：${name}`);
  }
  return name;
}

/**
 * 启动期确认：DSH_HOME 看起来确实是 DSH 的数据目录。
 * 环境变量配错时，这是唯一能拦住「在无关目录里乱删」的机会。
 */
export function checkHome({ allowUnusual = false } = {}) {
  const markers = [
    'sessions',
    'storages',
    join('storages', 'workspace.json'),
    join('storages', 'session_projcache'),
  ];
  const present = markers.filter((m) => existsSync(join(DSH_HOME, m)));
  if (present.length === 0) {
    if (allowUnusual) return { ok: true, marker: null, unusual: true };
    throw new SafetyError(
      `DSH_HOME 指向的目录不像 DSH 数据目录：${DSH_HOME}\n`
      + `（里面既没有 sessions 也没有 storages）。\n`
      + '这通常说明环境变量配错了。为防止误删无关文件，已停止运行。\n'
      + '确认无误可设置环境变量 ALLOW_UNUSUAL_DSH_HOME=1 跳过这项检查。',
    );
  }
  return { ok: true, marker: present[0], unusual: false };
}

// ───────────────────────── 路径编码（复刻官方 projectKey / encodeSegment） ─────────────────────────
export function projectKey(cwd) {
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i += 1) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

export function encodeSegment(raw) {
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
}

// ───────────────────────── zstd 多帧编解码 ─────────────────────────
export function frameOffsets(buf) {
  const cuts = [];
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf.compare(ZSTD_MAGIC, 0, 4, i, i + 4) === 0) cuts.push(i);
  }
  return cuts;
}

function decompressAll(buf) {
  try {
    return execFileSync('zstd', ['-d', '-c', '--no-progress'], { input: buf, maxBuffer: 1 << 30 }).toString('utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT') throw new Error(`zstd 解压失败：${err.message}`);
  }
  const cuts = frameOffsets(buf);
  if (cuts.length === 0) throw new Error('不是 zstd 数据');
  let out = '';
  for (let i = 0; i < cuts.length; i += 1) {
    const end = i + 1 < cuts.length ? cuts[i + 1] : buf.length;
    try {
      out += zstdDecompressSync(buf.subarray(cuts[i], end)).toString('utf8');
    } catch {
      // 尾部半帧（写入中断）跳过
    }
  }
  return out;
}

/** 读取日志：header 行与事件行都保持原始文本，取舍只在「行」这一级发生。 */
export function readLog(logPath) {
  const text = logPath.endsWith('.zstd') ? decompressAll(readFileSync(logPath)) : readFileSync(logPath, 'utf8');
  const lines = text.split('\n');
  const headerLine = lines.shift() ?? '';
  while (lines.length && lines.at(-1) === '') lines.pop();
  const header = headerLine ? JSON.parse(headerLine) : null;
  const events = [];
  for (const line of lines) {
    if (!line) continue;
    events.push({ line, obj: JSON.parse(line) });
  }
  return { headerLine, header, events };
}

/** 生成合法日志：帧1 = header 行，帧2 = 全部事件行。 */
export function encodeLog(headerLine, eventLines) {
  const frames = [zstdCompressSync(Buffer.from(headerLine + '\n', 'utf8'), { level: 3 })];
  if (eventLines.length > 0) {
    frames.push(zstdCompressSync(Buffer.from(eventLines.join('\n') + '\n', 'utf8'), { level: 3 }));
  }
  return Buffer.concat(frames);
}

export function writeAtomic(target, content) {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, content);
  try {
    renameSync(tmp, target);
  } catch {
    // 覆盖失败时把原文件挪到 .prev 而不是直接删掉，避免出现「两头都没有」的瞬间
    const prev = `${target}.prev`;
    rmSync(prev, { force: true });
    if (existsSync(target)) renameSync(target, prev);
    renameSync(tmp, target);
  }
}

/** 毫秒级时间戳：同一秒内连续做两次操作也不会撞名。 */
function timeStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
}

/** 目录里已存在同名条目时自动加序号，绝不覆盖已有的备份或导出。 */
function uniquePath(base, stem, ext = '') {
  let n = 0;
  let candidate = join(base, `${stem}${ext}`);
  while (existsSync(candidate)) {
    n += 1;
    candidate = join(base, `${stem}-${n}${ext}`);
  }
  return candidate;
}

// ───────────────────────── 会话索引 ─────────────────────────
function loadWorkspace() {
  return existsSync(WORKSPACE_FILE) ? JSON.parse(readFileSync(WORKSPACE_FILE, 'utf8')) : null;
}

function readProjection(id) {
  const cache = join(PROJCACHE_DIR, `${id}.json`);
  if (!existsSync(cache)) return null;
  try {
    return JSON.parse(readFileSync(cache, 'utf8'));
  } catch {
    return null;
  }
}

let cacheStamp = 0;
let cacheValue = null;

/** 扫描全部会话。带 1.5s 记忆，避免界面刷新时反复解压大文件。 */
export function scanSessions({ force = false } = {}) {
  if (!force && cacheValue && Date.now() - cacheStamp < 1500) return cacheValue;
  const ws = loadWorkspace();
  const archived = new Set(ws?.global?.archivedSessionIds ?? []);
  const order = new Map();
  const owner = new Map();
  let seqNo = 0;
  for (const [workspaceId, record] of Object.entries(ws?.tables?.workspaces ?? {})) {
    for (const id of record.sessionIds ?? []) {
      order.set(id, seqNo++);
      owner.set(id, { workspaceId, workspacePath: record.path, workspaceTitle: record.title });
    }
  }

  const found = [];
  if (existsSync(SESSIONS_ROOT)) {
    for (const bucket of readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
      if (!bucket.isDirectory()) continue;
      const bucketPath = join(SESSIONS_ROOT, bucket.name);
      for (const dir of readdirSync(bucketPath, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        const dirPath = join(bucketPath, dir.name);
        const files = readdirSync(dirPath).filter((n) => /^session\.v\d+\.jsonl(\.zstd)?$/.test(n));
        if (!files.length) continue;
        const file = files.sort((a, b) => Number(/^session\.v(\d+)\./.exec(a)[1]) - Number(/^session\.v(\d+)\./.exec(b)[1])).at(-1);
        const logPath = join(dirPath, file);
        const version = Number(/^session\.v(\d+)\./.exec(file)?.[1] ?? 0);
        let header = null;
        let eventCount = 0;
        let turnCount = 0;
        let lastTime = null;
        let error = null;
        try {
          const { header: h, events } = readLog(logPath);
          header = h;
          eventCount = events.length;
          turnCount = events.filter((e) => e.obj.type === 'turn/start').length;
          lastTime = events.at(-1)?.obj.time ?? null;
        } catch (err) {
          error = err.message;
        }
        const id = header?.id ?? dir.name;
        const proj = readProjection(id);
        found.push({
          id,
          dir: dirPath,
          logPath,
          version,
          projectKey: bucket.name,
          cwd: header?.cwd ?? null,
          createdAt: header?.createdAt ?? null,
          lastTime,
          isSeeded: header?.isSeeded ?? false,
          eventCount,
          turnCount,
          size: statSync(logPath).size,
          title: proj?.record?.rows?.title?.val ?? null,
          archived: archived.has(id),
          registered: order.has(id),
          workspacePath: owner.get(id)?.workspacePath ?? null,
          workspaceTitle: owner.get(id)?.workspaceTitle ?? null,
          error,
          formatOk: version === FORMAT_VERSION,
          // id 不是安全标识的会话仍会列出来供查看，但所有写操作都会被拒绝
          idSafe: isSafeId(id),
        });
      }
    }
  }
  found.sort((a, b) => (b.lastTime ?? b.createdAt ?? 0) - (a.lastTime ?? a.createdAt ?? 0));
  cacheValue = found;
  cacheStamp = Date.now();
  return found;
}

export function findSession(idOrPrefix) {
  const all = scanSessions({ force: true });
  return all.find((s) => s.id === idOrPrefix) ?? all.find((s) => s.id.includes(idOrPrefix)) ?? null;
}

// ───────────────────────── 轮次大纲 ─────────────────────────
const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c && typeof c.text === 'string').map((c) => c.text).join('\n');
};

export function getTurns(session) {
  const { events } = readLog(session.logPath);
  const marks = events.filter((e) => e.obj.type === 'turn/start');
  const turns = marks.map((mark, i) => {
    const startIdx = events.indexOf(mark);
    const nextMark = marks[i + 1];
    const endIdx = nextMark ? events.indexOf(nextMark) : events.length;
    const slice = events.slice(startIdx, endIdx);
    const firstUser = slice.find((e) => e.obj.type === 'user/message');
    const lastAssistant = [...slice].reverse().find((e) => e.obj.type === 'assistant/message');
    const answer = lastAssistant
      ? (lastAssistant.obj.data?.message?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
      : '';
    return {
      turn: mark.obj.data?.turn ?? i + 1,
      startSeq: mark.obj.seq,
      endSeq: slice.at(-1).obj.seq,
      eventCount: slice.length,
      time: mark.obj.time ?? null,
      prompt: firstUser ? textOf(firstUser.obj.data?.content).trim() : '',
      answer: answer.trim(),
      toolCalls: slice.filter((e) => e.obj.type === 'tool/call').length,
    };
  });
  return { turns, totalEvents: events.length, lastSeq: events.at(-1)?.obj.seq ?? -1 };
}

// ───────────────────────── Markdown 导出 ─────────────────────────
export function renderMarkdown(session, events, opts = {}) {
  const out = [];
  out.push(`# ${opts.title ?? session.title ?? session.id}`);
  out.push('');
  out.push(`- 会话 ID: \`${session.id}\``);
  if (session.cwd) out.push(`- 工作区: \`${session.cwd}\``);
  if (session.createdAt) out.push(`- 创建时间: ${new Date(session.createdAt).toLocaleString('zh-CN')}`);
  out.push(`- 事件数: ${events.length}　轮次: ${events.filter((e) => e.obj.type === 'turn/start').length}`);
  if (opts.range) out.push(`- 范围: seq ${opts.range.from} ~ ${opts.range.to}`);
  if (opts.note) out.push(`- 说明: ${opts.note}`);
  out.push('');

  for (const { obj: ev } of events) {
    const d = ev.data ?? {};
    if (ev.type === 'user/message') {
      const body = textOf(d.content).trim();
      if (body) out.push(`## 用户 <sub>seq ${ev.seq}</sub>`, '', body, '');
    } else if (ev.type === 'assistant/message') {
      const content = d.message?.content ?? [];
      const think = content.filter((c) => c.type === 'reasoning').map((c) => c.text).join('\n').trim();
      const answer = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
      if (opts.reasoning && think) out.push('<details><summary>思考过程</summary>', '', think, '', '</details>', '');
      if (answer) out.push(`## 助手 <sub>seq ${ev.seq}</sub>`, '', answer, '');
    } else if (ev.type === 'tool/call' && opts.tools) {
      out.push(`<details><summary>工具调用 ${d.name} <sub>seq ${ev.seq}</sub></summary>`, '', '```json', String(d.arguments ?? '').slice(0, 20000), '```', '', '</details>', '');
    } else if (ev.type === 'tool/result' && opts.tools) {
      out.push('```', textOf(d.message?.content).slice(0, 8000), '```', '');
    }
  }
  return out.join('\n');
}

/**
 * 导出会话。
 * mode = 'full'    完整：含工具调用与结果
 *        'chat'    纯交流：只有你的输入和 DSH 给你看的正文
 *        'handoff' 接手包：给别的 agent 工具读的交接文档
 */
export function exportSession(session, { from, to, mode = 'chat', format = 'md', reasoning = false } = {}) {
  const { events } = readLog(session.logPath);
  const picked = events.filter((e) => (from === undefined || e.obj.seq >= from) && (to === undefined || e.obj.seq <= to));
  if (picked.length === 0) throw new Error('选定范围内没有任何内容');

  const dir = resolveExportDir();
  mkdirSync(dir, { recursive: true });
  const suffix = from !== undefined || to !== undefined ? `-seq${from ?? 0}_${to ?? 'end'}` : '';
  const tag = mode === 'handoff' ? '-接手包' : mode === 'full' ? '-完整' : '-纯交流';
  const ext = format === 'jsonl' && mode !== 'handoff' ? '.jsonl' : '.md';
  const target = uniquePath(dir, `${safeName(session.title ?? session.id)}${suffix}${tag}-${timeStamp()}`, ext);

  let content;
  if (ext === '.jsonl') {
    content = picked.map((e) => e.line).join('\n') + '\n';
  } else if (mode === 'handoff') {
    content = buildHandoff(session, picked);
  } else {
    content = renderMarkdown(session, picked, {
      tools: mode === 'full',
      reasoning,
      range: from !== undefined || to !== undefined ? { from: from ?? 0, to: to ?? 'end' } : undefined,
    });
  }
  writeFileSync(target, content, 'utf8');
  return {
    path: target, name: basename(target), dir,
    eventCount: picked.length, mode, bytes: Buffer.byteLength(content, 'utf8'),
  };
}

function safeName(raw) {
  return String(raw).replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'session';
}

// ───────────────────────── 设置（导出目录可自定义） ─────────────────────────
const BQ = '`';
const SETTINGS_FILE = join(PROJECT_ROOT, 'data', 'settings.json');

export function loadSettings() {
  const base = { exportDir: null };
  if (!existsSync(SETTINGS_FILE)) return base;
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'));
    return { ...base, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  } catch {
    return base;
  }
}

/** 导出目录校验：必须是文件夹（或可创建的位置），且不能落在 DSH 数据目录里。 */
export function assertExportDir(dir) {
  if (typeof dir !== 'string' || dir.trim() === '') throw new SafetyError('导出目录不能为空');
  const abs = resolve(dir.trim());
  if (/[*?]/.test(abs)) throw new SafetyError('导出目录不能包含通配符');
  const dsh = resolve(DSH_HOME);
  if (abs === dsh || abs.startsWith(dsh + sep)) {
    throw new SafetyError(`导出目录不能放在 DSH 数据目录里（${dsh}），免得和会话数据、备份混在一起`);
  }
  if (existsSync(abs) && !statSync(abs).isDirectory()) {
    throw new SafetyError(`这个路径已经存在，但它不是文件夹：${abs}`);
  }
  return abs;
}

export function saveSettings(patch) {
  const next = { ...loadSettings(), ...(patch ?? {}) };
  if (next.exportDir) next.exportDir = assertExportDir(next.exportDir);
  writeAtomic(SETTINGS_FILE, JSON.stringify(next, null, 2));
  return next;
}

/** 当前生效的导出目录；设置坏了就退回默认，不让导出整个失效。 */
export function resolveExportDir() {
  const { exportDir } = loadSettings();
  if (!exportDir) return EXPORT_DIR;
  try {
    return assertExportDir(exportDir);
  } catch {
    return EXPORT_DIR;
  }
}

// ───────────────────────── 跨会话检索 ─────────────────────────
/** 只解压出行文本、不解析 JSON —— 搜索时避免对上千行做无谓的 parse。 */
export function readRawLines(logPath) {
  const text = logPath.endsWith('.zstd') ? decompressAll(readFileSync(logPath)) : readFileSync(logPath, 'utf8');
  return text.split('\n').filter(Boolean);
}

/** 一个事件里「人能读到的文字」。 */
export function readableTextOf(ev) {
  const d = ev.data ?? {};
  switch (ev.type) {
    case 'user/message': return textOf(d.content);
    case 'assistant/message': return (d.message?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    case 'system/message': return textOf(d.message?.content ?? d.message);
    case 'tool/call': return `${d.name ?? ''} ${d.arguments ?? ''}`;
    case 'tool/result': return textOf(d.message?.content);
    default: return '';
  }
}

function kindOf(ev) {
  if (ev.type === 'user/message') return 'user';
  if (ev.type === 'assistant/message') return 'assistant';
  if (ev.type === 'tool/call' || ev.type === 'tool/result') return 'tool';
  return 'other';
}

function snippetAround(text, at, len, pad = 60) {
  const start = Math.max(0, at - pad);
  const end = Math.min(text.length, at + len + pad);
  return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '');
}

/**
 * 跨会话全文检索。
 * mode: 'conversation' 只搜交流内容 | 'all' 连工具调用与结果一起搜
 * archived: 'exclude' | 'include' | 'only'
 */
export function searchAll(query, opts = {}) {
  const q = String(query ?? '').trim();
  if (q.length < 2) return { query: q, total: 0, sessions: [], note: '关键词至少 2 个字符' };
  const needle = q.toLowerCase();
  const includeTools = opts.mode === 'all';
  const perSession = opts.perSession ?? 20;
  const maxTotal = opts.limit ?? 300;
  const archived = opts.archived ?? 'include';
  const started = Date.now();

  const result = [];
  let total = 0;
  for (const s of scanSessions({ force: true })) {
    if (archived === 'exclude' && s.archived) continue;
    if (archived === 'only' && !s.archived) continue;
    if (s.error) continue;

    let lines;
    try {
      lines = readRawLines(s.logPath);
    } catch {
      continue;
    }

    const hits = [];
    for (let i = 1; i < lines.length && hits.length < perSession; i += 1) {
      const line = lines[i];
      // 先做便宜的字符串过滤，只对命中的行做 JSON 解析
      if (!line.toLowerCase().includes(needle)) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      const kind = kindOf(ev);
      if (!includeTools && kind !== 'user' && kind !== 'assistant') continue;
      const text = readableTextOf(ev);
      const at = text.toLowerCase().indexOf(needle);
      if (at < 0) continue;
      hits.push({
        seq: ev.seq, turn: ev.data?.turn ?? null, time: ev.time ?? null, kind,
        snippet: snippetAround(text, at, needle.length),
      });
    }

    if (hits.length > 0) {
      result.push({
        sessionId: s.id, title: s.title, cwd: s.cwd, archived: s.archived,
        lastTime: s.lastTime ?? s.createdAt, hits,
      });
      total += hits.length;
      if (total >= maxTotal) break;
    }
  }

  result.sort((a, b) => (b.lastTime ?? 0) - (a.lastTime ?? 0));
  return {
    query: q, total, sessions: result, elapsedMs: Date.now() - started,
    mode: includeTools ? 'all' : 'conversation', truncated: total >= maxTotal,
  };
}

// ───────────────────────── 接手包 ─────────────────────────
// 只认盘符开头的绝对路径；两边用非空白/引号/括号的字符收口
const WINDOWS_PATH = /[A-Za-z]:\\[^\s"',;)\]}<>|*?]*/g;

/** 从工具调用参数里挑出这段对话真正碰过的文件与目录。 */
export function extractPaths(events, limit = 40) {
  const counter = new Map();
  for (const { obj } of events) {
    if (obj.type !== 'tool/call') continue;
    const args = String(obj.data?.arguments ?? '');
    for (const m of args.matchAll(WINDOWS_PATH)) {
      const p = m[0].trim();
      if (p.length < 4) continue;
      counter.set(p, (counter.get(p) ?? 0) + 1);
    }
  }
  return [...counter.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([path, count]) => ({ path, count }));
}

/**
 * 生成「接手包」：另一个 agent 工具读完就能知道项目现状、接着干。
 * 内容 = 项目坐标 + 每轮做了什么 + 碰过哪些文件 + 完整交流记录。
 */
export function buildHandoff(session, events) {
  const turns = [];
  let current = null;
  for (const { obj: ev } of events) {
    if (ev.type === 'turn/start') {
      current = { turn: ev.data?.turn ?? turns.length + 1, time: ev.time, asks: [], answers: [], tools: new Map() };
      turns.push(current);
      continue;
    }
    if (!current) continue;
    if (ev.type === 'user/message') {
      const body = textOf(ev.data?.content).trim();
      if (body) current.asks.push(body);
    } else if (ev.type === 'assistant/message') {
      const content = ev.data?.message?.content ?? [];
      const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
      if (text) current.answers.push(text);
    } else if (ev.type === 'tool/call') {
      const name = ev.data?.name ?? 'tool';
      current.tools.set(name, (current.tools.get(name) ?? 0) + 1);
    }
  }

  const paths = extractPaths(events);
  const out = [];
  out.push(`# 交接说明：${session.title || session.id}`);
  out.push('');
  out.push('> 这份文件由「历史对话管理」生成，用来把下面这段工作交给另一个 agent 工具接手。');
  out.push('> 读完它就能了解项目现状并接着干活，不必再解析原始会话日志。');
  out.push('');
  out.push('## 项目坐标');
  out.push('');
  if (session.cwd) out.push(`- 项目目录：${BQ}${session.cwd}${BQ}`);
  out.push(`- 会话 ID：${BQ}${session.id}${BQ}`);
  if (session.createdAt) out.push(`- 对话开始：${new Date(session.createdAt).toLocaleString('zh-CN')}`);
  if (session.lastTime) out.push(`- 最后活动：${new Date(session.lastTime).toLocaleString('zh-CN')}`);
  out.push(`- 轮次：${turns.length}　导出事件：${events.length}`);
  out.push('');

  const firstAsk = turns.find((t) => t.asks.length > 0);
  if (firstAsk) {
    out.push('## 这个项目在做什么');
    out.push('');
    out.push(firstAsk.asks[0].slice(0, 600));
    out.push('');
  }

  const lastAnswer = [...turns].reverse().find((t) => t.answers.length > 0);
  if (lastAnswer) {
    out.push('## 最近一次结论');
    out.push('');
    out.push(lastAnswer.answers.at(-1).slice(0, 1200));
    out.push('');
  }

  out.push('## 每一轮都做了什么');
  out.push('');
  for (const t of turns) {
    const ask = t.asks.join(' / ').replace(/\s+/g, ' ').trim();
    const answer = t.answers.join(' ').replace(/\s+/g, ' ').trim();
    const toolNames = [...t.tools.entries()].map(([n, c]) => (c > 1 ? `${n}×${c}` : n)).join('、');
    out.push(`### 第 ${t.turn} 轮`);
    out.push('');
    if (ask) out.push(`- 用户要求：${ask.slice(0, 300)}`);
    if (toolNames) out.push(`- 调用工具：${toolNames}`);
    if (answer) out.push(`- 结论：${answer.slice(0, 400)}`);
    out.push('');
  }

  if (paths.length > 0) {
    out.push('## 这段对话碰过的文件与目录');
    out.push('');
    out.push('（按被操作次数排序，取自工具调用的参数）');
    out.push('');
    for (const { path, count } of paths) {
      out.push(`- ${BQ}${path}${BQ}${count > 1 ? `（${count} 次）` : ''}`);
    }
    out.push('');
  }

  out.push('## 完整交流记录');
  out.push('');
  const chat = renderMarkdown(session, events, { tools: false });
  out.push(chat.split('\n').slice(4).join('\n').trim());
  out.push('');
  out.push('---');
  out.push('');
  out.push('接手建议：先确认「碰过的文件」是否还在，读一遍最近一轮的结论，然后接着做没做完的部分。');
  out.push('');
  return out.join('\n');
}

// ───────────────────────── 备份 ─────────────────────────
/**
 * 递归复制一棵目录树。返回**没能备份的条目**清单（空数组表示完整）。
 * 调用方必须检查这个清单：备份不完整就不该继续做破坏性操作。
 */
function copyTree(src, dst, failures = []) {
  if (!existsSync(src)) return failures;
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dst, entry.name);
    try {
      if (entry.isDirectory()) copyTree(from, to, failures);
      else if (entry.isFile()) copyFileSync(from, to);
      // 符号链接 / junction 不跟随复制：记下来，让调用方决定是否还要继续
      else failures.push(`${from}（不是普通文件，未复制）`);
    } catch (err) {
      failures.push(`${from}（${err instanceof Error ? err.message : String(err)}）`);
    }
  }
  return failures;
}

/** 给一棵目录树算出带校验和的清单，写进 manifest 供日后核对。 */
function fileManifest(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile()) {
        files.push({ rel: relative(root, full), size: null, sha256: null, unusual: true });
        continue;
      }
      const buf = readFileSync(full);
      files.push({ rel: relative(root, full), size: buf.length, sha256: createHash('sha256').update(buf).digest('hex') });
    }
  };
  if (existsSync(root)) walk(root);
  return files;
}

/**
 * 删除前核对备份是否真的完整。
 * 只要有一项对不上，就宁可拒绝删除也不冒「删掉了却恢复不回来」的风险。
 */
export function assertBackupComplete(backupDir) {
  const mf = join(backupDir, 'manifest.json');
  if (!existsSync(mf)) throw new SafetyError(`备份里没有 manifest.json，拒绝删除：${backupDir}`);
  const manifest = JSON.parse(readFileSync(mf, 'utf8'));
  if (manifest.complete !== true) throw new SafetyError('备份没有被标记为完整，拒绝删除');
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new SafetyError('备份清单为空（可能什么都没复制到），拒绝删除');
  }
  const tree = join(backupDir, 'session-dir');
  for (const f of manifest.files) {
    const p = join(tree, f.rel);
    if (!existsSync(p)) throw new SafetyError(`备份里缺少 ${f.rel}，拒绝删除`);
    if (f.sha256) {
      const got = createHash('sha256').update(readFileSync(p)).digest('hex');
      if (got !== f.sha256) throw new SafetyError(`备份文件的校验和对不上：${f.rel}，拒绝删除`);
    }
  }
  return manifest;
}

export function backUp(session, reason) {
  const id = assertSessionId(session.id);
  const { log, dir: sessionDir } = assertSessionLocation(session);
  const dir = assertInside(
    BACKUP_DIR,
    uniquePath(BACKUP_DIR, `${timeStamp()}-${encodeSegment(id)}`),
    '备份目录',
  );
  mkdirSync(dir, { recursive: true });
  copyFileSync(log, join(dir, 'session.log.bak'));
  // 整个会话目录一起留档：DSH 将来可能在会话目录里放别的东西，删之前都得留住
  const failures = copyTree(sessionDir, join(dir, 'session-dir'));
  if (failures.length > 0) {
    throw new SafetyError(
      `会话目录里有 ${failures.length} 项没能备份，操作已中止（不在备份不完整的情况下改动数据）：\n  - `
      + failures.slice(0, 5).join('\n  - '),
    );
  }
  const files = fileManifest(join(dir, 'session-dir'));
  const cache = join(PROJCACHE_DIR, `${id}.json`);
  if (existsSync(cache)) copyFileSync(cache, join(dir, 'projcache.json.bak'));
  if (existsSync(WORKSPACE_FILE)) copyFileSync(WORKSPACE_FILE, join(dir, 'workspace.json.bak'));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    sessionId: id, title: session.title, cwd: session.cwd, reason,
    at: new Date().toISOString(), logPath: log, eventCount: session.eventCount,
    complete: true, files,
  }, null, 2), 'utf8');
  return dir;
}

export function listBackups() {
  if (!existsSync(BACKUP_DIR)) return [];
  return readdirSync(BACKUP_DIR).sort().reverse().map((name) => {
    const dir = join(BACKUP_DIR, name);
    let manifest = null;
    try {
      manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    } catch { /* 无清单也能列出 */ }
    let size = 0;
    try {
      size = statSync(join(dir, 'session.log.bak')).size;
    } catch { /* 备份可能不完整 */ }
    return { name, dir, manifest, size };
  });
}

export function restoreBackup(name, { withRegistry = false } = {}) {
  const safeName = assertBackupName(name);
  const dir = assertInside(BACKUP_DIR, join(BACKUP_DIR, safeName), '备份目录');
  if (!existsSync(dir)) throw new Error(`备份不存在：${name}`);
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error('该备份缺少 manifest.json，无法确定恢复位置');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  // manifest 只是磁盘上的一个普通文件，可能被改坏或篡改。
  // 恢复目标必须重新过一遍围栏，绝不能因为清单里写了什么就写到哪儿。
  const id = assertSessionId(manifest.sessionId);
  const logPath = assertInside(SESSIONS_ROOT, manifest.logPath, '恢复目标日志');
  if (!/\.jsonl(\.zstd)?$/.test(logPath)) {
    throw new SafetyError(`恢复目标不是会话日志文件，已拒绝：${logPath}`);
  }
  const logDir = dirname(logPath);
  const baseDepth = resolve(SESSIONS_ROOT).split(sep).length;
  if (resolve(logDir).split(sep).length !== baseDepth + 2) {
    throw new SafetyError(`恢复目标的目录层次异常，已拒绝：${logDir}（应为 sessions/项目/会话）`);
  }
  // 恢复目标所在的目录必须正好是这条会话自己的目录
  if (basename(logDir) !== encodeSegment(id)) {
    throw new SafetyError(`恢复目标的目录与 sessionId 对不上，已拒绝：${logDir}（应为 ${encodeSegment(id)}）`);
  }
  const src = join(dir, 'session.log.bak');
  if (!existsSync(src)) throw new Error('备份里没有 session.log.bak，无法恢复');

  mkdirSync(logDir, { recursive: true });
  // 覆盖前先给当前文件留一份；同名时自动加序号，不覆盖更早的那份
  if (existsSync(logPath)) copyFileSync(logPath, uniquePath(logDir, `${basename(logPath)}.before-restore`));
  copyFileSync(src, logPath);

  const cacheBackup = join(dir, 'projcache.json.bak');
  if (existsSync(cacheBackup)) {
    mkdirSync(PROJCACHE_DIR, { recursive: true });
    copyFileSync(cacheBackup, assertInside(PROJCACHE_DIR, join(PROJCACHE_DIR, `${id}.json`), '投影缓存'));
  }
  if (withRegistry && existsSync(join(dir, 'workspace.json.bak'))) {
    // 名单是全局共用的，覆盖它之前同样先留一份当前副本
    if (existsSync(WORKSPACE_FILE)) copyFileSync(WORKSPACE_FILE, uniquePath(STORAGES, `${basename(WORKSPACE_FILE)}.before-restore`));
    copyFileSync(join(dir, 'workspace.json.bak'), WORKSPACE_FILE);
  }
  cacheValue = null;
  return { sessionId: id, logPath };
}

// ───────────────────────── 契约自检 ─────────────────────────
export function validateSession(session) {
  const problems = [];
  const raw = readFileSync(session.logPath);
  const cuts = session.logPath.endsWith('.zstd') ? frameOffsets(raw) : [];
  if (session.logPath.endsWith('.zstd')) {
    if (cuts.length === 0) problems.push('文件里没有 zstd 帧');
    else {
      if (cuts[0] !== 0) problems.push(`文件起始不是帧边界（前导垃圾 ${cuts[0]} 字节）`);
      const first = zstdDecompressSync(raw.subarray(cuts[0], cuts[1] ?? raw.length)).toString('utf8');
      if (first.length === 0 || first.indexOf('\n') !== first.length - 1) {
        problems.push('第一帧不是恰好一行 header（必须独占首帧且以换行结尾）');
      }
    }
  }

  const { header, events } = readLog(session.logPath);
  if (!header) problems.push('缺少 session 头事件');
  else {
    if (header.type !== 'session') problems.push('首行不是 session 头事件');
    if (header.version !== FORMAT_VERSION) problems.push(`头 version=${header.version}（期望 ${FORMAT_VERSION}）`);
    if (header.id !== session.id) problems.push(`头 id=${header.id} 与目录会话 id=${session.id} 不一致`);
    const allowed = new Set(['type', 'version', 'id', 'createdAt', 'cwd', 'isSeeded', 'delegationDepth', 'agentPreset', 'parentSession', 'origin']);
    const extra = Object.keys(header).filter((k) => !allowed.has(k));
    if (extra.length) problems.push(`头里有白名单外字段：${extra.join(', ')}`);
    if (header.cwd !== undefined && projectKey(header.cwd) !== session.projectKey) {
      problems.push(`头 cwd 编码为 ${projectKey(header.cwd)}，与所在目录 ${session.projectKey} 不一致`);
    }
  }
  events.forEach((e, i) => {
    const ev = e.obj;
    if (ev.seq !== i) problems.push(`seq 不连续：位置 ${i} 上 seq=${ev.seq}`);
    if (Array.isArray(ev.sourceEventSeqs)) {
      const src = [];
      for (const entry of ev.sourceEventSeqs) {
        if (Array.isArray(entry) && entry.length === 2) for (let s = entry[0]; s <= entry[1]; s += 1) src.push(s);
        else if (typeof entry === 'number') src.push(entry);
      }
      if (src.length === 0) problems.push(`seq ${ev.seq}: sourceEventSeqs 为空（要求非空）`);
      if (new Set(src).size !== src.length) problems.push(`seq ${ev.seq}: sourceEventSeqs 存在重复引用`);
      for (const s of src) if (s >= ev.seq) problems.push(`seq ${ev.seq}: sourceEventSeqs 引用 ${s} 不小于自身 seq`);
    }
    const op = ev.surfaceOp;
    if (op !== undefined && typeof op === 'object' && op !== null) {
      if (op.op !== 'replace') problems.push(`seq ${ev.seq}: surfaceOp.op 非法（${op.op}）`);
      if (Object.keys(op).length !== 3) problems.push(`seq ${ev.seq}: surfaceOp 必须恰好 op/startSeq/endSeq 三个键`);
      if (typeof op.startSeq !== 'number' || typeof op.endSeq !== 'number') problems.push(`seq ${ev.seq}: surfaceOp 端点缺失`);
      else if (op.endSeq >= ev.seq) problems.push(`seq ${ev.seq}: surfaceOp 端点 ${op.endSeq} 不小于自身 seq`);
    }
  });
  return { ok: problems.length === 0, problems, frames: cuts.length, events: events.length };
}

// ───────────────────────── 回溯：截断 / 分叉 ─────────────────────────
/**
 * 就地截断：只保留 seq <= at 的事件。
 * 保留的是连续前缀，seq 与所有引用都天然保持合法，无需任何重排。
 */
export function truncateSession(session, { at, exportTail = true, tools = true, reasoning = false } = {}) {
  // 先确认这条会话确实在 sessions 根目录里，再动它
  assertSessionLocation(session);
  const { headerLine, events } = readLog(session.logPath);
  if (at === undefined || at === null) throw new Error('缺少截断位置');
  if (at < 0) throw new Error('截断位置不能为负');
  if (at >= events.at(-1)?.obj.seq) throw new Error('截断位置已在会话末尾，无需截断');
  const kept = events.filter((e) => e.obj.seq <= at);
  const dropped = events.filter((e) => e.obj.seq > at);
  if (kept.length === 0) throw new Error('截断后不剩任何事件，已取消');

  const backup = backUp(session, `truncate@${at}`);
  let tailFile = null;
  if (exportTail && dropped.length) {
    mkdirSync(EXPORT_DIR, { recursive: true });
    tailFile = uniquePath(
      EXPORT_DIR,
      `${safeName(session.title ?? session.id)}-被截断部分-seq${at + 1}_${events.at(-1).obj.seq}-${timeStamp()}`,
      '.md',
    );
    writeFileSync(tailFile, renderMarkdown(session, dropped, {
      tools, reasoning, title: `${session.title ?? session.id}（被截断的部分）`,
      range: { from: at + 1, to: events.at(-1).obj.seq }, note: `由截断操作自动导出，原会话已保留 seq 0~${at}`,
    }), 'utf8');
  }

  writeAtomic(session.logPath, encodeLog(headerLine, kept.map((e) => e.line)));
  const after = validateSession({ ...session });
  if (!after.ok) {
    copyFileSync(join(backup, 'session.log.bak'), session.logPath);
    throw new Error(`写回后自检失败，已回滚：${after.problems.slice(0, 3).join('；')}`);
  }

  const cache = join(PROJCACHE_DIR, `${session.id}.json`);
  if (existsSync(cache)) rmSync(cache, { force: true });
  cacheValue = null;
  return { kept: kept.length, dropped: dropped.length, backup, tailFile, at };
}

/**
 * 分叉：把 seq <= at 的事件复制成一个新会话，原会话完全不动。
 * 新会话 seq 仍是 0..at 连续，无需重排。
 */
export function forkSession(session, { at, title, register = false } = {}) {
  assertSessionLocation(session);
  const { header, events } = readLog(session.logPath);
  if (at !== undefined && (typeof at !== 'number' || at < 0)) throw new Error('分叉位置非法');
  const kept = events.filter((e) => at === undefined || e.obj.seq <= at);
  if (kept.length === 0) throw new Error('该位置之前没有任何事件，无法分叉');

  const newId = `session-${randomUUID()}`;
  const dir = assertInside(SESSIONS_ROOT, join(SESSIONS_ROOT, session.projectKey, encodeSegment(newId)), '新会话目录');
  const target = assertInside(SESSIONS_ROOT, join(dir, `session.v${FORMAT_VERSION}.jsonl.zstd`), '新会话日志');
  if (existsSync(target)) throw new Error('目标已存在，请重试');

  const inherited = kept.some((e) => e.obj.type === 'session/end-seed' && e.obj.data?.inherited === true);
  const newHeader = { ...header, id: newId, createdAt: Date.now(), isSeeded: inherited };
  delete newHeader.inheritedEventCount;
  delete newHeader.origin;

  writeAtomic(target, encodeLog(JSON.stringify(newHeader), kept.map((e) => e.line)));
  const check = validateSession({ ...session, id: newId, logPath: target, projectKey: session.projectKey });
  if (!check.ok) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`新会话自检失败，已撤销：${check.problems.slice(0, 3).join('；')}`);
  }

  if (title) writeProjectionTitle(newId, newHeader, kept.at(-1)?.obj.seq ?? -1, title);
  if (register) attachToWorkspace(newId, session);

  cacheValue = null;
  return { newId, target, eventCount: kept.length, at: at ?? kept.at(-1)?.obj.seq ?? -1, title: title ?? null };
}

function writeProjectionTitle(id, header, lastSeq, title) {
  assertSessionId(id);
  const record = {
    version: 7,
    record: {
      identity: {
        formatVersion: FORMAT_VERSION,
        createdAt: header.createdAt,
        isSeeded: header.isSeeded === true,
        ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
      },
      rows: { title: { ver: 1, seq: lastSeq, val: title } },
    },
  };
  writeAtomic(join(PROJCACHE_DIR, `${id}.json`), JSON.stringify(record, null, 2));
}

function attachToWorkspace(id, session) {
  const ws = loadWorkspace();
  if (!ws) throw new Error('找不到 workspace.json，无法注册');
  const wsId = session.workspaceId ?? Object.keys(ws.tables.workspaces)[0];
  const record = ws.tables.workspaces[wsId];
  if (!record) throw new Error('找不到目标工作区');
  record.sessionIds.unshift(id);
  record.updatedAt = new Date().toISOString();
  writeAtomic(WORKSPACE_FILE, JSON.stringify(ws, null, 2));
  cacheValue = null;
}

// ───────────────────────── 归档 / 取消归档 ─────────────────────────
export function setArchived(session, archived) {
  const id = assertSessionId(session.id);
  const ws = loadWorkspace();
  if (!ws) throw new Error('找不到 workspace.json');
  const list = ws.global.archivedSessionIds ?? [];
  const idx = list.indexOf(id);
  if (archived && idx < 0) list.push(id);
  if (!archived && idx >= 0) list.splice(idx, 1);
  ws.global.archivedSessionIds = list;
  writeAtomic(WORKSPACE_FILE, JSON.stringify(ws, null, 2));
  cacheValue = null;
  return { archived, count: list.length };
}

// ───────────────────────── 彻底删除 ─────────────────────────
export function deleteSession(session) {
  // 删除是唯一不可逆的动作，先把身份与位置都验一遍
  const id = assertSessionId(session.id);
  const { dir: safeDir } = assertSessionLocation(session);
  const ws = loadWorkspace();
  const inWorkspace = ws
    ? Object.values(ws.tables.workspaces).some((r) => r.sessionIds.includes(id))
    : false;
  const inArchive = (ws?.global?.archivedSessionIds ?? []).includes(id);
  const backup = backUp(session, 'delete');
  // 删除不可逆：先确认那份备份真的完整，再动手
  assertBackupComplete(backup);

  rmSync(safeDir, { recursive: true, force: true });
  if (existsSync(PROJCACHE_DIR)) {
    for (const name of readdirSync(PROJCACHE_DIR)) {
      // 只删属于这条会话的缓存：精确名、以及它自己的 .bak 残留
      if (name !== `${id}.json` && !name.startsWith(`${id}.json.bak.`)) continue;
      rmSync(assertInside(PROJCACHE_DIR, join(PROJCACHE_DIR, name), '投影缓存'), { force: true });
    }
  }
  if (ws) {
    let changed = false;
    for (const record of Object.values(ws.tables.workspaces)) {
      const before = record.sessionIds.length;
      record.sessionIds = record.sessionIds.filter((sid) => sid !== id);
      if (record.sessionIds.length !== before) {
        record.updatedAt = new Date().toISOString();
        changed = true;
      }
    }
    const archived = (ws.global.archivedSessionIds ?? []).filter((sid) => sid !== id);
    if (archived.length !== (ws.global.archivedSessionIds ?? []).length) changed = true;
    ws.global.archivedSessionIds = archived;
    if (changed) writeAtomic(WORKSPACE_FILE, JSON.stringify(ws, null, 2));
  }
  cacheValue = null;
  return { backup, removedWorkspaceRef: inWorkspace, removedArchiveRef: inArchive };
}

// ───────────────────────── DSH 运行状态 ─────────────────────────
export function isPortListening(port = DSH_WEB_PORT) {
  // 注意：这里不用 resolve 作形参名，否则会遮住从 node:path 导入的 resolve
  return new Promise((finish) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const settle = (result) => {
      sock.destroy();
      finish(result);
    };
    sock.setTimeout(600);
    sock.once('connect', () => settle(true));
    sock.once('error', () => settle(false));
    sock.once('timeout', () => settle(false));
  });
}

export { basename };
