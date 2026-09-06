'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../public/rebalance.js');

const items = [
  { code: 'A00001', name: '주식ETF', weight: 60, qty: 0 },
  { code: 'B00002', name: '채권ETF', weight: 40, qty: 0 },
];

test('planInvest: 투입금액을 비중대로 배분해 정수 수량 산출', () => {
  const plan = R.planInvest(items, { A00001: 12345, B00002: 25000 }, 1000000);
  const [a, b] = plan.rows;
  assert.equal(a.qty, 48); // 600,000 / 12,345 = 48.6 → 48
  assert.equal(b.qty, 16); // 400,000 / 25,000 = 16
  assert.equal(plan.invested, 48 * 12345 + 16 * 25000);
  assert.equal(plan.leftover, 1000000 - plan.invested);
  assert.ok(plan.leftover >= 0);
});

test('planInvest: fillLeftover 로 잔여현금 추가 매수', () => {
  const plan = R.planInvest(items, { A00001: 12345, B00002: 25000 }, 1000000, { fillLeftover: true });
  assert.ok(plan.leftover < 12345);
  assert.ok(plan.invested <= 1000000);
});

test('planInvest: 시세 없는 종목은 제외되고 경고', () => {
  const plan = R.planInvest(items, { A00001: 10000 }, 100000);
  assert.equal(plan.rows[1].qty, 0);
  assert.equal(plan.rows[1].priceMissing, true);
  assert.equal(plan.warnings.length, 1);
});

test('planRebalance: 가격 변동 후 목표비중 복원 매매 산출 (매도→매수, 현금 음수 없음)', () => {
  // 초기 60/40 → 주식ETF 급등
  const holdings = [
    { code: 'A00001', name: '주식ETF', weight: 60, qty: 60 },
    { code: 'B00002', name: '채권ETF', weight: 40, qty: 16 },
  ];
  const prices = { A00001: 15000, B00002: 25000 }; // 주식 900,000 / 채권 400,000 → 총 1,300,000
  const plan = R.planRebalance({ items: holdings, cash: 0, prices });
  const a = plan.rows[0], b = plan.rows[1];
  assert.equal(plan.total, 1300000);
  assert.equal(a.targetQty, Math.floor(780000 / 15000)); // 52
  assert.equal(a.delta, 52 - 60); // 8주 매도
  assert.equal(b.targetQty, Math.floor(520000 / 25000)); // 20
  assert.equal(b.delta, 20 - 16); // 4주 매수
  assert.equal(plan.sells.length, 1);
  assert.equal(plan.buys.length, 1);
  assert.ok(plan.cashAfter >= 0);
  assert.equal(plan.cashAfter, 0 + 8 * 15000 - 4 * 25000);
  assert.equal(plan.needsRebalance, true);
});

test('planRebalance: 추가 투입금액은 총자산에 포함되어 매수로 배분', () => {
  const holdings = [
    { code: 'A00001', name: '주식ETF', weight: 60, qty: 60 },
    { code: 'B00002', name: '채권ETF', weight: 40, qty: 16 },
  ];
  const prices = { A00001: 10000, B00002: 25000 };
  const plan = R.planRebalance({ items: holdings, cash: 0, contribution: 500000, prices });
  assert.equal(plan.total, 1500000);
  assert.equal(plan.rows[0].delta, Math.floor(900000 / 10000) - 60); // +30
  assert.equal(plan.rows[1].delta, Math.floor(600000 / 25000) - 16); // +8
  assert.equal(plan.cashAfter, 500000 - 30 * 10000 - 8 * 25000);
});

test('planRebalance: 밴드 이내면 거래 생략', () => {
  const holdings = [
    { code: 'A00001', name: '주식ETF', weight: 60, qty: 61 },
    { code: 'B00002', name: '채권ETF', weight: 40, qty: 16 },
  ];
  const prices = { A00001: 10000, B00002: 25000 }; // 610,000 / 400,000 → 60.4% / 39.6%
  const plan = R.planRebalance({ items: holdings, cash: 0, prices, band: 3 });
  assert.equal(plan.tradeCount, 0);
  assert.match(plan.rows[0].reason, /밴드/);
  const plan0 = R.planRebalance({ items: holdings, cash: 0, prices, band: 0 });
  assert.ok(plan0.tradeCount >= 1);
});

