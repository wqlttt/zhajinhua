'use strict';
// 验证房间隔离：不同房号互不可见，相同房号同桌
const WebSocket = require('ws');
const URL = process.env.URL || 'ws://localhost:8099';

let pass = 0, fail = 0;
const chk = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label} ${extra}`); }
};

function conn(room, name) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(URL);
    const o = { ws, name, states: [], authed: false, error: null };
    const to = setTimeout(() => rej(new Error(`${name} 超时`)), 8000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', room, name })));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'authOk') {
        o.authed = true; o.seat = m.seat; o.room = m.room; o.rules = m.rules;
        clearTimeout(to); res(o);
      }
      if (m.type === 'authFail') { o.error = m.error; clearTimeout(to); res(o); }
      if (m.type === 'state') o.states.push(m.state);
    });
    ws.on('error', (e) => { clearTimeout(to); rej(e); });
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const last = (o) => o.states[o.states.length - 1];

(async () => {
  console.log('=== 非法房号 ===');
  for (const bad of ['abc', '12', '12345', '', '45a7']) {
    const o = await conn(bad, 'X');
    chk(!o.authed && /4 位数字/.test(o.error || ''), `拒绝 "${bad}"`, o.error || '竟然通过');
    o.ws.close();
  }

  console.log('\n=== 同房号同桌 ===');
  const a = await conn('4587', '张三');
  const b = await conn('4587', '李四');
  const c = await conn('4587', '王五');
  await wait(400);
  chk(a.authed && b.authed && c.authed, '三人都进房成功');
  chk(a.room === '4587' && b.room === '4587', '房号回传正确');
  const seats = [a.seat, b.seat, c.seat];
  chk(new Set(seats).size === 3, '三人占不同座位', seats.join(','));
  const sa = last(a);
  const names = sa.players.filter(Boolean).map((p) => p.name).sort();
  console.log(`  4587 房内玩家: ${names.join(', ')}`);
  chk(names.length === 3, '互相看得见（同桌 3 人）', names.join(','));

  console.log('\n=== 不同房号隔离 ===');
  const d = await conn('9999', '赵六');
  const e = await conn('9999', '孙七');
  await wait(400);
  const sd = last(d);
  const names9999 = sd.players.filter(Boolean).map((p) => p.name).sort();
  console.log(`  9999 房内玩家: ${names9999.join(', ')}`);
  chk(names9999.length === 2, '9999 房只有 2 人', names9999.join(','));
  chk(!names9999.includes('张三'), '看不到 4587 房的张三');
  chk(!names9999.includes('李四'), '看不到 4587 房的李四');

  // 4587 房人数不受 9999 房影响
  const sa2 = last(a);
  chk(sa2.players.filter(Boolean).length === 3, '4587 房仍是 3 人，未被 9999 房污染');

  console.log('\n=== 房间内开局互不干扰 ===');
  // 9999 房两人准备开局
  d.ws.send(JSON.stringify({ type: 'ready', ready: true }));
  e.ws.send(JSON.stringify({ type: 'ready', ready: true }));
  await wait(7000);
  const sd2 = last(d);
  const sa3 = last(a);
  console.log(`  9999 房 phase=${sd2.phase} | 4587 房 phase=${sa3.phase}`);
  chk(sd2.phase === 'playing', '9999 房已开局');
  chk(sa3.phase === 'waiting', '4587 房仍在等待（未被带着开局）');
  chk(sd2.pot > 0, '9999 房有底池', String(sd2.pot));
  chk(sa3.pot === 0, '4587 房底池为 0');

  console.log('\n=== 加注区间字段下发 ===');
  const dplayer = sd2.players[sd2.mySeat];
  console.log(`  myMinRaise=${sd2.myMinRaise} myMaxRaise=${sd2.myMaxRaise} myStake=${sd2.myStake} baseBet=${sd2.baseBet}`);
  chk(typeof sd2.myMinRaise === 'number' && sd2.myMinRaise > sd2.baseBet,
    '服务端下发最小加注且高于当前单注');
  chk(sd2.myMaxRaise >= sd2.myMinRaise, '最大加注不低于最小加注');

  [a, b, c, d, e].forEach((o) => o.ws.close());
  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.log('ERR', err.message); process.exit(1); });
