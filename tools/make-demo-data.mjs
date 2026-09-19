#!/usr/bin/env node
/**
 * 生成一份演示用的 DSH 数据目录。
 *
 * 用途有两个：
 *   1. 让还没装 DSH 的人也能立刻试用本工具，看看界面长什么样；
 *   2. 作为开发/测试用的夹具——所有实验都应该在这种一次性目录里做，
 *      而不是碰真实的会话数据。
 *
 * 用法：
 *   node tools/make-demo-data.mjs <目标目录>
 *   DSH_HOME=<目标目录> node server.mjs --open
 *
 * 生成的内容全部是虚构的，不含任何真实对话。
 */

import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

const target = process.argv[2];
if (!target) {
  console.error('用法：node tools/make-demo-data.mjs <目标目录>');
  console.error('例如：node tools/make-demo-data.mjs ./demo-home');
  process.exit(1);
}

const HOME = resolve(target);
if (existsSync(HOME) && process.argv[3] !== '--force') {
  console.error(`目标目录已存在：${HOME}`);
  console.error('如果确定要覆盖，请加 --force。');
  process.exit(1);
}
if (existsSync(HOME)) rmSync(HOME, { recursive: true, force: true });

// ── 路径编码：与 DSH 的 projectKey 保持一致 ──
function projectKey(cwd) {
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

/** 按 DSH 的物理格式写一个会话日志：第一帧只放头部，第二帧放全部事件。 */
function writeSessionLog(dir, header, events) {
  mkdirSync(dir, { recursive: true });
  const headerLine = `${JSON.stringify(header)}\n`;
  const body = `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;
  writeFileSync(
    join(dir, 'session.v3.jsonl.zstd'),
    Buffer.concat([
      zstdCompressSync(Buffer.from(headerLine, 'utf8')),
      zstdCompressSync(Buffer.from(body, 'utf8')),
    ]),
  );
}

function buildSession({ id, cwd, createdAt, turns }) {
  let seq = 0;
  const events = [];
  const push = (type, data) => {
    events.push({ type, seq: seq++, time: createdAt + seq * 1200, data });
  };

  turns.forEach((turn, index) => {
    const n = index + 1;
    push('turn/start', { turn: n });
    push('step/start', { turn: n, step: 1 });
    push('user/message', {
      content: [{ type: 'text', text: turn.ask }],
      source: { kind: 'user' },
      role: 'user',
      id: `msg-${n}`,
    });
    const content = [{ type: 'text', text: turn.answer }];
    if (turn.tool) {
      content.unshift({ type: 'tool-call', id: `call_${n}`, name: turn.tool.name, arguments: JSON.stringify(turn.tool.args) });
      push('assistant/message', { turn: n, step: 1, message: { role: 'assistant', content } });
      push('tool/call', { turn: n, step: 1, callId: `call_${n}`, name: turn.tool.name, arguments: JSON.stringify(turn.tool.args) });
      push('tool/result', {
        turn: n, step: 1,
        message: {
          source: { kind: 'tool', callId: `call_${n}` },
          content: [{ type: 'tool-result', toolCallId: `call_${n}`, content: [{ type: 'text', text: turn.tool.output }] }],
        },
      });
    } else {
      push('assistant/message', { turn: n, step: 1, message: { role: 'assistant', content } });
    }
    push('step/end', { turn: n, step: 1 });
    push('turn/end', { turn: n });
  });

  return {
    header: { type: 'session', version: 3, id, createdAt, cwd, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' },
    events,
  };
}

// ── 两条虚构会话 ──
const DEMO_CWD = 'C:\\demo\\file-renamer';
const PROJECT = projectKey(DEMO_CWD);
const now = Date.now();

const demoA = buildSession({
  id: 'session-11111111-1111-4111-8111-111111111111',
  cwd: DEMO_CWD,
  createdAt: now - 7_200_000,
  turns: [
    {
      ask: '帮我写一个批量重命名文件的脚本，把目录里所有 .tmp 后缀去掉',
      answer: '先看一下目录里有什么。',
      tool: { name: 'pwsh', args: { command: `Get-ChildItem ${DEMO_CWD}` }, output: 'a.txt.tmp\nb.log.tmp\nreadme.md' },
    },
    {
      ask: '顺便加一个 --dry-run 选项，只打印不实际改名',
      answer: '好，加上 --dry-run。默认仍然直接改名，加了参数就只列出计划改名的文件。',
      tool: { name: 'write', args: { path: `${DEMO_CWD}\\rename.ps1` }, output: '已写入 rename.ps1（42 行）' },
    },
    {
      ask: 'readme.md 不要动，只处理 .tmp',
      answer: '已经限制成只匹配 *.tmp，readme.md 不会被碰。改好的脚本在 rename.ps1。',
    },
  ],
});

const demoB = buildSession({
  id: 'session-22222222-2222-4222-8222-222222222222',
  cwd: DEMO_CWD,
  createdAt: now - 3_600_000,
  turns: [
    {
      ask: '这个脚本能处理子目录吗？',
      answer: '目前只处理当前目录。要递归的话加 -Recurse，我可以顺手改一下。',
    },
    {
      ask: '加上吧，另外输出一份改动清单到 renamed.log',
      answer: '改成递归 + 输出清单了。每改一个文件就往 renamed.log 追加一行，方便回溯。',
      tool: { name: 'write', args: { path: `${DEMO_CWD}\\renamed.log` }, output: '已创建 renamed.log' },
    },
  ],
});

for (const demo of [demoA, demoB]) {
  writeSessionLog(join(HOME, 'sessions', PROJECT, demo.header.id), demo.header, demo.events);
}

mkdirSync(join(HOME, 'storages', 'session_projcache', 'sessions'), { recursive: true });
writeFileSync(join(HOME, 'storages', 'workspace.json'), JSON.stringify({
  unit: { name: 'workspace', version: 2 },
  global: { initialized: true, workspaceIds: ['ws-demo'], archivedSessionIds: [] },
  tables: {
    workspaces: {
      'ws-demo': {
        path: DEMO_CWD,
        title: 'file-renamer',
        sessionIds: [demoA.header.id, demoB.header.id],
        createdAt: new Date(now - 86_400_000).toISOString(),
        updatedAt: new Date(now).toISOString(),
      },
    },
  },
}, null, 2));

console.log('');
console.log(`  演示数据已生成：${HOME}`);
console.log(`  工作区：${DEMO_CWD}（2 条会话，共 5 轮）`);
console.log('');
console.log('  这样启动就能看到效果：');
console.log(`    DSH_HOME="${HOME}" node server.mjs --open`);
console.log('');
console.log('  提醒：这是虚构数据，随便折腾。所有实验都在这种一次性目录里做，');
console.log('  不要拿真实的 DSH 数据目录试破坏性操作。');
console.log('');
