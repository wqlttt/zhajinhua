'use strict';

const crypto = require('crypto');
const { buildDeck, shuffle, evaluate, compareHands, HAND_NAME, cardLabel } = require('./cards.js');

// 用 crypto 做随机源，洗牌结果不可预测
function randomInt(max) {
  return crypto.randomInt(max);
}

const DEFAULTS = {
  ante: 10,          // 底注
  maxRound: 4,       // 封顶轮数，到了强制开牌
  capBet: 320,       // 单注上限（明注口径）
  startChips: 1000,  // 初始筹码
  maxSeats: 6,
  minPlayers: 2,
  readyCountdown: 5, // 准备就绪后的倒计时秒数
  turnSeconds: 30,   // 每人操作时限
  special235: true,
  a23Straight: true,
};

const PHASE = {
  WAITING: 'waiting',     // 等人准备
  COUNTDOWN: 'countdown', // 5 秒倒计时
  PLAYING: 'playing',
  SETTLE: 'settle',       // 结算展示
};

class Table {
  constructor(opts = {}) {
    this.rules = { ...DEFAULTS, ...opts };
    this.players = [];      // 座位数组，空位为 null
    this.players.length = this.rules.maxSeats;
    this.players.fill(null);
    this.phase = PHASE.WAITING;
    this.pot = 0;
    this.baseBet = this.rules.ante; // 当前明注基准
    this.round = 0;
    this.turn = -1;          // 当前行动者座位号
    this.dealer = -1;
    this.lastWinner = null;
    this.log = [];
    this.handId = 0;
    this.deadline = 0;       // 当前阶段截止时间戳
    this.onChange = () => {};
    this.onEvent = () => {};
    this._timer = null;
  }

  /* ---------- 座位管理 ---------- */

  seatCount() {
    return this.players.filter(Boolean).length;
  }

  findBySession(sessionId) {
    return this.players.find((p) => p && p.sessionId === sessionId) || null;
  }

  join(sessionId, name) {
    const existing = this.findBySession(sessionId);
    if (existing) {
      existing.online = true;
      return { ok: true, player: existing, rejoined: true };
    }
    const seat = this.players.findIndex((p) => p === null);
    if (seat === -1) return { ok: false, error: '牌桌已满' };

    const player = {
      seat,
      sessionId,
      name: name || `玩家${seat + 1}`,
      chips: this.rules.startChips,
      cards: [],
      hand: null,
      looked: false,     // 是否看牌
      folded: false,
      allin: false,
      inHand: false,     // 本局是否参与
      ready: false,
      online: true,
      bet: 0,            // 本局实付筹码（闷牌已按一半计）
      stake: 0,          // 本轮投入的「明注等价值」，用于补齐差价
      lastAction: null,
    };
    this.players[seat] = player;
    this.pushLog(`${player.name} 坐到了 ${seat + 1} 号位`);
    return { ok: true, player };
  }

  leave(sessionId) {
    const p = this.findBySession(sessionId);
    if (!p) return;
    // 游戏中离开按弃牌处理，保留座位到本局结束
    if (this.phase === PHASE.PLAYING && p.inHand && !p.folded) {
      p.folded = true;
      p.lastAction = 'fold';
      this.pushLog(`${p.name} 离开，自动弃牌`);
      if (this.turn === p.seat) this.advanceTurn();
      else this.checkHandEnd();
    }
    p.online = false;
    if (this.phase !== PHASE.PLAYING) {
      this.players[p.seat] = null;
      this.pushLog(`${p.name} 离开了牌桌`);
    }
    this.emit();
  }

  setReady(sessionId, ready) {
    const p = this.findBySession(sessionId);
    if (!p) return { ok: false, error: '不在座位上' };
    if (this.phase === PHASE.PLAYING) return { ok: false, error: '游戏进行中' };
    if (p.chips < this.rules.ante) return { ok: false, error: '筹码不足，无法准备' };
    p.ready = ready;
    this.evaluateReadyState();
    this.emit();
    return { ok: true };
  }

