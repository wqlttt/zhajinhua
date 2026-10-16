'use strict';

// 牌型权重，数字越大越强
const HAND = {
  HIGH: 1,      // 单张
  PAIR: 2,      // 对子
  STRAIGHT: 3,  // 顺子
  FLUSH: 4,     // 金花
  STR_FLUSH: 5, // 同花顺
  TRIPS: 6,     // 豹子
  SPECIAL: 7,   // 235 杂花（可选规则，通杀豹子）
};

const HAND_NAME = {
  1: '单张',
  2: '对子',
  3: '顺子',
  4: '金花',
  5: '同花顺',
  6: '豹子',
  7: '特殊牌',
};

const SUITS = ['s', 'h', 'c', 'd']; // 黑桃 红桃 梅花 方块
const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
const RANK_LABEL = {
  11: 'J', 12: 'Q', 13: 'K', 14: 'A',
};

function cardLabel(card) {
  return (RANK_LABEL[card.rank] || String(card.rank)) + card.suit;
}

function buildDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit });
    }
  }
  return deck;
}

// Fisher-Yates，用 crypto 取随机数避免 Math.random 可预测
function shuffle(deck, rng) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = rng(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// 评估 3 张牌，返回 { type, tiebreak }
// tiebreak 是同牌型内比大小用的点数数组，按比较优先级降序排列
function evaluate(cards, rules = {}) {
  const ranks = cards.map((c) => c.rank).sort((a, b) => b - a);
  const suits = cards.map((c) => c.suit);
  const sameSuit = suits[0] === suits[1] && suits[1] === suits[2];

  // 235 杂花通杀（可选）
  if (rules.special235 && !sameSuit) {
    const set = new Set(ranks);
    if (set.size === 3 && set.has(5) && set.has(3) && set.has(2)) {
      return { type: HAND.SPECIAL, tiebreak: [] };
    }
  }

  // 豹子
  if (ranks[0] === ranks[1] && ranks[1] === ranks[2]) {
    return { type: HAND.TRIPS, tiebreak: [ranks[0]] };
  }

  const straight = detectStraight(ranks, rules);

  if (sameSuit && straight) {
    return { type: HAND.STR_FLUSH, tiebreak: [straight.high] };
  }
  if (sameSuit) {
    return { type: HAND.FLUSH, tiebreak: ranks };
  }
  if (straight) {
    return { type: HAND.STRAIGHT, tiebreak: [straight.high] };
  }

  // 对子：对子点数优先，再比单张
  if (ranks[0] === ranks[1]) {
    return { type: HAND.PAIR, tiebreak: [ranks[0], ranks[2]] };
  }
  if (ranks[1] === ranks[2]) {
    return { type: HAND.PAIR, tiebreak: [ranks[1], ranks[0]] };
  }

  return { type: HAND.HIGH, tiebreak: ranks };
}

// ranks 已降序。A23 视为最小顺子，用 high=3 让它排在 234 之下
function detectStraight(ranks, rules) {
  const [a, b, c] = ranks;
  if (a - 1 === b && b - 1 === c) {
    return { high: a };
  }
  if (rules.a23Straight !== false && a === 14 && b === 3 && c === 2) {
    return { high: 3 };
  }
  return null;
}

// a 大于 b 返回正数，小于返回负数，相等返回 0
function compareHands(a, b) {
  if (a.type !== b.type) {
    // 235 特殊牌只通杀豹子，遇到其它牌型按单张算
    if (a.type === HAND.SPECIAL) return b.type === HAND.TRIPS ? 1 : -1;
    if (b.type === HAND.SPECIAL) return a.type === HAND.TRIPS ? -1 : 1;
    return a.type - b.type;
  }
  const len = Math.max(a.tiebreak.length, b.tiebreak.length);
  for (let i = 0; i < len; i++) {
    const diff = (a.tiebreak[i] || 0) - (b.tiebreak[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

module.exports = {
  HAND,
  HAND_NAME,
  buildDeck,
  shuffle,
  evaluate,
  compareHands,
  cardLabel,
};

