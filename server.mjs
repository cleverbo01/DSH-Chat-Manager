#!/usr/bin/env node
/**
 * 历史对话管理 · 本地服务
 *
 * 只监听 127.0.0.1，不对外暴露。界面通过 REST 调用 lib/store.mjs。
 * 涉及 workspace.json 的操作（归档/取消归档/删除/注册）在 DSH 运行期间会被
 * 拒绝，因为那份名单由运行中的 DSH 进程在内存里持有，外部改动会被覆盖。
 */

import http from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname, resolve, sep } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import {
  PROJECT_ROOT, EXPORT_DIR, BACKUP_DIR, DSH_HOME, DSH_WEB_PORT,
  scanSessions, findSession, getTurns, exportSession, truncateSession, forkSession,
  setArchived, deleteSession, listBackups, restoreBackup, validateSession,
  isPortListening, checkHome, searchAll, loadSettings, saveSettings, resolveExportDir,
} from './lib/store.mjs';

const PUBLIC_DIR = join(PROJECT_ROOT, 'public');
const PREFERRED_PORT = Number(process.env.HISTORY_PORT ?? 3939);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendText(res, code, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const target = resolve(PUBLIC_DIR, rel);
  if (!target.startsWith(resolve(PUBLIC_DIR) + sep)) {
    return sendText(res, 403, '禁止访问');
  }
  if (!existsSync(target)) return sendText(res, 404, '找不到文件');
  const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(readFileSync(target));
}

/**
 * 需要 DSH 停下才能可靠完成的操作：改 workspace.json 名单、撰写活动会话日志。
 * DSH 运行时它手里握着那份名单和可能的写入句柄，外部改动会被覆盖。
 */
async function guardDshRunning(body, action) {
  if (body?.force === true) return null;
  if (await isPortListening(DSH_WEB_PORT)) {
    return `DSH 正在运行（端口 ${DSH_WEB_PORT}）。${action}需要它先停下来：`
      + '归档与工作区名单是 DSH 在内存里持有的，写入会话日志也可能被它覆盖。'
      + '请先关掉 dsh 再操作，或勾选「我知道风险，强制执行」。';
  }
  return null;
}

function revealPath(target) {
  return new Promise((resolveDone) => {
    let abs;
    try {
      abs = resolve(target);
    } catch {
      return resolveDone(false);
    }
    // 只允许打开导出目录与备份目录：DSH_HOME 根目录下有凭证、设置、附件，
    // 这个工具只负责对话管理，不该把它变成那些目录的入口
    const allowed = [resolve(resolveExportDir()), resolve(BACKUP_DIR), resolve(PROJECT_ROOT, 'data')];
    if (!allowed.some((base) => abs === base || abs.startsWith(base + sep))) return resolveDone(false);
    if (!existsSync(abs)) return resolveDone(false);
    execFile('explorer', [abs], () => resolveDone(true));
    return undefined;
  });
}