  // 人数够且全部准备 -> 开始倒计时；中途有人取消准备 -> 回到等待
  evaluateReadyState() {
    if (this.phase === PHASE.PLAYING || this.phase === PHASE.SETTLE) return;
    const seated = this.players.filter(Boolean);
    const eligible = seated.filter((p) => p.chips >= this.rules.ante);
    const allReady = eligible.length >= this.rules.minPlayers
      && eligible.every((p) => p.ready);

    if (allReady && this.phase === PHASE.WAITING) {
      this.phase = PHASE.COUNTDOWN;
      this.deadline = Date.now() + this.rules.readyCountdown * 1000;
      this.pushLog(`全部就绪，${this.rules.readyCountdown} 秒后开始`);
      this.setTimer(() => this.startHand(), this.rules.readyCountdown * 1000);
    } else if (!allReady && this.phase === PHASE.COUNTDOWN) {
      this.phase = PHASE.WAITING;
      this.deadline = 0;
      this.clearTimer();
      this.pushLog('有玩家取消准备，倒计时中止');
    }
  }

  /* ---------- 开局 ---------- */

  startHand() {
    const seated = this.players.filter((p) => p && p.chips >= this.rules.ante);
    if (seated.length < this.rules.minPlayers) {
      this.phase = PHASE.WAITING;
      this.deadline = 0;
      this.pushLog('人数不足，回到等待');
      this.emit();
      return;
    }

    this.handId++;
    this.phase = PHASE.PLAYING;
    this.pot = 0;
    this.round = 1;
    this.baseBet = this.rules.ante;
    this.log = [];

    const deck = shuffle(buildDeck(), randomInt);

    for (const p of this.players) {
      if (!p) continue;
      const playing = p.chips >= this.rules.ante;
      p.inHand = playing;
      p.folded = !playing;
      p.looked = false;
      p.allin = false;
      p.bet = 0;
      p.stake = 0;
      p.lastAction = null;
      p.cards = [];
      p.hand = null;
      p.ready = false;
      if (!playing) continue;

      p.cards = [deck.pop(), deck.pop(), deck.pop()];
      p.hand = evaluate(p.cards, this.rules);
      // 底注是人人相同的入场费，开局没人看过牌，所以不分闷明、全额收取。
      // 它不计入 stake：stake 只记「本轮下注」，所以第一轮大家照常要下注。
      p.chips -= this.rules.ante;
      p.bet += this.rules.ante;
      p.stake = 0;
      this.pot += this.rules.ante;
    }

    // 庄位轮转，从庄位下一家开始叫
    this.dealer = this.nextOccupied(this.dealer);
    this.turn = this.nextActive(this.dealer);

    this.pushLog(`第 ${this.handId} 局开始，底注 ${this.rules.ante}`);
    this.startTurnTimer();
    this.emit();
    this.onEvent({ type: 'handStart', handId: this.handId });
  }

  nextOccupied(from) {
    const n = this.rules.maxSeats;
    for (let i = 1; i <= n; i++) {
      const s = (from + i + n) % n;
      if (this.players[s]) return s;
    }
    return from;
  }

  // 下一个还能行动的人（未弃牌、未 allin）
  nextActive(from) {
    const n = this.rules.maxSeats;
    for (let i = 1; i <= n; i++) {
      const s = (from + i + n) % n;
      const p = this.players[s];
      if (p && p.inHand && !p.folded && !p.allin) return s;
    }
    return -1;
  }

  activePlayers() {
    return this.players.filter((p) => p && p.inHand && !p.folded);
  }

  /* ---------- 注额换算 ---------- */
  // 内部统一用「明注等价值」记账（player.stake），闷牌玩家实付减半。
  // 这样闷明双方的投入可以直接比较，加注只需补齐等价值的差额。

  // 把明注等价值折算成该玩家的实付筹码
  costFor(player, showValue) {
    return player.looked ? showValue : Math.floor(showValue / 2);
  }

  // 跟注：补齐到当前单注，付差额
  callCost(player) {
    const owed = Math.max(0, this.baseBet - player.stake);
    return this.costFor(player, owed);
  }

  // 加注到 next：补齐差额后再抬高单注，一次付清
  raiseCost(player, next) {
    const owed = Math.max(0, next - player.stake);
    return this.costFor(player, owed);
  }

  // 比牌：先补齐差额，再额外付一倍当前单注
  compareCost(player) {
    const owed = Math.max(0, this.baseBet - player.stake);
    return this.costFor(player, owed + this.baseBet);
  }