test('planRebalance: 매도가 밴드로 생략돼도 매수는 가용현금 안에서만 (현금 음수 방지)', () => {
  const holdings = [
    { code: 'A00001', name: 'A', weight: 50, qty: 104 }, // 1,040,000 → 52%
    { code: 'B00002', name: 'B', weight: 50, qty: 48 },  // 960,000 → 48% (밴드 2.5 → A는 2%p 이내라 생략, B는 매수 필요하나 현금 0)
  ];
  const prices = { A00001: 10000, B00002: 20000 };
  const plan = R.planRebalance({ items: holdings, cash: 0, prices, band: 2.5 });
  assert.ok(plan.cashAfter >= 0, 'cashAfter must not be negative');
  assert.equal(plan.rows[0].delta, 0);
  assert.equal(plan.rows[1].delta, 0);
});

test('planRebalance: 예산 부족 시 매수 축소 + 잔여 예산 탐욕 배분', () => {
  const holdings = [
    { code: 'A00001', name: 'A', weight: 50, qty: 90 }, // 900,000 → 목표 825,000 → 8주 매도(80,000)는 최소거래금액 미만으로 생략
    { code: 'B00002', name: 'B', weight: 30, qty: 30 }, // 300,000 → 목표 495,000 → 19주 매수(190,000)
    { code: 'C00003', name: 'C', weight: 20, qty: 20 }, // 200,000 → 목표 330,000 → 13주 매수(130,000)
  ];
  const prices = { A00001: 10000, B00002: 10000, C00003: 10000 };
  // 예수금 250,000 → 총 1,650,000. 매수 희망 320,000 > 예산 250,000 → 축소
  const plan = R.planRebalance({ items: holdings, cash: 250000, prices, minTradeAmount: 100000 });
  assert.equal(plan.rows[0].delta, 0);
  assert.match(plan.rows[0].reason, /최소 거래금액/);
  assert.equal(plan.budgetScaled, true);
  assert.ok(plan.buyTotal <= 250000);
  assert.ok(plan.cashAfter >= 0);
  assert.ok(plan.buyTotal >= 240000, '잔여 예산을 탐욕 배분으로 거의 소진해야 함');
  assert.ok(plan.rows[1].delta > 0 && plan.rows[2].delta > 0);
});

test('planRebalance: 시세 없는 종목은 거래 없음 + 경고', () => {
  const holdings = [
    { code: 'A00001', name: 'A', weight: 50, qty: 10 },
    { code: 'B00002', name: 'B', weight: 50, qty: 10 },
  ];
  const plan = R.planRebalance({ items: holdings, cash: 100000, prices: { A00001: 10000 } });
  assert.equal(plan.rows[1].delta, 0);
  assert.equal(plan.rows[1].priceMissing, true);
  assert.ok(plan.warnings.some((w) => w.includes('B00002')));
});

test('applyPlan: 보유수량/예수금 갱신', () => {
  const portfolio = { items: [{ code: 'A00001', weight: 100, qty: 10 }], cash: 100000 };
  const plan = R.planRebalance({ items: portfolio.items, cash: 100000, prices: { A00001: 10000 } });
  assert.equal(plan.rows[0].delta, 10);
  const next = R.applyPlan(portfolio, plan);
  assert.equal(next.items[0].qty, 20);
  assert.equal(next.cash, 0);
  assert.equal(portfolio.items[0].qty, 10, 'original untouched');
});

test('daysSince', () => {
  const now = Date.parse('2026-09-06T00:00:00Z');
  assert.equal(R.daysSince('2026-08-06T00:00:00Z', now), 31);
  assert.equal(R.daysSince(null, now), null);
});
