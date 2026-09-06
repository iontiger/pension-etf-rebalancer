/**
 * 연금 ETF 포트폴리오 계산 모듈 (브라우저 / Node 공용, 의존성 없음)
 *  - planInvest    : 신규 투입금액 → 목표비중대로 매수 수량 산출
 *  - planRebalance : 정적 리밸런싱 — 현재 보유수량/예수금/현재가 기준으로 목표비중에 맞추기 위한 매수/매도 수량 산출
 *  - applyPlan     : 계획대로 거래했다고 가정하고 보유수량/예수금 갱신
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Rebalance = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EPS = 1e-9;

  function floorQty(v) {
    return Math.max(0, Math.floor(v + EPS));
  }
  function num(v, d) {
    var n = Number(v);
    return isFinite(n) ? n : (d || 0);
  }
  function priceOf(prices, code) {
    var p = prices ? prices[code] : null;
    if (p && typeof p === 'object') p = p.price;
    p = Number(p);
    return isFinite(p) && p > 0 ? p : null;
  }
  function round2(v) {
    return Math.round(v * 100) / 100;
  }

  /**
   * 신규 투입 계산
   * @param {Array<{code:string,name?:string,weight:number}>} items
   * @param {Object} prices  { code: price } 또는 { code: {price} }
   * @param {number} amount  투입금액(원)
   * @param {{fillLeftover?:boolean}} [opts] fillLeftover: 잔여 현금으로 가장 부족한 종목부터 1주씩 추가 매수
   */
  function planInvest(items, prices, amount, opts) {
    opts = opts || {};
    amount = Math.max(0, Math.floor(num(amount)));
    var warnings = [];
    var weightSum = 0;
    var rows = items.map(function (it) {
      var weight = num(it.weight);
      weightSum += weight;
      var price = priceOf(prices, it.code);
      var targetValue = amount * weight / 100;
      var qty = price ? floorQty(targetValue / price) : 0;
      if (!price) warnings.push(it.code + ' ' + (it.name || '') + ': 시세가 없어 계산에서 제외했습니다.');
      return {
        code: it.code, name: it.name || '', weight: weight, price: price,
        targetValue: Math.round(targetValue), qty: qty, cost: price ? qty * price : 0,
        priceMissing: !price
      };
    });
    var invested = rows.reduce(function (s, r) { return s + r.cost; }, 0);
    var leftover = amount - invested;

    if (opts.fillLeftover) {
      // 목표금액 대비 부족분이 가장 큰 종목부터, 살 수 있는 동안 1주씩 추가
      for (var guard = 0; guard < 100000; guard++) {
        var best = null, bestGap = 0;
        for (var i = 0; i < rows.length; i++) {
          var r = rows[i];
          if (!r.price || r.price > leftover || r.weight <= 0) continue;
          var gap = r.targetValue - r.cost; // 양수면 아직 부족
          if (best === null || gap > bestGap) { best = r; bestGap = gap; }
        }
        if (!best) break;
        best.qty += 1; best.cost += best.price; leftover -= best.price; invested += best.price;
      }
    }
    rows.forEach(function (r) {
      r.actualWeight = amount > 0 ? round2(r.cost / amount * 100) : 0;
    });
    if (weightSum > 100 + 1e-6) warnings.push('목표비중 합계가 100%를 초과합니다 (' + round2(weightSum) + '%).');
    return {
      amount: amount, rows: rows, invested: invested, leftover: leftover,
      weightSum: round2(weightSum), cashWeight: round2(100 - weightSum), warnings: warnings
    };
  }

  /**
   * 정적 리밸런싱 계획
   * @param {Object} p
   * @param {Array<{code,name?,weight,qty}>} p.items
   * @param {number} p.cash            현재 예수금(원)
   * @param {number} [p.contribution]  이번에 추가 투입할 금액(원)
   * @param {Object} p.prices          { code: price } 또는 { code: {price} }
   * @param {number} [p.band]          리밸런싱 밴드(%p): |현재비중-목표비중| < band 이면 거래 생략 (0=항상)
   * @param {number} [p.minTradeAmount] 최소 거래금액(원): 이보다 작은 거래는 생략
   */
  function planRebalance(p) {
    var items = p.items || [];
    var prices = p.prices || {};
    var cashBefore = Math.max(0, num(p.cash));
    var contribution = Math.max(0, Math.floor(num(p.contribution)));
    var band = Math.max(0, num(p.band));
    var minTrade = Math.max(0, num(p.minTradeAmount));
    var warnings = [];

    var rows = items.map(function (it) {
      var price = priceOf(prices, it.code);
      var qty = Math.max(0, Math.floor(num(it.qty)));
      return {
        code: it.code, name: it.name || '', weight: num(it.weight), qty: qty,
        price: price, priceMissing: !price, value: price ? qty * price : 0,
        delta: 0, reason: ''
      };
    });
    var holdingsValue = rows.reduce(function (s, r) { return s + r.value; }, 0);
    var total = cashBefore + contribution + holdingsValue;
    var weightSum = rows.reduce(function (s, r) { return s + r.weight; }, 0);
    if (weightSum > 100 + 1e-6) warnings.push('목표비중 합계가 100%를 초과합니다 (' + round2(weightSum) + '%). 100% 이하로 조정하세요.');

    rows.forEach(function (r) {
      r.curWeight = total > 0 ? round2(r.value / total * 100) : 0;
      r.targetValue = Math.round(total * r.weight / 100);
      r.deviation = round2(r.curWeight - r.weight);
      if (r.priceMissing) {
        r.targetQty = r.qty; r.reason = '시세 없음';
        if (r.qty > 0 || r.weight > 0) warnings.push(r.code + ' ' + r.name + ': 시세를 가져오지 못해 거래를 계산하지 않았습니다.');
        return;
      }
      r.targetQty = floorQty(r.targetValue / r.price);
      var ideal = r.targetQty - r.qty;
      if (ideal !== 0 && band > 0 && Math.abs(r.deviation) < band) {
        r.reason = '밴드 이내 (±' + band + '%p)';
      } else if (ideal !== 0 && minTrade > 0 && Math.abs(ideal) * r.price < minTrade) {
        r.reason = '최소 거래금액 미만';
      } else {
        r.delta = ideal;
      }
    });

    // 현금 제약: 매도대금 + 예수금 + 추가투입 범위 안에서만 매수
    var proceeds = 0, wantTotal = 0;
    rows.forEach(function (r) {
      if (r.delta < 0) proceeds += -r.delta * r.price;
      else if (r.delta > 0) wantTotal += r.delta * r.price;
    });
    var budget = cashBefore + contribution + proceeds;
    var scaled = false;
    if (wantTotal > budget + EPS) {
      scaled = true;
      var scale = budget / wantTotal;
      rows.forEach(function (r) { if (r.delta > 0) r.delta = floorQty(r.delta * scale); });
      var remaining = budget - rows.reduce(function (s, r) { return s + (r.delta > 0 ? r.delta * r.price : 0); }, 0);
      for (var guard = 0; guard < 100000; guard++) {
        var best = null, bestGap = -Infinity;
        for (var i = 0; i < rows.length; i++) {
          var r = rows[i];
          if (r.priceMissing || r.delta < 0 || r.reason) continue;
          if (r.qty + r.delta >= r.targetQty || r.price > remaining) continue;
          var gap = r.targetValue - (r.qty + r.delta) * r.price;
          if (gap > bestGap) { best = r; bestGap = gap; }
        }
        if (!best) break;
        best.delta += 1; remaining -= best.price;
      }
      warnings.push('가용 현금이 부족하여 매수 수량을 예산에 맞게 줄였습니다.');
    }

    var buyTotal = 0, sellTotal = 0;
    rows.forEach(function (r) {
      r.action = r.delta > 0 ? 'BUY' : r.delta < 0 ? 'SELL' : 'HOLD';
      r.tradeQty = Math.abs(r.delta);
      r.tradeValue = r.priceMissing ? 0 : r.tradeQty * r.price;
      if (r.delta > 0) buyTotal += r.tradeValue; else if (r.delta < 0) sellTotal += r.tradeValue;
      r.afterQty = r.qty + r.delta;
      r.afterValue = r.priceMissing ? 0 : r.afterQty * r.price;
      r.afterWeight = total > 0 ? round2(r.afterValue / total * 100) : 0;
      r.afterDeviation = round2(r.afterWeight - r.weight);
    });
    var cashAfter = cashBefore + contribution + sellTotal - buyTotal;
    var sells = rows.filter(function (r) { return r.action === 'SELL'; }).sort(function (a, b) { return b.tradeValue - a.tradeValue; });
    var buys = rows.filter(function (r) { return r.action === 'BUY'; }).sort(function (a, b) { return b.tradeValue - a.tradeValue; });
    var maxDev = rows.reduce(function (m, r) { return Math.max(m, Math.abs(r.deviation || 0)); }, 0);

    return {
      total: total, holdingsValue: holdingsValue, cashBefore: cashBefore, contribution: contribution,
      cashAfter: cashAfter, sellTotal: sellTotal, buyTotal: buyTotal, budgetScaled: scaled,
      weightSum: round2(weightSum), cashWeight: round2(100 - weightSum),
      cashWeightNow: total > 0 ? round2(cashBefore / total * 100) : 0,
      cashWeightAfter: total > 0 ? round2(cashAfter / total * 100) : 0,
      maxDeviation: round2(maxDev),
      rows: rows, sells: sells, buys: buys,
      tradeCount: sells.length + buys.length,
      needsRebalance: sells.length + buys.length > 0,
      warnings: warnings
    };
  }

  /** 계획대로 체결됐다고 가정하고 포트폴리오 보유수량/예수금 갱신본을 반환 (원본 불변) */
  function applyPlan(portfolio, plan) {
    var deltaByCode = {};
    plan.rows.forEach(function (r) { deltaByCode[r.code] = r.delta || 0; });
    var items = (portfolio.items || []).map(function (it) {
      var d = deltaByCode[it.code] || 0;
      return Object.assign({}, it, { qty: Math.max(0, num(it.qty) + d) });
    });
    return Object.assign({}, portfolio, { items: items, cash: Math.max(0, Math.round(plan.cashAfter)) });
  }

  /** 마지막 리밸런싱 이후 경과일 (없으면 null) */
  function daysSince(iso, now) {
    if (!iso) return null;
    var t = new Date(iso).getTime();
    if (!isFinite(t)) return null;
    return Math.floor(((now || Date.now()) - t) / 86400000);
  }

  return { planInvest: planInvest, planRebalance: planRebalance, applyPlan: applyPlan, daysSince: daysSince };
});
