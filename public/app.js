/* 연금 ETF 리밸런서 — 프론트엔드 */
(function () {
  'use strict';
  var R = window.Rebalance;
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  // ------------------------------------------------------------ 포맷
  function fmtNum(n, d) {
    if (n === null || n === undefined || !isFinite(n)) return '-';
    return Number(n).toLocaleString('ko-KR', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 });
  }
  function fmtKRW(n) { return n === null || n === undefined || !isFinite(n) ? '-' : fmtNum(Math.round(n)) + '원'; }
  function fmtPct(n, d) { return n === null || n === undefined || !isFinite(n) ? '-' : Number(n).toFixed(d === undefined ? 2 : d) + '%'; }
  function fmtSignedPct(n, d) { if (n === null || n === undefined || !isFinite(n)) return '-'; var s = n > 0 ? '+' : ''; return s + Number(n).toFixed(d === undefined ? 2 : d) + '%p'; }
  function fmtDate(iso) { if (!iso) return '-'; var d = new Date(iso); return isNaN(d) ? '-' : d.toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' }); }
  function fmtDateTime(ts) { if (!ts) return '-'; var d = new Date(ts); return isNaN(d) ? '-' : d.toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function clsSign(n) { return n > 0 ? 'pos' : n < 0 ? 'neg' : ''; }

  // ------------------------------------------------------------ 상태
  var state = {
    status: null, portfolio: null, prices: {}, priceErrors: {}, pricesAt: null, mock: false,
    dirty: false, plan: null, investPlan: null, balance: null, searchTimer: null, loading: false
  };

  async function api(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || 'GET', headers: { 'content-type': 'application/json' } };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    var res = await fetch(path, init);
    var data = {};
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }

  function toast(msg, type, ms) {
    var el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(function () { el.remove(); }, ms || (type === 'error' ? 8000 : 4500));
  }
  function setLoading(on) { state.loading = on; document.body.classList.toggle('loading', on); }
  function setDirty(on) {
    state.dirty = on;
    $('#dirtyHint').textContent = on ? '저장되지 않은 변경사항이 있습니다' : '';
  }

  // ------------------------------------------------------------ 시세
  async function loadPrices(fresh) {
    var codes = state.portfolio.items.map(function (i) { return i.code; });
    if (!codes.length) return;
    setLoading(true);
    try {
      var r = await api('/api/prices?codes=' + codes.join(',') + (fresh ? '&fresh=1' : ''));
      state.prices = r.prices || {};
      state.priceErrors = r.errors || {};
      state.pricesAt = r.fetchedAt;
      state.mock = !!r.mock;
      state.portfolio.lastPrices = state.portfolio.lastPrices || {};
      Object.keys(state.prices).forEach(function (code) {
        var q = state.prices[code];
        if (q && q.price > 0) state.portfolio.lastPrices[code] = { price: q.price, name: q.name, fetchedAt: q.fetchedAt };
        var it = state.portfolio.items.find(function (i) { return i.code === code; });
        if (it && !it.name && q && q.name) it.name = q.name;
      });
      var errs = Object.keys(state.priceErrors);
      if (errs.length) toast('시세 조회 실패: ' + errs.map(function (c) { return c + ' (' + state.priceErrors[c] + ')'; }).join(' / '), 'warn', 8000);
    } catch (e) {
      toast('시세 조회 실패: ' + e.message, 'error');
    } finally {
      setLoading(false);
    }
  }

  /** 실시간 시세 우선, 없으면 마지막 저장 시세(오래된 시세 표시) */
  function effectivePrices() {
    var prices = {}, stale = {};
    state.portfolio.items.forEach(function (it) {
      var q = state.prices[it.code];
      var last = (state.portfolio.lastPrices || {})[it.code];
      if (q && q.price > 0) prices[it.code] = q.price;
      else if (last && last.price > 0) { prices[it.code] = last.price; stale[it.code] = last.fetchedAt; }
    });
    return { prices: prices, stale: stale };
  }

  function hasHoldings() {
    var p = state.portfolio;
    return p.items.some(function (i) { return i.qty > 0; }) || p.cash > 0;
  }

  // ------------------------------------------------------------ 렌더: 헤더/공지
  function renderHeader() {
    var p = state.portfolio, s = state.status || {};
    $('#pfName').textContent = p.name || '연금 ETF 리밸런서';
    document.title = (p.name || '연금 ETF 리밸런서') + ' · 리밸런서';
    var chip = $('#sourceChip');
    if (s.error) { chip.className = 'chip chip-mock'; chip.textContent = '서버 상태 확인 실패'; return; }
    if (s.mock) { chip.className = 'chip chip-mock'; chip.textContent = '모의 시세 (종목마스터 전일종가)'; chip.title = 'API 키가 없거나 PRICE_SOURCE=mock 입니다. .env 에 앱키/시크릿을 설정하면 실시간 시세로 전환됩니다.'; }
    else { chip.className = 'chip chip-live'; chip.textContent = 'NH Plug 실시간 시세'; chip.title = s.baseUrl || ''; }
  }

  function renderNotice() {
    var p = state.portfolio, el = $('#notice');
    if (!p.items.length) { el.hidden = true; return; }
    el.hidden = false;
    var days = R.daysSince(p.lastRebalancedAt);
    var cycle = p.settings.cycleDays || 30;
    if (days === null) {
      el.className = 'notice none';
      el.textContent = hasHoldings() ? '아직 리밸런싱 기록이 없습니다. 접속 시 현재 시세 기준으로 리밸런싱 제안을 확인하세요.' : '보유수량이 없습니다. "신규 투입 계산" 탭에서 첫 매수 수량을 계산하거나, 설정에서 보유수량을 입력하세요.';
      return;
    }
    var next = new Date(new Date(p.lastRebalancedAt).getTime() + cycle * 86400000);
    var due = days >= cycle;
    el.className = 'notice' + (due ? ' due' : '');
    el.textContent = (due ? '⏰ 리밸런싱 시점입니다 — ' : '✅ ') + '마지막 리밸런싱 ' + fmtDate(p.lastRebalancedAt) + ' (' + days + '일 전) · 다음 예정 ' + fmtDate(next.toISOString()) + (due ? ' (경과)' : '');
  }

  // ------------------------------------------------------------ 렌더: 대시보드
  function currentPlan(contribution) {
    var ep = effectivePrices();
    var s = state.portfolio.settings;
    var plan = R.planRebalance({
      items: state.portfolio.items, cash: state.portfolio.cash, contribution: contribution || 0,
      prices: ep.prices, band: s.band, minTradeAmount: s.minTradeAmount
    });
    plan.stale = ep.stale;
    return plan;
  }

  function renderDashboard() {
    var p = state.portfolio;
    var empty = !p.items.length;
    $('#dashEmpty').hidden = !empty;
    $('#dashBody').hidden = empty;
    if (empty) return;
    var contribution = Number($('#dashContribution').value) || 0;
    var plan = currentPlan(contribution);
    state.plan = plan;

    $('#cTotal').textContent = fmtKRW(plan.total);
    $('#cHoldings').textContent = fmtKRW(plan.holdingsValue);
    $('#cCash').textContent = fmtKRW(p.cash);
    $('#cCashW').textContent = '현금 비중 ' + fmtPct(plan.cashWeightNow, 1) + (plan.cashWeight > 0 ? ' (목표 ' + fmtPct(plan.cashWeight, 1) + ')' : '');
    $('#cMaxDev').textContent = fmtSignedPct(plan.maxDeviation, 2).replace('+', '±');
    $('#cBand').textContent = p.settings.band > 0 ? '리밸런싱 밴드 ±' + p.settings.band + '%p' : '밴드 없음 (항상 목표비중으로)';

    var tb = $('#holdTable tbody');
    tb.innerHTML = plan.rows.map(function (r) {
      var q = state.prices[r.code] || {};
      var chg = q.changeRate;
      var priceHtml = r.priceMissing ? '<span class="stale">시세 없음</span>'
        : fmtNum(r.price) + (chg !== undefined && chg !== null ? ' <small class="' + (chg > 0 ? 'up' : chg < 0 ? 'down' : '') + '">' + (chg > 0 ? '▲' : chg < 0 ? '▼' : '') + Math.abs(chg).toFixed(2) + '%</small>' : '')
          + (plan.stale[r.code] ? ' <div class="stale">이전 시세 (' + fmtDateTime(plan.stale[r.code]) + ')</div>' : '');
      var dev = r.deviation || 0;
      var barW = Math.min(60, Math.abs(dev) * 6);
      var devHtml = '<span class="' + clsSign(dev) + '">' + fmtSignedPct(dev) + '</span>' + (barW > 0 ? '<span class="dev-bar ' + (dev > 0 ? 'over' : 'under') + '" style="width:' + barW + 'px"></span>' : '');
      var sug = r.action === 'BUY' ? '<span class="badge badge-buy">매수 ' + fmtNum(r.tradeQty) + '주</span>'
        : r.action === 'SELL' ? '<span class="badge badge-sell">매도 ' + fmtNum(r.tradeQty) + '주</span>'
          : '<span class="badge badge-hold">' + (r.reason ? esc(r.reason) : '유지') + '</span>';
      return '<tr>' +
        '<td><div class="name-cell"><span>' + esc(r.name || r.code) + '</span><span class="code">' + esc(r.code) + (q.nav ? ' · NAV ' + fmtNum(q.nav, 0) + (q.dprt !== null && q.dprt !== undefined ? ' · 괴리율 ' + q.dprt.toFixed(2) + '%' : '') : '') + '</span></div></td>' +
        '<td class="num">' + priceHtml + '</td>' +
        '<td class="num">' + fmtNum(r.qty) + '</td>' +
        '<td class="num">' + fmtNum(r.value) + '</td>' +
        '<td class="num">' + fmtPct(r.curWeight) + '</td>' +
        '<td class="num">' + fmtPct(r.weight) + '</td>' +
        '<td class="num">' + devHtml + '</td>' +
        '<td class="num">' + sug + '</td></tr>';
    }).join('');
    var wsum = plan.rows.reduce(function (s, r) { return s + r.curWeight; }, 0);
    $('#holdTable tfoot').innerHTML = '<tr><td>합계</td><td></td><td></td><td class="num">' + fmtNum(plan.holdingsValue) + '</td><td class="num">' + fmtPct(wsum) + '</td><td class="num">' + fmtPct(plan.weightSum) + '</td><td></td><td class="num">' + (plan.tradeCount ? plan.tradeCount + '건' : '-') + '</td></tr>';
    $('#pricesAt').textContent = state.pricesAt ? '시세 조회 ' + fmtDateTime(state.pricesAt) + (state.mock ? ' (모의)' : '') : '';
    renderHistory();
  }

  function renderHistory() {
    var h = (state.portfolio.history || []).slice().reverse().slice(0, 20);
    $('#historyList').innerHTML = h.length ? h.map(function (x) {
      var trades = (x.trades || []).map(function (t) { return (t.action === 'BUY' ? '매수 ' : '매도 ') + (t.name || t.code) + ' ' + fmtNum(t.qty) + '주'; }).join(', ');
      return '<div class="history-item"><span class="when">' + fmtDateTime(x.at) + '</span> · ' + (x.type === 'invest' ? '신규 투입 ' + fmtKRW(x.amount) : '리밸런싱' + (x.contribution ? ' (+' + fmtKRW(x.contribution) + ' 투입)' : '')) +
        ' · 총자산 ' + fmtKRW(x.total) + '<div class="trades">' + (trades ? esc(trades) : '거래 없음') + '</div></div>';
    }).join('') : '<div class="hint">기록이 없습니다.</div>';
  }

  // ------------------------------------------------------------ 렌더: 신규 투입
  function renderInvest() {
    var p = state.portfolio;
    var amount = Number($('#investAmount').value) || 0;
    var fill = $('#investFill').checked;
    var tb = $('#investTable tbody'), tf = $('#investTable tfoot');
    if (!p.items.length) { tb.innerHTML = '<tr><td colspan="7" class="hint">설정 탭에서 ETF를 먼저 등록하세요.</td></tr>'; tf.innerHTML = ''; $('#btnInvestApply').disabled = true; return; }
    var ep = effectivePrices();
    var plan = R.planInvest(p.items, ep.prices, amount, { fillLeftover: fill });
    state.investPlan = plan;
    tb.innerHTML = plan.rows.map(function (r) {
      return '<tr><td><div class="name-cell"><span>' + esc(r.name || r.code) + '</span><span class="code">' + esc(r.code) + '</span></div></td>' +
        '<td class="num">' + fmtPct(r.weight) + '</td>' +
        '<td class="num">' + (r.priceMissing ? '<span class="stale">시세 없음</span>' : fmtNum(r.price) + (ep.stale[r.code] ? ' <span class="stale">(이전)</span>' : '')) + '</td>' +
        '<td class="num">' + fmtNum(r.targetValue) + '</td>' +
        '<td class="num qty-big">' + (r.qty ? fmtNum(r.qty) + '주' : '-') + '</td>' +
        '<td class="num">' + fmtNum(r.cost) + '</td>' +
        '<td class="num">' + fmtPct(r.actualWeight) + '</td></tr>';
    }).join('');
    tf.innerHTML = '<tr><td>합계</td><td class="num">' + fmtPct(plan.weightSum) + '</td><td></td><td class="num">' + fmtNum(amount) + '</td><td class="num">' + fmtNum(plan.rows.reduce(function (s, r) { return s + r.qty; }, 0)) + '주</td><td class="num">' + fmtNum(plan.invested) + '</td><td class="num">' + fmtPct(amount ? plan.invested / amount * 100 : 0) + '</td></tr>' +
      '<tr><td colspan="5">잔여 현금 (예수금으로 남음)</td><td class="num" colspan="2">' + fmtKRW(plan.leftover) + '</td></tr>';
    $('#investWarnings').innerHTML = plan.warnings.map(function (w) { return '<div class="warn-item">' + esc(w) + '</div>'; }).join('');
    $('#btnInvestApply').disabled = !(amount > 0 && plan.invested > 0);
  }

  function applyInvest() {
    var plan = state.investPlan;
    if (!plan || !plan.invested) return;
    if (!confirm('매수 수량 ' + plan.rows.reduce(function (s, r) { return s + r.qty; }, 0) + '주(' + fmtKRW(plan.invested) + ')를 보유수량에 더하고, 잔여 현금 ' + fmtKRW(plan.leftover) + '을 예수금에 더합니다. 계속할까요?')) return;
    var p = state.portfolio;
    plan.rows.forEach(function (r) {
      var it = p.items.find(function (i) { return i.code === r.code; });
      if (it) it.qty = (it.qty || 0) + r.qty;
    });
    p.cash = Math.round((p.cash || 0) + plan.leftover);
    p.history = p.history || [];
    p.history.push({ at: new Date().toISOString(), type: 'invest', amount: plan.amount, total: plan.amount, cashAfter: p.cash,
      trades: plan.rows.filter(function (r) { return r.qty > 0; }).map(function (r) { return { action: 'BUY', code: r.code, name: r.name, qty: r.qty, price: r.price }; }) });
    if (!p.lastRebalancedAt) p.lastRebalancedAt = new Date().toISOString();
    savePortfolio().then(function () {
      $('#investAmount').value = '';
      renderAll();
      switchTab('dashboard');
      toast('보유수량에 반영했습니다.', 'ok');
    });
  }

  // ------------------------------------------------------------ 렌더: 설정
  function renderSettings() {
    var p = state.portfolio, s = p.settings;
    $('#pfNameInput').value = p.name || '';
    $('#cash').value = p.cash || 0;
    $('#setBand').value = s.band;
    $('#setMinTrade').value = s.minTradeAmount;
    $('#setCycle').value = s.cycleDays;
    $('#setAutoPopup').checked = s.autoPopup !== false;
    if (s.account) {
      var sel = $('#accountSelect');
      if (!Array.prototype.some.call(sel.options, function (o) { return o.value === s.account; })) {
        var o = document.createElement('option'); o.value = s.account; o.textContent = s.account; sel.appendChild(o);
      }
      sel.value = s.account;
    }
    renderItemsEditor();
    renderStatusBox();
  }

  function renderItemsEditor() {
    var p = state.portfolio;
    var tb = $('#itemsTable tbody');
    tb.innerHTML = p.items.length ? p.items.map(function (it, idx) {
      return '<tr data-idx="' + idx + '">' +
        '<td><code>' + esc(it.code) + '</code></td>' +
        '<td><input class="wide" data-f="name" value="' + esc(it.name) + '" placeholder="종목명"></td>' +
        '<td class="num"><input type="number" data-f="weight" min="0" max="100" step="0.5" value="' + esc(it.weight) + '"></td>' +
        '<td class="num"><input type="number" data-f="qty" min="0" step="1" value="' + esc(it.qty) + '"></td>' +
        '<td><button class="btn-x" data-del="' + idx + '" title="삭제">×</button></td></tr>';
    }).join('') : '<tr><td colspan="5" class="hint">위 검색창에서 ETF를 찾아 추가하세요.</td></tr>';
    var sum = p.items.reduce(function (s, it) { return s + (Number(it.weight) || 0); }, 0);
    var bad = sum > 100.0001;
    $('#itemsTable tfoot').innerHTML = '<tr><td colspan="2">합계</td><td class="num weight-sum' + (bad ? ' bad' : '') + '">' + sum.toFixed(1) + '%' + (bad ? ' (100% 초과!)' : sum < 99.999 ? ' <small>(현금 ' + (100 - sum).toFixed(1) + '%)</small>' : '') + '</td><td></td><td></td></tr>';
  }

  function renderStatusBox() {
    var s = state.status || {};
    if (s.error) { $('#statusBox').innerHTML = '<span class="stale">서버 상태 조회 실패: ' + esc(s.error) + '</span>'; return; }
    var tok = s.token || {};
    $('#statusBox').innerHTML =
      '<div>API 키: <b>' + (s.configured ? '설정됨' : '미설정 (.env 의 NHPLUG_APP_KEY / NHPLUG_APP_SECRET)') + '</b></div>' +
      '<div>시세 소스: <b>' + (s.mock ? '모의 (종목마스터 전일종가)' : 'NH Plug 실시간 · ' + esc(s.baseUrl)) + '</b></div>' +
      '<div>접근토큰: <b>' + (tok.cached ? (tok.valid ? '유효 (만료 ' + fmtDateTime(tok.expiresAt) + ')' : '만료됨 — 다음 호출 시 재발급') : '없음 — 첫 호출 시 발급') + '</b></div>' +
      '<div>종목마스터: <b>' + (s.master && s.master.records ? fmtNum(s.master.records) + '종목 (ETF ' + fmtNum(s.master.etfs) + ') · 갱신 ' + fmtDateTime(s.master.updatedAt) : '미로드') + '</b>' + (s.master && s.master.error ? ' <span class="stale">' + esc(s.master.error) + '</span>' : '') + '</div>';
  }

  function readSettingsForm() {
    var p = state.portfolio;
    p.name = $('#pfNameInput').value.trim() || p.name;
    p.cash = Math.max(0, Math.floor(Number($('#cash').value) || 0));
    p.settings.band = Math.max(0, Number($('#setBand').value) || 0);
    p.settings.minTradeAmount = Math.max(0, Math.floor(Number($('#setMinTrade').value) || 0));
    p.settings.cycleDays = Math.max(1, Math.floor(Number($('#setCycle').value) || 30));
    p.settings.autoPopup = $('#setAutoPopup').checked;
    p.settings.account = $('#accountSelect').value || p.settings.account || '';
    $$('#itemsTable tbody tr[data-idx]').forEach(function (tr) {
      var it = p.items[Number(tr.dataset.idx)];
      if (!it) return;
      $$('input[data-f]', tr).forEach(function (inp) {
        var f = inp.dataset.f;
        if (f === 'name') it.name = inp.value.trim();
        else if (f === 'weight') it.weight = Math.max(0, Number(inp.value) || 0);
        else if (f === 'qty') it.qty = Math.max(0, Math.floor(Number(inp.value) || 0));
      });
    });
  }

  async function savePortfolio() {
    var saved = await api('/api/portfolio', { method: 'PUT', body: state.portfolio });
    state.portfolio = saved;
    setDirty(false);
    return saved;
  }

  async function onSave() {
    readSettingsForm();
    var sum = state.portfolio.items.reduce(function (s, it) { return s + it.weight; }, 0);
    if (sum > 100.0001) { toast('목표비중 합계가 100%를 초과합니다 (' + sum.toFixed(1) + '%)', 'error'); return; }
    try {
      var before = JSON.stringify(state.portfolio.items.map(function (i) { return i.code; }));
      await savePortfolio();
      toast('저장했습니다.', 'ok');
      var after = JSON.stringify(state.portfolio.items.map(function (i) { return i.code; }));
      if (before !== after || Object.keys(state.prices).length === 0) await loadPrices();
      renderAll();
    } catch (e) {
      toast('저장 실패: ' + e.message, 'error');
    }
  }

  async function onReload() {
    state.portfolio = await api('/api/portfolio');
    setDirty(false);
    renderAll();
    toast('변경사항을 취소했습니다.');
  }

  // ------------------------------------------------------------ ETF 검색
  function onSearchInput() {
    clearTimeout(state.searchTimer);
    var q = $('#etfSearch').value.trim();
    var box = $('#etfResults');
    if (q.length < 1) { box.hidden = true; return; }
    state.searchTimer = setTimeout(async function () {
      try {
        var r = await api('/api/etf/search?q=' + encodeURIComponent(q) + '&types=ETF,ETN&limit=25');
        var list = r.results || [];
        box.innerHTML = list.length ? list.map(function (m) {
          var exists = state.portfolio.items.some(function (i) { return i.code === m.code; });
          return '<div class="search-item" data-code="' + esc(m.code) + '" data-name="' + esc(m.name) + '">' +
            '<span>' + esc(m.name) + ' <span class="code">' + esc(m.code) + '</span></span>' +
            '<span class="meta">' + esc(m.type) + ' · ' + esc(m.market) + (m.prevClose ? ' · 전일 ' + fmtNum(m.prevClose) : '') + (exists ? ' · 추가됨' : '') + '</span></div>';
        }).join('') : '<div class="search-item"><span class="meta">검색 결과 없음</span></div>';
        box.hidden = false;
      } catch (e) {
        box.innerHTML = '<div class="search-item"><span class="meta">검색 실패: ' + esc(e.message) + '</span></div>';
        box.hidden = false;
      }
    }, 180);
  }

  function addItem(code, name) {
    readSettingsForm();
    var p = state.portfolio;
    if (p.items.some(function (i) { return i.code === code; })) { toast('이미 추가된 종목입니다.', 'warn'); return; }
    p.items.push({ code: code, name: name || '', weight: 0, qty: 0 });
    setDirty(true);
    renderItemsEditor();
    $('#etfSearch').value = '';
    $('#etfResults').hidden = true;
    var lastWeight = $$('#itemsTable input[data-f="weight"]').pop();
    if (lastWeight) lastWeight.focus();
  }

  function removeItem(idx) {
    readSettingsForm();
    var it = state.portfolio.items[idx];
    if (!it) return;
    if (it.qty > 0 && !confirm(it.name + ' (' + it.code + ') 은 보유수량이 ' + it.qty + '주 입니다. 목록에서 제거할까요?')) return;
    state.portfolio.items.splice(idx, 1);
    setDirty(true);
    renderItemsEditor();
  }

  // ------------------------------------------------------------ 계좌 잔고
  async function onAccounts() {
    try {
      var r = await api('/api/accounts');
      var sel = $('#accountSelect');
      sel.innerHTML = '<option value="">계좌 선택</option>' + (r.accounts || []).map(function (a) {
        var t = a.acct_type === '03' ? '모의투자' : a.acct_type === '02' ? '운영(주문대리인)' : '운영';
        return '<option value="' + esc(a.acct_no) + '">' + esc(a.acct_no) + ' (' + t + ')</option>';
      }).join('');
      if (!(r.accounts || []).length) toast('조회된 계좌가 없습니다.', 'warn');
      else if (state.portfolio.settings.account) sel.value = state.portfolio.settings.account;
    } catch (e) { toast('계좌 목록 조회 실패: ' + e.message, 'error'); }
  }

  async function onBalance() {
    var actNo = $('#accountSelect').value;
    if (!actNo) { toast('계좌를 먼저 선택하세요.', 'warn'); return; }
    var box = $('#balancePreview');
    box.hidden = false; box.innerHTML = '<span class="hint">잔고 조회 중…</span>';
    try {
      var b = await api('/api/balance?act_no=' + encodeURIComponent(actNo));
      state.balance = b;
      var rows = (b.positions || []).map(function (pos) {
        var it = state.portfolio.items.find(function (i) { return i.code === pos.code; });
        var status = it ? (it.qty === pos.qty ? '동일' : '보유수량 ' + fmtNum(it.qty) + ' → ' + fmtNum(pos.qty)) : (pos.type === 'ETF' || pos.type === 'ETN' ? '미등록 → 비중 0%로 추가' : '미등록 (ETF 아님, 제외)');
        return '<tr><td>' + esc(pos.name || pos.code) + ' <span class="code">' + esc(pos.code) + '</span></td><td class="num">' + fmtNum(pos.qty) + '</td><td class="num">' + fmtNum(pos.value) + '</td><td>' + status + '</td></tr>';
      }).join('');
      box.innerHTML = '<div>예수금(주문가능): <b>' + fmtKRW(b.cash) + '</b>' + (b.netAsset ? ' · 순자산 ' + fmtKRW(b.netAsset) : '') + ' · 조회 ' + fmtDateTime(b.fetchedAt) + '</div>' +
        '<table><thead><tr><th>종목</th><th class="num">수량</th><th class="num">평가금액</th><th>반영</th></tr></thead><tbody>' + (rows || '<tr><td colspan="4">보유종목 없음</td></tr>') + '</tbody></table>' +
        '<div class="row"><button class="btn btn-primary" id="btnBalanceApply">보유수량·예수금에 반영</button><small>반영 후 "저장"을 눌러야 확정됩니다.</small></div>';
      $('#btnBalanceApply').addEventListener('click', applyBalance);
    } catch (e) {
      box.innerHTML = '<span class="stale">잔고 조회 실패: ' + esc(e.message) + '</span>';
    }
  }

  function applyBalance() {
    var b = state.balance; if (!b) return;
    readSettingsForm();
    var p = state.portfolio;
    (b.positions || []).forEach(function (pos) {
      var it = p.items.find(function (i) { return i.code === pos.code; });
      if (it) it.qty = Math.floor(pos.qty);
      else if (pos.type === 'ETF' || pos.type === 'ETN') p.items.push({ code: pos.code, name: pos.name || '', weight: 0, qty: Math.floor(pos.qty) });
    });
    p.items.forEach(function (it) { if (!(b.positions || []).some(function (pos) { return pos.code === it.code; })) it.qty = 0; });
    p.cash = Math.max(0, Math.floor(b.cash || 0));
    p.settings.account = b.account || p.settings.account;
    setDirty(true);
    renderSettings();
    toast('잔고를 반영했습니다. 목표비중을 확인한 뒤 저장하세요.', 'ok');
  }

  // ------------------------------------------------------------ 리밸런싱 팝업
  function openModal(contribution) {
    var c = contribution !== undefined ? contribution : (Number($('#dashContribution').value) || 0);
    $('#modalContribution').value = c || '';
    renderModal();
    $('#modal').hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function closeModal() { $('#modal').hidden = true; document.body.style.overflow = ''; }

  function renderModal() {
    var c = Number($('#modalContribution').value) || 0;
    var plan = currentPlan(c);
    state.plan = plan;
    var p = state.portfolio;
    var html = '<div class="plan-meta">' + (state.pricesAt ? '시세 기준 ' + fmtDateTime(state.pricesAt) + (state.mock ? ' · <b>모의 시세</b>' : ' · NH Plug 실시간') : '시세 없음') +
      (p.settings.band > 0 ? ' · 밴드 ±' + p.settings.band + '%p' : '') + (p.settings.minTradeAmount > 0 ? ' · 최소거래 ' + fmtKRW(p.settings.minTradeAmount) : '') + '</div>';
    html += '<div class="plan-summary">' +
      '<div class="card"><div class="card-label">총자산' + (c ? ' (투입 포함)' : '') + '</div><div class="card-value">' + fmtKRW(plan.total) + '</div></div>' +
      '<div class="card"><div class="card-label">예수금 현재 → 거래 후</div><div class="card-value">' + fmtKRW(plan.cashBefore + plan.contribution) + ' → ' + fmtKRW(plan.cashAfter) + '</div></div>' +
      '<div class="card"><div class="card-label">매도 합계</div><div class="card-value ' + (plan.sellTotal ? 'pos' : '') + '">' + fmtKRW(plan.sellTotal) + '</div></div>' +
      '<div class="card"><div class="card-label">매수 합계</div><div class="card-value ' + (plan.buyTotal ? 'neg' : '') + '">' + fmtKRW(plan.buyTotal) + '</div></div></div>';

    if (!plan.tradeCount) {
      html += '<div class="plan-ok">✅ 현재 비중이 목표비중과 맞습니다. 이번에는 거래가 필요 없습니다.</div>';
    } else {
      html += renderTradeTable('1단계 · 매도', 'badge-sell', plan.sells, '매도');
      html += renderTradeTable('2단계 · 매수', 'badge-buy', plan.buys, '매수');
      html += '<p class="hint">매도 체결 대금이 들어온 뒤 매수하세요. 수량은 현재가 기준으로 계산되며, 실제 체결가에 따라 잔여 현금이 달라질 수 있습니다.</p>';
    }
    var holds = plan.rows.filter(function (r) { return r.action === 'HOLD'; });
    if (holds.length) {
      html += '<div class="plan-section"><h3>유지</h3><div class="hint">' + holds.map(function (r) { return esc(r.name || r.code) + ' ' + fmtNum(r.qty) + '주 (' + fmtPct(r.curWeight, 1) + ' / 목표 ' + fmtPct(r.weight, 1) + ')' + (r.reason ? ' — ' + esc(r.reason) : ''); }).join('<br>') + '</div></div>';
    }
    if (plan.warnings.length) html += '<div class="warnings">' + plan.warnings.map(function (w) { return '<div class="warn-item">' + esc(w) + '</div>'; }).join('') + '</div>';
    $('#modalBody').innerHTML = html;
    $('#btnApplyPlan').disabled = !plan.tradeCount && !plan.contribution;
  }

  function renderTradeTable(title, badgeCls, rows, verb) {
    if (!rows.length) return '<div class="plan-section"><h3>' + title + ' <span class="badge ' + badgeCls + '">없음</span></h3></div>';
    var sum = rows.reduce(function (s, r) { return s + r.tradeValue; }, 0);
    return '<div class="plan-section"><h3>' + title + ' <span class="badge ' + badgeCls + '">' + rows.length + '종목 · ' + fmtKRW(sum) + '</span></h3>' +
      '<div class="table-wrap"><table class="grid"><thead><tr><th>종목</th><th class="num">현재가</th><th class="num">' + verb + ' 수량</th><th class="num">' + verb + ' 금액</th><th class="num">보유수량</th><th class="num">비중 현재 → 거래 후 (목표)</th></tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr><td><div class="name-cell"><span>' + esc(r.name || r.code) + '</span><span class="code">' + esc(r.code) + '</span></div></td>' +
          '<td class="num">' + fmtNum(r.price) + '</td>' +
          '<td class="num qty-big ' + (r.action === 'BUY' ? 'neg' : 'pos') + '">' + verb + ' ' + fmtNum(r.tradeQty) + '주</td>' +
          '<td class="num">' + fmtNum(r.tradeValue) + '</td>' +
          '<td class="num">' + fmtNum(r.qty) + ' → ' + fmtNum(r.afterQty) + '</td>' +
          '<td class="num">' + fmtPct(r.curWeight, 1) + ' → ' + fmtPct(r.afterWeight, 1) + ' (' + fmtPct(r.weight, 1) + ')</td></tr>';
      }).join('') + '</tbody></table></div></div>';
  }

  async function applyPlan() {
    var plan = state.plan; if (!plan) return;
    var msg = plan.tradeCount ? '매도 ' + plan.sells.length + '종목 / 매수 ' + plan.buys.length + '종목을 체결한 것으로 보유수량과 예수금(' + fmtKRW(plan.cashAfter) + ')을 갱신하고, 오늘을 리밸런싱일로 기록합니다. 계속할까요?'
      : '거래 없이 오늘을 리밸런싱일로 기록' + (plan.contribution ? '하고 투입금 ' + fmtKRW(plan.contribution) + '을 예수금에 더' : '') + '합니다. 계속할까요?';
    if (!confirm(msg)) return;
    var next = R.applyPlan(state.portfolio, plan);
    next.lastRebalancedAt = new Date().toISOString();
    next.history = (next.history || []).concat([{
      at: next.lastRebalancedAt, type: 'rebalance', total: plan.total, contribution: plan.contribution, cashAfter: plan.cashAfter,
      trades: plan.sells.concat(plan.buys).map(function (r) { return { action: r.action, code: r.code, name: r.name, qty: r.tradeQty, price: r.price }; })
    }]);
    state.portfolio = next;
    try {
      await savePortfolio();
      closeModal();
      $('#dashContribution').value = '';
      renderAll();
      toast('리밸런싱을 기록하고 보유수량을 갱신했습니다.', 'ok');
    } catch (e) { toast('저장 실패: ' + e.message, 'error'); }
  }

  function maybeAutoPopup() {
    var p = state.portfolio;
    if (!p.settings.autoPopup || !p.items.length || !hasHoldings()) return;
    openModal(0);
  }

  // ------------------------------------------------------------ 캘린더 (.ics)
  function downloadIcs() {
    var p = state.portfolio;
    var cycle = p.settings.cycleDays || 30;
    var base = p.lastRebalancedAt ? new Date(p.lastRebalancedAt) : new Date();
    var start = new Date(base.getTime() + (p.lastRebalancedAt ? cycle * 86400000 : 0));
    if (start < new Date()) start = new Date();
    start.setHours(9, 0, 0, 0);
    var pad = function (n) { return String(n).padStart(2, '0'); };
    var dt = function (d) { return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + 'T' + pad(d.getHours()) + pad(d.getMinutes()) + '00'; };
    var rrule = cycle % 30 === 0 || cycle === 31 ? 'FREQ=MONTHLY;INTERVAL=' + Math.max(1, Math.round(cycle / 30)) : 'FREQ=DAILY;INTERVAL=' + cycle;
    var ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//pension-etf-rebalancer//KO', 'BEGIN:VEVENT',
      'UID:' + Date.now() + '@pension-etf-rebalancer', 'DTSTAMP:' + dt(new Date()) + 'Z',
      'DTSTART;TZID=Asia/Seoul:' + dt(start), 'DURATION:PT30M', 'RRULE:' + rrule,
      'SUMMARY:' + (p.name || '연금 ETF') + ' 리밸런싱', 'DESCRIPTION:리밸런서 앱에 접속해 실시간 시세 기준 매수/매도 수량을 확인하세요. ' + location.origin,
      'BEGIN:VALARM', 'TRIGGER:-PT0M', 'ACTION:DISPLAY', 'DESCRIPTION:연금 ETF 리밸런싱', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
    a.download = 'rebalance-reminder.ics';
    document.body.appendChild(a); a.click(); a.remove();
  }

  // ------------------------------------------------------------ 탭/이벤트
  function switchTab(name) {
    $$('.tab').forEach(function (t) { t.classList.toggle('active', t.dataset.tab === name); });
    $$('.tabpane').forEach(function (p) { p.classList.toggle('active', p.id === 'tab-' + name); });
    if (name === 'invest') renderInvest();
  }

  function renderAll() {
    renderHeader();
    renderNotice();
    renderDashboard();
    renderInvest();
    renderSettings();
  }

  function bindEvents() {
    $$('.tab').forEach(function (t) { t.addEventListener('click', function () { switchTab(t.dataset.tab); }); });
    document.addEventListener('click', function (e) {
      var g = e.target.closest('[data-goto]'); if (g) switchTab(g.dataset.goto);
      var del = e.target.closest('[data-del]'); if (del) removeItem(Number(del.dataset.del));
      var si = e.target.closest('.search-item[data-code]'); if (si) addItem(si.dataset.code, si.dataset.name);
      if (!e.target.closest('.search')) $('#etfResults').hidden = true;
      if (e.target.closest('[data-close]')) closeModal();
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });
    $('#btnRefresh').addEventListener('click', async function () { await loadPrices(true); renderAll(); if (!$('#modal').hidden) renderModal(); toast('시세를 갱신했습니다.'); });
    $('#btnPlan').addEventListener('click', function () { openModal(); });
    $('#dashContribution').addEventListener('input', renderDashboard);
    $('#modalContribution').addEventListener('input', renderModal);
    $('#btnApplyPlan').addEventListener('click', applyPlan);
    $('#investAmount').addEventListener('input', renderInvest);
    $('#investFill').addEventListener('change', renderInvest);
    $('#btnInvestApply').addEventListener('click', applyInvest);
    $('#etfSearch').addEventListener('input', onSearchInput);
    $('#etfSearch').addEventListener('focus', function () { if ($('#etfResults').innerHTML && $('#etfSearch').value) $('#etfResults').hidden = false; });
    $('#btnSave').addEventListener('click', onSave);
    $('#btnReload').addEventListener('click', onReload);
    $('#btnAccounts').addEventListener('click', onAccounts);
    $('#btnBalance').addEventListener('click', onBalance);
    $('#btnIcs').addEventListener('click', downloadIcs);
    $('#tab-settings').addEventListener('input', function (e) { if (e.target.matches('input, select') && e.target.id !== 'etfSearch') setDirty(true); });
    window.addEventListener('beforeunload', function (e) { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });
  }

  async function init() {
    bindEvents();
    try { state.status = await api('/api/status'); } catch (e) { state.status = { error: e.message }; }
    try { state.portfolio = await api('/api/portfolio'); } catch (e) { toast('포트폴리오 불러오기 실패: ' + e.message, 'error'); return; }
    renderAll();
    if (state.portfolio.items.length) {
      await loadPrices();
      renderAll();
      maybeAutoPopup();
    } else {
      switchTab('settings');
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
