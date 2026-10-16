'use strict';
// 端到端测试：两个机器人走完 登录 -> 准备 -> 倒计时 -> 看牌/下注 -> 结算
const WebSocket = require('ws');

const URL = process.env.URL || 'ws://localhost:8099';
const ROOM = process.env.ROOM || '4587';
const log = (...a) => console.log(...a);

function bot(name, strategy) {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL);
    const seen = { authed: false, phases: new Set(), acted: 0, looked: false, settled: false };

    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', room: ROOM, name })));

    // 真实客户端会锁住按钮直到服务端确认，这里用同样的方式避免刷屏
    let pending = false;
    let lastTurnKey = '';

    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());

      if (m.type === 'authFail') { log(`[${name}] 登录失败: ${m.error}`); ws.close(); return resolve(seen); }
      if (m.type === 'authOk') {
        seen.authed = true;
        seen.seat = m.seat;
        log(`[${name}] 登录成功，座位 ${m.seat}`);
        setTimeout(() => ws.send(JSON.stringify({ type: 'ready', ready: true })), 200);
        return;
      }
      if (m.type === 'error') { log(`[${name}] 服务端拒绝: ${m.error}`); return; }
      if (m.type === 'looked') { log(`[${name}] 看牌 -> ${m.hand} ${m.cards.join(' ')}`); return; }

      if (m.type === 'state') {
        const s = m.state;
        seen.phases.add(s.phase);
        const me = s.players[s.mySeat];
        if (!me) return;

        if (s.phase === 'settle' && !seen.settled) {
          seen.settled = true;
          log(`[${name}] 结算: ${s.lastWinner ? s.lastWinner.name + ' 赢 ' + s.lastWinner.amount + ' (' + s.lastWinner.hand + ')' : '无人获胜'}  我的筹码=${me.chips}`);
          setTimeout(() => { ws.close(); resolve(seen); }, 300);
          return;
        }

        if (s.phase !== 'playing' || !me.inHand || me.folded) return;
        if (s.turn !== s.mySeat) return;

        // 同一个回合只行动一次
        const turnKey = `${s.handId}-${s.round}-${s.turn}-${me.looked}`;
        if (pending || turnKey === lastTurnKey) return;
        pending = true;
        lastTurnKey = turnKey;

        setTimeout(() => {
          if (ws.readyState !== 1) return;
          if (strategy === 'look-then-call' && !me.looked) {
            seen.looked = true;
            ws.send(JSON.stringify({ type: 'action', action: 'look' }));
            setTimeout(() => {
              if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'action', action: 'call' }));
              pending = false;
            }, 120);
          } else if (strategy === 'men-call') {
            // 全程闷牌跟注，第 3 轮后弃牌结束对局
            const act = s.round >= 3 ? 'fold' : 'call';
            log(`[${name}] 闷牌 ${act === 'call' ? '跟 ' + s.myCallCost : '弃牌'} (第${s.round}轮, 明注${s.baseBet})`);
            ws.send(JSON.stringify({ type: 'action', action: act }));
            pending = false;
          } else {
            ws.send(JSON.stringify({ type: 'action', action: 'call' }));
            pending = false;
          }
          seen.acted++;
        }, 250);
      }
    });

    ws.on('close', () => resolve(seen));
    ws.on('error', (e) => { log(`[${name}] 连接错误`, e.message); resolve(seen); });
    setTimeout(() => { if (ws.readyState === 1) ws.close(); resolve(seen); }, 30000);
  });
}

(async () => {
  log('=== 测试：非法房号应被拒绝 ===');
  await new Promise((res) => {
    const ws = new WebSocket(URL);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', room: 'abc' })));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      log(m.type === 'authFail' ? `  ok 已拒绝: ${m.error}` : `  FAIL 竟然通过了: ${m.type}`);
      ws.close(); res();
    });
    ws.on('error', () => res());
  });

  log('\n=== 测试：两人对局 ===');
  const [a, b] = await Promise.all([
    bot('明牌哥', 'look-then-call'),
    bot('闷牌王', 'men-call'),
  ]);

  log('\n=== 结果 ===');
  for (const [n, s] of [['明牌哥', a], ['闷牌王', b]]) {
    log(`${n}: 登录=${s.authed} 经历阶段=[${[...s.phases].join(',')}] 操作=${s.acted} 结算收到=${s.settled}`);
  }
  const pass = a.authed && b.authed && a.settled && b.settled
    && a.phases.has('countdown') && a.phases.has('playing');
  log(`\n${pass ? 'PASS 完整对局跑通' : 'FAIL 流程不完整'}`);
  process.exit(pass ? 0 : 1);
})();
