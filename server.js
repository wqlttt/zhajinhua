'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Table, PHASE } = require('./table.js');

const PORT = process.env.PORT || 8080;

const TABLE_OPTS = {
  ante: Number(process.env.ANTE) || 10,
  startChips: Number(process.env.START_CHIPS) || 1000,
  maxSeats: Number(process.env.MAX_SEATS) || 6,
};

// 房号规则：4 位数字。房间不存在就自动创建，空置一段时间后回收。
const ROOM_RE = /^\d{4}$/;
const ROOM_TTL_MS = 2 * 60 * 1000; // 全员离线后保留 2 分钟，容忍刷新页面
const MAX_ROOMS = 200;             // 防止被刷满内存

/** @type {Map<string, {table: Table, clients: Map<string, any>, emptyAt: number}>} */
const rooms = new Map();

function getRoom(code) {
  let room = rooms.get(code);
  if (room) {
    room.emptyAt = 0;
    return room;
  }
  if (rooms.size >= MAX_ROOMS) return null;

  const table = new Table(TABLE_OPTS);
  room = { table, clients: new Map(), emptyAt: 0, code };

  // 每个房间独立广播，互不干扰
  table.onChange = () => {
    for (const [sessionId, ws] of room.clients) {
      if (ws.readyState !== ws.OPEN) continue;
      send(ws, 'state', { state: table.snapshotFor(sessionId) });
    }
  };
  table.onEvent = (ev) => {
    for (const ws of room.clients.values()) send(ws, 'event', { event: ev });
  };

  rooms.set(code, room);
  console.log(`[room ${code}] 创建，当前房间数 ${rooms.size}`);
  return room;
}

// 定期回收空房间，释放其定时器
const reaper = setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const online = [...room.clients.values()].filter((w) => w.readyState === w.OPEN).length;
    if (online > 0) {
      room.emptyAt = 0;
      continue;
    }
    if (!room.emptyAt) {
      room.emptyAt = now;
      continue;
    }
    if (now - room.emptyAt > ROOM_TTL_MS) {
      room.table.clearTimer();
      rooms.delete(code);
      console.log(`[room ${code}] 空置回收，剩余 ${rooms.size}`);
    }
  }
}, 30000);

/* ---------- HTTP：只提供 index.html ---------- */

const INDEX = path.join(__dirname, 'index.html');

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/' || url === '/index.html') {
    fs.readFile(INDEX, (err, buf) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('index.html 读取失败');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(buf);
    });
    return;
  }
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      rooms: rooms.size,
      players: [...rooms.values()].reduce((n, r) => n + r.table.seatCount(), 0),
    }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404');
});

/* ---------- WebSocket ---------- */

const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });

function send(ws, type, data) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ type, ...data }));
}

function sanitizeName(raw) {
  const s = String(raw || '').trim().replace(/[\u0000-\u001f<>]/g, '');
  return s.slice(0, 12);
}

wss.on('connection', (ws, req) => {
  ws.authed = false;
  ws.sessionId = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // 简单限流：每个连接每秒最多 20 条消息
  let msgCount = 0;
  const rateTimer = setInterval(() => { msgCount = 0; }, 1000);

  ws.on('message', (raw) => {
    if (++msgCount > 20) return;

    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send(ws, 'error', { error: '消息格式错误' });
    }
    if (!msg || typeof msg.type !== 'string') return;

    /* --- 进房 --- */
    if (msg.type === 'auth') {
      const code = String(msg.room || '').trim();
      if (!ROOM_RE.test(code)) {
        send(ws, 'authFail', { error: '房间号必须是 4 位数字' });
        return;
      }

      const room = getRoom(code);
      if (!room) {
        send(ws, 'authFail', { error: '服务器房间已满，请稍后再试' });
        return;
      }

      // 客户端带上旧 sessionId 可以重连回座位
      const sessionId = typeof msg.sessionId === 'string' && /^[a-f0-9]{32}$/.test(msg.sessionId)
        ? msg.sessionId
        : crypto.randomBytes(16).toString('hex');

      // 同一 session 在本房已有连接，踢掉旧的
      const old = room.clients.get(sessionId);
      if (old && old !== ws && old.readyState === old.OPEN) {
        send(old, 'kicked', { error: '账号在其它地方登录' });
        old.close();
      }

      const result = room.table.join(sessionId, sanitizeName(msg.name));
      if (!result.ok) {
        send(ws, 'authFail', { error: result.error });
        return;
      }

      ws.authed = true;
      ws.sessionId = sessionId;
      ws.room = room;
      room.clients.set(sessionId, ws);
      room.emptyAt = 0;

      const t = room.table;
      send(ws, 'authOk', {
        sessionId,
        room: code,
        seat: result.player.seat,
        name: result.player.name,
        rules: {
          ante: t.rules.ante,
          capBet: t.rules.capBet,
          maxRound: t.rules.maxRound,
          readyCountdown: t.rules.readyCountdown,
          turnSeconds: t.rules.turnSeconds,
          special235: t.rules.special235,
        },
      });
      t.onChange();
      return;
    }

    if (!ws.authed || !ws.room) return send(ws, 'error', { error: '请先进入房间' });

    const room = ws.room;
    const table = room.table;

    /* --- 游戏操作 --- */
    switch (msg.type) {
      case 'ready': {
        const r = table.setReady(ws.sessionId, msg.ready !== false);
        if (!r.ok) send(ws, 'error', { error: r.error });
        break;
      }
      case 'action': {
        const r = table.action(ws.sessionId, msg.action, msg.payload || {});
        if (!r.ok) send(ws, 'error', { error: r.error });
        else if (msg.action === 'look') send(ws, 'looked', { cards: r.cards, hand: r.hand });
        table.onChange();
        break;
      }
      case 'chat': {
        const text = String(msg.text || '').slice(0, 60).replace(/[\u0000-\u001f]/g, '');
        if (!text) break;
        const p = table.findBySession(ws.sessionId);
        if (!p) break;
        for (const c of room.clients.values()) {
          send(c, 'chat', { seat: p.seat, name: p.name, text });
        }
        break;
      }
      case 'ping':
        send(ws, 'pong', { t: msg.t });
        break;
      default:
        send(ws, 'error', { error: '未知消息' });
    }
  });

  ws.on('close', () => {
    clearInterval(rateTimer);
    const room = ws.room;
    if (room && ws.sessionId && room.clients.get(ws.sessionId) === ws) {
      room.clients.delete(ws.sessionId);
      room.table.leave(ws.sessionId);
      if (room.clients.size === 0) room.emptyAt = Date.now();
    }
  });

  ws.on('error', () => {});
});

// 心跳：清理半死连接
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`炸金花服务已启动: http://localhost:${PORT}`);
  console.log(`进房方式：输入 4 位房间号，相同房号的人进同一桌`);
  console.log(`底注 ${TABLE_OPTS.ante} · 初始筹码 ${TABLE_OPTS.startChips} · 每桌 ${TABLE_OPTS.maxSeats} 人`);
});

function shutdown() {
  console.log('\n关闭中...');
  for (const room of rooms.values()) room.table.clearTimer();
  clearInterval(heartbeat);
  clearInterval(reaper);
  wss.close();
  server.close(() => process.exit(0));
  // 兜底：2 秒内没关干净就强退
  setTimeout(() => process.exit(0), 2000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