async function handleApi(req, res, url) {
  const seg = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const rest = seg.slice(1);
  const method = req.method ?? 'GET';
  const wantsForce = () => readBody(req).catch(() => ({}));

  // GET /api/status
  if (rest[0] === 'status' && method === 'GET') {
    const running = await isPortListening(DSH_WEB_PORT);
    const all = scanSessions();
    return sendJson(res, 200, {
      dshRunning: running,
      dshPort: DSH_WEB_PORT,
      dshHome: DSH_HOME,
      exportDir: resolveExportDir(),
      defaultExportDir: EXPORT_DIR,
      sessions: all.length,
      archived: all.filter((s) => s.archived).length,
      backupCount: listBackups().length,
      zstdCli: hasZstdCli(),
    });
  }

  // GET /api/search —— 跨会话全文检索
  if (rest[0] === 'search' && method === 'GET') {
    const result = searchAll(url.searchParams.get('q') ?? '', {
      mode: url.searchParams.get('mode') === 'all' ? 'all' : 'conversation',
      archived: url.searchParams.get('archived') ?? 'include',
      limit: Number(url.searchParams.get('limit')) || undefined,
    });
    return sendJson(res, 200, result);
  }

  // GET / POST /api/settings —— 导出目录可自定义
  if (rest[0] === 'settings') {
    if (method === 'GET') {
      return sendJson(res, 200, {
        ...loadSettings(),
        defaultExportDir: EXPORT_DIR,
        effectiveExportDir: resolveExportDir(),
      });
    }
    if (method === 'POST') {
      const body = await readBody(req);
      try {
        const raw = typeof body.exportDir === 'string' ? body.exportDir.trim() : '';
        const next = saveSettings({ exportDir: raw === '' ? null : raw });
        return sendJson(res, 200, { ...next, effectiveExportDir: resolveExportDir() });
      } catch (err) {
        return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  // GET /api/sessions
  if (rest[0] === 'sessions' && rest.length === 1 && method === 'GET') {
    const filter = url.searchParams.get('filter') ?? 'active';
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    let list = scanSessions({ force: url.searchParams.get('force') === '1' });
    if (filter === 'archived') list = list.filter((s) => s.archived);
    else if (filter === 'active') list = list.filter((s) => !s.archived);
    if (q) {
      list = list.filter((s) => [s.title, s.cwd, s.id]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)));
    }
    return sendJson(res, 200, { sessions: list, total: list.length });
  }

  // 以下都需要具体会话
  const id = rest[1];
  if (rest[0] !== 'sessions' || !id) return sendJson(res, 404, { error: '未知接口' });
  const session = findSession(id);
  if (!session) return sendJson(res, 404, { error: `找不到会话 ${id}` });

  // GET /api/sessions/:id/turns
  if (rest[2] === 'turns' && method === 'GET') {
    const data = getTurns(session);
    return sendJson(res, 200, { session, ...data });
  }

  // GET /api/sessions/:id/verify
  if (rest[2] === 'verify' && method === 'GET') {
    return sendJson(res, 200, validateSession(session));
  }

  // POST /api/sessions/:id/export
  if (rest[2] === 'export' && method === 'POST') {
    const body = await readBody(req);
    const result = exportSession(session, {
      from: toNum(body.from), to: toNum(body.to),
      mode: ['full', 'chat', 'handoff'].includes(body.mode) ? body.mode : 'chat',
      format: body.format === 'jsonl' ? 'jsonl' : 'md',
      reasoning: body.reasoning === true,
    });
    return sendJson(res, 200, result);
  }

  // POST /api/sessions/:id/truncate
  if (rest[2] === 'truncate' && method === 'POST') {
    const body = await readBody(req);
    // 这是唯一会就地改写原会话日志的操作，DSH 运行时必须让用户确认一次
    const blocked = await guardDshRunning(body, '原地截断会话日志');
    if (blocked) return sendJson(res, 409, { error: blocked, needsForce: true });
    const result = truncateSession(session, {
      at: toNum(body.at), exportTail: body.exportTail !== false,
      tools: body.tools !== false, reasoning: body.reasoning === true,
    });
    return sendJson(res, 200, result);
  }

  // POST /api/sessions/:id/fork
  if (rest[2] === 'fork' && method === 'POST') {
    const body = await readBody(req);
    if (body.register === true) {
      const blocked = await guardDshRunning(body, '把新会话注册进工作区');
      if (blocked) return sendJson(res, 409, { error: blocked, needsForce: true });
    }
    const result = forkSession(session, {
      at: toNum(body.at), title: typeof body.title === 'string' ? body.title.trim() || undefined : undefined,
      register: body.register === true,
    });
    return sendJson(res, 200, result);
  }

  // POST /api/sessions/:id/archive | unarchive
  if ((rest[2] === 'archive' || rest[2] === 'unarchive') && method === 'POST') {
    const body = await readBody(req);
    const blocked = await guardDshRunning(body, rest[2] === 'archive' ? '归档会话' : '取消归档');
    if (blocked) return sendJson(res, 409, { error: blocked, needsForce: true });
    const result = setArchived(session, rest[2] === 'archive');
    return sendJson(res, 200, result);
  }

  // DELETE /api/sessions/:id
  if (rest.length === 2 && method === 'DELETE') {
    const body = await readBody(req);
    const blocked = await guardDshRunning(body, '彻底删除会话');
    if (blocked) return sendJson(res, 409, { error: blocked, needsForce: true });
    const result = deleteSession(session);
    return sendJson(res, 200, result);
  }

  return sendJson(res, 404, { error: '未知接口' });
}

let zstdAvailable = null;
/** 只在首次调用时探测一次，避免每次请求都起进程。 */
function hasZstdCli() {
  if (zstdAvailable === null) {
    try {
      execFileSync('zstd', ['--version'], { stdio: 'ignore' });
      zstdAvailable = true;
    } catch {
      zstdAvailable = false;
    }
  }
  return zstdAvailable;
}

function toNum(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

async function handleBackups(req, res, url, body) {
  const method = req.method ?? 'GET';
  const seg = url.pathname.split('/').filter(Boolean);
  if (method === 'GET') return sendJson(res, 200, { backups: listBackups() });
  if (method === 'POST' && seg[2] === 'restore') {
    if (!body?.name) return sendJson(res, 400, { error: '缺少备份名称' });
    if (body.withRegistry === true) {
      const blocked = await guardDshRunning(body, '恢复工作区名单');
      if (blocked) return sendJson(res, 409, { error: blocked, needsForce: true });
    }
    const result = restoreBackup(body.name, { withRegistry: body.withRegistry === true });
    return sendJson(res, 200, result);
  }
  return sendJson(res, 404, { error: '未知接口' });
}

/**
 * 只接受来自本机的请求。
 * 没有这道检查时，一个恶意网页可以把域名解析到 127.0.0.1（DNS rebinding）
 * 然后从浏览器里读走你全部会话内容。
 */
function hostOf(headerValue) {
  if (!headerValue) return '';
  const value = headerValue.trim();
  if (value.startsWith('[')) return value.slice(1, value.indexOf(']')).toLowerCase();
  return value.split(':')[0].toLowerCase();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PREFERRED_PORT}`);
  try {
    const host = hostOf(req.headers.host);
    if (host && host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
      return sendText(res, 403, '只接受本机访问');
    }
    if (url.pathname.startsWith('/api/backups')) {
      const body = req.method === 'POST' ? await readBody(req) : {};
      return await handleBackups(req, res, url, body);
    }
    if (url.pathname === '/api/reveal' && req.method === 'POST') {
      const body = await readBody(req);
      const ok = await revealPath(body.path ?? EXPORT_DIR);
      return sendJson(res, ok ? 200 : 403, { ok });
    }
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(res, url.pathname);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return sendJson(res, 500, { error: message });
  }
});

function listen(port, attempt = 0) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 8) {
      listen(port + 1, attempt + 1);
      return;
    }
    console.error(`启动失败：${err.message}`);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    mkdirSync(EXPORT_DIR, { recursive: true });
    const url = `http://127.0.0.1:${port}`;
    console.log('');
    console.log('  历史对话管理已启动');
    console.log(`  界面地址：${url}`);
    console.log(`  数据目录：${DSH_HOME}`);
    console.log(`  导出目录：${EXPORT_DIR}`);
    console.log('');
    console.log('  关闭此窗口即停止服务。');
    if (process.argv.includes('--open')) {
      execFile('cmd', ['/c', 'start', '', url], () => {});
    }
  });
}

// 启动前先确认 DSH_HOME 确实是 DSH 的数据目录。
// 环境变量配错时，这是唯一能拦住「在无关目录里乱写乱删」的机会。
try {
  const home = checkHome({ allowUnusual: process.env.ALLOW_UNUSUAL_DSH_HOME === '1' });
  if (home.unusual) {
    console.warn(`警告：${DSH_HOME} 看起来不是 DSH 数据目录，已由 ALLOW_UNUSUAL_DSH_HOME 放行。`);
  }
} catch (err) {
  console.error('');
  console.error(err instanceof Error ? err.message : String(err));
  console.error('');
  process.exit(1);
}

listen(PREFERRED_PORT);