  // 最小加注：当前单注翻倍或加一个底注，取较大者，并受上限约束
  minRaise() {
    return Math.min(
      this.rules.capBet,
      Math.max(this.baseBet + this.rules.ante, this.baseBet * 2)
    );
  }

  // 该玩家付得起的最高加注额（明注口径），客户端滑条用同一套公式
  maxRaiseFor(player) {
    // 闷牌实付减半，所以同样筹码能撑到两倍的明注等价值
    const budget = player.looked ? player.chips : player.chips * 2;
    return Math.min(this.rules.capBet, player.stake + budget);
  }

  /* ---------- 玩家动作 ---------- */

  action(sessionId, type, payload = {}) {
    const p = this.findBySession(sessionId);
    if (!p) return { ok: false, error: '不在座位上' };
    if (this.phase !== PHASE.PLAYING) return { ok: false, error: '现在不能操作' };
    if (!p.inHand || p.folded) return { ok: false, error: '已不在本局' };

    // 看牌不占行动权，任何时候都能看
    if (type === 'look') return this.doLook(p);

    if (this.turn !== p.seat) return { ok: false, error: '还没轮到你' };

    switch (type) {
      case 'fold':    return this.doFold(p);
      case 'call':    return this.doCall(p);
      case 'raise':   return this.doRaise(p, payload.amount);
      case 'compare': return this.doCompare(p, payload.target);
      case 'allin':   return this.doAllin(p);
      default:        return { ok: false, error: '未知操作' };
    }
  }

  doLook(p) {
    if (p.looked) return { ok: false, error: '已经看过牌了' };
    p.looked = true;
    this.pushLog(`${p.name} 看牌`);
    this.emit();
    return { ok: true, cards: p.cards.map(cardLabel), hand: HAND_NAME[p.hand.type] };
  }

  doFold(p) {
    p.folded = true;
    p.lastAction = 'fold';
    this.pushLog(`${p.name} 弃牌`);
    if (!this.checkHandEnd()) this.advanceTurn();
    return { ok: true };
  }

  doCall(p) {
    const cost = this.callCost(p);
    // 已经持平（例如看牌后原地跟）时不该白跑一轮，但也不扣钱
    if (cost <= 0) {
      p.lastAction = 'call';
      this.pushLog(`${p.name} 过牌`);
      this.advanceTurn();
      return { ok: true };
    }
    if (p.chips < cost) return this.doAllin(p);
    p.chips -= cost;
    p.bet += cost;
    p.stake = this.baseBet;
    this.pot += cost;
    p.lastAction = 'call';
    this.pushLog(`${p.name} ${p.looked ? '跟注' : '闷跟'} ${cost}`);
    this.advanceTurn();
    return { ok: true };
  }

  doRaise(p, amount) {
    // amount 是新的单注（明注口径）
    const next = Math.floor(Number(amount));
    if (!Number.isFinite(next)) return { ok: false, error: '加注额无效' };

    const min = this.minRaise();
    if (next < min) return { ok: false, error: `最少加注到 ${min}` };
    if (next > this.rules.capBet) {
      return { ok: false, error: `单注上限 ${this.rules.capBet}` };
    }

    const cost = this.raiseCost(p, next);
    if (p.chips < cost) return { ok: false, error: `加注到 ${next} 需要 ${cost} 筹码` };

    this.baseBet = next;
    p.chips -= cost;
    p.bet += cost;
    p.stake = next;
    this.pot += cost;
    p.lastAction = 'raise';
    this.pushLog(`${p.name} 加注到 ${next}${p.looked ? '' : '（闷）'}，付 ${cost}`);
    this.advanceTurn();
    return { ok: true };
  }

  doAllin(p) {
    const cost = p.chips;
    if (cost <= 0) return { ok: false, error: '没有筹码了' };
    p.chips = 0;
    p.bet += cost;
    this.pot += cost;
    p.allin = true;
    p.lastAction = 'allin';
    // 全下的等价值：实付换算回明注口径，加上本轮已投入的部分
    const equiv = p.stake + (p.looked ? cost : cost * 2);
    p.stake = equiv;
    if (equiv > this.baseBet) this.baseBet = Math.min(equiv, this.rules.capBet);
    this.pushLog(`${p.name} 全下 ${cost}`);
    if (!this.checkHandEnd()) this.advanceTurn();
    return { ok: true };
  }

