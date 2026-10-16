'use strict';
// 验证补齐差价：4 人局闷明混合，每轮等价投入应当一致
const { Table } = require('./table.js');

let pass = 0, fail = 0;
const chk = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label} ${extra}`); }
};

function mkTable(opts = {}) {
  const t = new Table({ readyCountdown: 0, turnSeconds: 99999, ...opts });
  return t;
}

console.log('=== 场景1：4人局，B加注，其余补齐差价 ===');
{
  const t = mkTable({ ante: 10, maxRound: 99 });
  ['a', 'b', 'c', 'd'].forEach((s, i) => t.join(s, 'ABCD'[i]));
  t.startHand();
  const P = t.players.filter(Boolean);
  console.log(`  底注后: pot=${t.pot} 每人bet=${P.map(p => p.bet).join(',')} stake=${P.map(p => p.stake).join(',')}`);
  chk(t.pot === 40, '底池 = 4×10');
  chk(P.every((p) => p.stake === 0), '底注不计入 stake（第一轮照常下注）');

  // 让 B（座位1）看牌后加注到 40
  const order = [];
  for (let i = 0; i < 4; i++) order.push(t.turn), t.action(t.players[t.turn].sessionId, 'call');
  console.log(`  第一轮全闷跟一圈: pot=${t.pot} bet=${P.map(p => p.bet).join(',')} stake=${P.map(p => p.stake).join(',')}`);
  chk(t.pot === 40 + 4 * 5, '4人闷跟各付5');
  chk(P.every((p) => p.bet === 15), '每人实付 10底注+5闷跟 = 15');
  t.clearTimer();
}

console.log('\n=== 场景2：闷明混合加注，等价投入必须一致 ===');
{
  const t = mkTable({ ante: 10, maxRound: 99 });
  ['a', 'b', 'c', 'd'].forEach((s, i) => t.join(s, 'ABCD'[i]));
  t.startHand();
  const P = t.players.filter(Boolean);
  const first = t.turn;

  // 第一家看牌并加注到 40
  const p1 = P[t.turn];
  t.action(p1.sessionId, 'look');
  const r = t.action(p1.sessionId, 'raise', { amount: 40 });
  chk(r.ok, `${p1.name} 看牌后加注到 40`, JSON.stringify(r));
  chk(p1.stake === 40, `加注者 stake=40`, `实际 ${p1.stake}`);
  chk(p1.bet === 10 + 40, `明牌加注付满额 40（总 bet=50）`, `实际 ${p1.bet}`);
  console.log(`  ${p1.name} 加注到40 后: pot=${t.pot} bet=${p1.bet} stake=${p1.stake}`);

  // 下一家闷牌跟注 -> 应付 40/2 = 20
  const p2 = P[t.turn];
  const before = p2.chips;
  t.action(p2.sessionId, 'call');
  console.log(`  ${p2.name}(闷) 跟注: 付 ${before - p2.chips} stake=${p2.stake}`);
  chk(before - p2.chips === 20, `闷牌跟 40 只付 20`, `实际付 ${before - p2.chips}`);
  chk(p2.stake === 40, `闷牌跟注后 stake 也是 40（等价持平）`, `实际 ${p2.stake}`);

  // 再下一家看牌跟注 -> 应付满 40
  const p3 = P[t.turn];
  const before3 = p3.chips;
  t.action(p3.sessionId, 'look');
  t.action(p3.sessionId, 'call');
  console.log(`  ${p3.name}(明) 跟注: 付 ${before3 - p3.chips} stake=${p3.stake}`);
  chk(before3 - p3.chips === 40, `明牌跟 40 付满 40`, `实际付 ${before3 - p3.chips}`);

  // 第四家跟注前先看三家的持平情况（第四家一跟就进入新一轮、stake 会清零）
  const stakesBefore = P.filter((p) => p.inHand && !p.folded && p.stake > 0).map((p) => p.stake);
  console.log(`  已行动三家 stake: ${stakesBefore.join(',')}`);
  chk(stakesBefore.length === 3 && stakesBefore.every((s) => s === 40),
    '已行动的人等价投入都是 40（核心：不再是谁先加注谁少出）', stakesBefore.join(','));

  // 累计实付：明牌两家各 10+40=50，闷牌一家 10+20=30
  const paid = P.filter((p) => p.inHand && !p.folded).map((p) => `${p.name}:${p.bet}`);
  console.log(`  累计实付: ${paid.join(' ')}`);

  const p4 = P[t.turn];
  t.action(p4.sessionId, 'call');
  console.log(`  第四家跟注后 round=${t.round} stake 已重置=${P.filter(Boolean).every((p) => p.stake === 0)}`);
  chk(t.round === 2, '一圈持平后进入第 2 轮', `round=${t.round}`);
  t.clearTimer();
}

console.log('\n=== 场景3：旧 bug 回归——先加注者不该占便宜 ===');
{
  const t = mkTable({ ante: 10, maxRound: 99 });
  ['a', 'b'].forEach((s, i) => t.join(s, 'AB'[i]));
  t.startHand();
  const P = t.players.filter(Boolean);
  // 两人都看牌，排除闷明差异，纯看加注逻辑
  P.forEach((p) => t.action(p.sessionId, 'look'));

  const first = P[t.turn];
  t.action(first.sessionId, 'call');            // 跟 10
  const second = P[t.turn];
  t.action(second.sessionId, 'raise', { amount: 40 }); // 加注到 40
  const back = P[t.turn];
  const beforeBack = back.chips;
  t.action(back.sessionId, 'call');             // 补齐差价 40-10=30

  console.log(`  ${first.name}: bet=${first.bet} (补差价付了 ${beforeBack - back.chips})`);
  console.log(`  ${second.name}: bet=${second.bet}`);
  // 两人都看了牌、都走到 40，总实付必须相同：10底注 + 40本轮 = 50
  chk(first.bet === second.bet,
    '双方总实付相同（旧版本先加注者少付10）', `${first.bet} vs ${second.bet}`);
  chk(beforeBack - back.chips === 30, '跟注者只补差价 30，不是重复付 40', `实际 ${beforeBack - back.chips}`);
  t.clearTimer();
}

console.log('\n=== 场景4：筹码守恒 + 封顶 ===');
{
  const t = mkTable({ ante: 10, maxRound: 3 });
  ['a', 'b', 'c'].forEach((s, i) => t.join(s, 'ABC'[i]));
  const startTotal = t.players.filter(Boolean).reduce((s, p) => s + p.chips, 0);
  t.startHand();
  let guard = 0;
  while (t.phase === 'playing' && guard++ < 60) {
    const p = t.players[t.turn];
    if (!p) break;
    t.action(p.sessionId, 'call');
  }
  const endTotal = t.players.filter(Boolean).reduce((s, p) => s + p.chips, 0);
  console.log(`  起始总筹码=${startTotal} 结束=${endTotal} phase=${t.phase} 轮数=${t.round}`);
  chk(endTotal === startTotal, '筹码守恒', `${startTotal} -> ${endTotal}`);
  chk(t.phase === 'settle', '封顶后进入结算');
  t.clearTimer();
}

console.log('\n=== 场景5：最小/最大加注边界 ===');
{
  const t = mkTable({ ante: 10, capBet: 320, maxRound: 99 });
  ['a', 'b'].forEach((s, i) => t.join(s, 'AB'[i]));
  t.startHand();
  const p = t.players[t.turn];
  t.action(p.sessionId, 'look');

  console.log(`  baseBet=${t.baseBet} minRaise=${t.minRaise()} maxRaise=${t.maxRaiseFor(p)}`);
  chk(t.minRaise() === 20, 'baseBet=10 时最小加注到 20（翻倍）', `实际 ${t.minRaise()}`);

  let r = t.action(p.sessionId, 'raise', { amount: 15 });
  chk(!r.ok, '低于最小加注被拒', JSON.stringify(r));
  r = t.action(p.sessionId, 'raise', { amount: 400 });
  chk(!r.ok, '超过单注上限被拒', JSON.stringify(r));
  r = t.action(p.sessionId, 'raise', { amount: 20 });
  chk(r.ok, '刚好最小加注通过', JSON.stringify(r));
  chk(t.baseBet === 20, '单注更新为 20');

  // 闷牌玩家的上限应是筹码的两倍（折算后）
  const q = t.players[t.turn];
  q.chips = 50;
  const maxQ = t.maxRaiseFor(q);
  console.log(`  闷牌玩家 chips=50 stake=${q.stake} maxRaise=${maxQ}`);
  chk(maxQ === q.stake + 100, '闷牌上限 = stake + 筹码×2', `实际 ${maxQ}`);
  // 按上限加注应当刚好付得起
  const costAtMax = t.raiseCost(q, maxQ);
  console.log(`  按上限 ${maxQ} 加注需付 ${costAtMax}，持有 ${q.chips}`);
  chk(costAtMax <= q.chips, '上限加注付得起（修掉旧版滑条算错导致被拒）', `需 ${costAtMax} 有 ${q.chips}`);
  t.clearTimer();
}

console.log('\n=== 场景6：比牌成本 = 补差价 + 一倍单注 ===');
{
  const t = mkTable({ ante: 10, maxRound: 99 });
  ['a', 'b', 'c'].forEach((s, i) => t.join(s, 'ABC'[i]));
  t.startHand();
  const p = t.players[t.turn];
  t.action(p.sessionId, 'look');
  t.action(p.sessionId, 'raise', { amount: 40 });

  const q = t.players[t.turn];
  t.action(q.sessionId, 'look');
  const expect = (40 - q.stake) + 40;
  console.log(`  ${q.name} stake=${q.stake} baseBet=${t.baseBet} compareCost=${t.compareCost(q)} 期望=${expect}`);
  chk(t.compareCost(q) === expect, '明牌比牌 = 补差价 + 一倍单注', `实际 ${t.compareCost(q)}`);

  // 闷牌不能比牌：必须用当前行动者来测，否则会先撞上「还没轮到你」
  const cur = t.players[t.turn];
  if (cur && !cur.looked) {
    const res = t.action(cur.sessionId, 'compare', { target: p.seat });
    chk(!res.ok && /闷牌/.test(res.error || ''), '闷牌比牌被拒', JSON.stringify(res));
  } else {
    console.log('  (当前行动者已看牌，跳过闷牌比牌检查)');
  }
  t.clearTimer();
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