  doCompare(p, targetSeat) {
    if (!p.looked) return { ok: false, error: '闷牌不能比牌，请先看牌' };
    const others = this.activePlayers().filter((o) => o.seat !== p.seat);
    if (others.length === 0) return { ok: false, error: '没有可比的对手' };

    let target;
    if (others.length === 1) {
      target = others[0];
    } else {
      target = others.find((o) => o.seat === Number(targetSeat));
      if (!target) return { ok: false, error: '请选择比牌对手' };
    }

    const cost = this.compareCost(p);
    if (p.chips < cost) return { ok: false, error: `比牌需要 ${cost} 筹码` };

    p.chips -= cost;
    p.bet += cost;
    // 比牌付了「补齐差额 + 一倍单注」，等价值记到当前单注之上
    p.stake = this.baseBet;
    this.pot += cost;
    p.lastAction = 'compare';

    const result = compareHands(p.hand, target.hand);
    // 平局时发起方输（主流规则：挑战方承担平局风险）
    const loser = result > 0 ? target : p;
    const winner = result > 0 ? p : target;
    loser.folded = true;

    this.pushLog(
      `${p.name} 比牌 ${target.name}（付 ${cost}）→ ${winner.name} 胜，${loser.name} 出局`
    );
    this.onEvent({
      type: 'compare',
      from: p.seat,
      to: target.seat,
      winner: winner.seat,
      loser: loser.seat,
    });

    if (!this.checkHandEnd()) {
      // 如果输的是当前行动者，行动权交给下一家
      if (this.turn === loser.seat) this.advanceTurn();
      else {
        this.startTurnTimer();
        this.emit();
      }
    }
    return { ok: true, winner: winner.seat };
  }

  /* ---------- 回合推进 ---------- */

  advanceTurn() {
    if (this.checkHandEnd()) return;

    const prev = this.turn;
    const next = this.nextActive(prev);

    if (next === -1) {
      // 没人能再行动（全 allin），直接开牌
      this.showdown('全部全下');
      return;
    }

    // 一轮结束的条件：绕回起点，且所有还能行动的人都已持平当前单注。
    // 只看「绕回起点」是不够的——中途有人加注时，前面已行动的人还欠差价。
    const roundStart = this.nextActive(this.dealer);
    const settled = this.activePlayers()
      .filter((p) => !p.allin)
      .every((p) => p.stake >= this.baseBet);

    if (next === roundStart && prev !== -1 && prev !== next && settled) {
      this.round++;
      if (this.round > this.rules.maxRound) {
        this.showdown(`已达 ${this.rules.maxRound} 轮封顶，强制开牌`);
        return;
      }
      // 新一轮：单注延续，每人重新从 0 开始补齐
      for (const p of this.players) {
        if (p && p.inHand && !p.folded) p.stake = 0;
      }
      this.pushLog(`第 ${this.round} 轮`);
    }

    this.turn = next;
    this.startTurnTimer();
    this.emit();
  }

  // 只剩一人 -> 直接获胜
  checkHandEnd() {
    const alive = this.activePlayers();
    if (alive.length <= 1) {
      this.settle(alive[0] || null, '其余玩家均已弃牌');
      return true;
    }
    return false;
  }

  showdown(reason) {
    const alive = this.activePlayers();
    if (alive.length === 0) {
      this.settle(null, reason);
      return;
    }
    let best = alive[0];
    for (const p of alive.slice(1)) {
      if (compareHands(p.hand, best.hand) > 0) best = p;
    }
    // 开牌时所有参与者的牌都公开
    for (const p of alive) p.looked = true;
    this.settle(best, reason, true);
  }

  settle(winner, reason, revealAll = false) {
    this.clearTimer();
    this.phase = PHASE.SETTLE;
    this.turn = -1;
    this.revealAll = revealAll;

    const won = this.pot;
    if (winner) {
      winner.chips += won;
      this.lastWinner = {
        seat: winner.seat,
        name: winner.name,
        amount: won,
        hand: HAND_NAME[winner.hand.type],
        cards: winner.cards.map(cardLabel),
      };
      this.pushLog(`${winner.name} 赢得 ${won}（${HAND_NAME[winner.hand.type]}）— ${reason}`);
    } else {
      this.lastWinner = null;
      this.pushLog(`本局无人获胜 — ${reason}`);
    }

    this.pot = 0;
    this.onEvent({ type: 'settle', winner: winner ? winner.seat : null, amount: won });
    this.emit();

    // 展示 6 秒后回到等待准备
    this.setTimer(() => this.resetToWaiting(), 6000);
  }

  resetToWaiting() {
    this.phase = PHASE.WAITING;
    this.deadline = 0;
    this.revealAll = false;
    this.round = 0;
    this.baseBet = this.rules.ante;
    for (const p of this.players) {
      if (!p) continue;
      p.cards = [];
      p.hand = null;
      p.looked = false;
      p.folded = false;
      p.allin = false;
      p.inHand = false;
      p.bet = 0;
      p.stake = 0;
      p.lastAction = null;
      p.ready = false;
      // 断线且不在局中的玩家清出座位
      if (!p.online) this.players[p.seat] = null;
    }
    this.pushLog('等待玩家准备');
    this.emit();
  }

  /* ---------- 超时托管 ---------- */

  startTurnTimer() {
    this.deadline = Date.now() + this.rules.turnSeconds * 1000;
    this.setTimer(() => this.onTurnTimeout(), this.rules.turnSeconds * 1000);
  }

  onTurnTimeout() {
    const p = this.players[this.turn];
    if (!p || this.phase !== PHASE.PLAYING) return;
    this.pushLog(`${p.name} 超时`);
    // 闷牌超时自动跟注一次（成本低），明牌超时弃牌
    if (!p.looked && p.chips >= this.callCost(p)) this.doCall(p);
    else this.doFold(p);
  }

  setTimer(fn, ms) {
    this.clearTimer();
    this._timer = setTimeout(() => {
      this._timer = null;
      try {
        fn();
      } catch (err) {
        console.error('[table] timer error:', err);
      }
    }, ms);
  }

  clearTimer() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  /* ---------- 状态快照 ---------- */

  pushLog(text) {
    this.log.push({ t: Date.now(), text });
    if (this.log.length > 60) this.log.shift();
  }

  emit() {
    this.onChange();
  }

  // 给指定玩家的视图：别人的底牌永远不下发，除非开牌公开
  snapshotFor(sessionId) {
    const me = this.findBySession(sessionId);
    return {
      phase: this.phase,
      handId: this.handId,
      pot: this.pot,
      baseBet: this.baseBet,
      round: this.round,
      maxRound: this.rules.maxRound,
      ante: this.rules.ante,
      capBet: this.rules.capBet,
      turn: this.turn,
      dealer: this.dealer,
      deadline: this.deadline,
      serverTime: Date.now(),
      mySeat: me ? me.seat : -1,
      myCards: me && me.looked ? me.cards.map(cardLabel) : null,
      myHand: me && me.looked && me.hand ? HAND_NAME[me.hand.type] : null,
      myCallCost: me && me.inHand && !me.folded ? this.callCost(me) : 0,
      myCompareCost: me && me.inHand && !me.folded ? this.compareCost(me) : 0,
      myStake: me ? me.stake : 0,
      // 加注区间由服务端给出，客户端滑条直接用，不再自己算
      myMinRaise: me && me.inHand && !me.folded ? this.minRaise() : 0,
      myMaxRaise: me && me.inHand && !me.folded ? this.maxRaiseFor(me) : 0,
      lastWinner: this.lastWinner,
      log: this.log.slice(-12),
      players: this.players.map((p) => {
        if (!p) return null;
        const reveal = this.revealAll && p.inHand && !p.folded;
        return {
          seat: p.seat,
          name: p.name,
          chips: p.chips,
          bet: p.bet,
          stake: p.stake,
          looked: p.looked,
          folded: p.folded,
          allin: p.allin,
          inHand: p.inHand,
          ready: p.ready,
          online: p.online,
          isMe: me ? p.seat === me.seat : false,
          lastAction: p.lastAction,
          cards: reveal || (me && p.seat === me.seat && p.looked)
            ? p.cards.map(cardLabel)
            : null,
          hand: reveal && p.hand ? HAND_NAME[p.hand.type] : null,
        };
      }),
    };
  }
}

module.exports = { Table, PHASE, DEFAULTS };
