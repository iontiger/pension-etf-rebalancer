'use strict';
/**
 * 포트폴리오 저장소 — data/portfolio.json (단일 사용자용 JSON 파일)
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'portfolio.json');

const CODE_RE = /^[0-9A-Z]{6}$/;

function defaultPortfolio() {
  return {
    version: 1,
    name: '연금 ETF 포트폴리오',
    items: [], // { code, name, weight(%), qty }
    cash: 0, // 예수금(원)
    settings: {
      band: 0, // 리밸런싱 밴드 (%p). 0 = 항상 목표비중으로
      minTradeAmount: 0, // 최소 거래금액(원). 이보다 작은 거래는 생략
      cycleDays: 30, // 리밸런싱 주기(일)
      autoPopup: true, // 접속 시 리밸런싱 팝업 자동 표시
      account: '', // 잔고 불러오기용 계좌번호
    },
    lastRebalancedAt: null,
    lastPrices: {}, // { code: { price, name, fetchedAt } }
    history: [], // { at, type, note, trades:[...], cashAfter, total }
    updatedAt: null,
  };
}

function load() {
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const p = JSON.parse(raw);
    return { ...defaultPortfolio(), ...p, settings: { ...defaultPortfolio().settings, ...(p.settings || {}) } };
  } catch (_) {
    return defaultPortfolio();
  }
}

function save(p) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(p, null, 2));
  fs.renameSync(tmp, FILE);
  return p;
}

const toNum = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/** 클라이언트가 보낸 포트폴리오 검증/정규화. 문제 있으면 Error throw */
function sanitize(input) {
  if (!input || typeof input !== 'object') throw new Error('잘못된 포트폴리오 데이터');
  const base = defaultPortfolio();
  const items = Array.isArray(input.items) ? input.items : [];
  const seen = new Set();
  const cleanItems = items.map((it, i) => {
    const code = String(it.code || '').trim().toUpperCase();
    if (!CODE_RE.test(code)) throw new Error(`${i + 1}번째 종목코드가 올바르지 않습니다: "${it.code}" (6자리)`);
    if (seen.has(code)) throw new Error(`종목코드 ${code} 가 중복되었습니다`);
    seen.add(code);
    const weight = toNum(it.weight);
    if (weight < 0 || weight > 100) throw new Error(`${code} 목표비중은 0~100 사이여야 합니다`);
    const qty = Math.max(0, Math.floor(toNum(it.qty)));
    return { code, name: String(it.name || '').slice(0, 80), weight, qty };
  });
  const totalWeight = cleanItems.reduce((s, it) => s + it.weight, 0);
  if (totalWeight > 100.0001) throw new Error(`목표비중 합계가 100%를 초과합니다 (${totalWeight.toFixed(2)}%)`);
  const s = input.settings || {};
  const settings = {
    band: Math.min(50, Math.max(0, toNum(s.band))),
    minTradeAmount: Math.max(0, Math.floor(toNum(s.minTradeAmount))),
    cycleDays: Math.min(365, Math.max(1, Math.floor(toNum(s.cycleDays, 30)))),
    autoPopup: s.autoPopup !== false,
    account: String(s.account || '').replace(/[^0-9A-Za-z-]/g, '').slice(0, 20),
  };
  const history = Array.isArray(input.history) ? input.history.slice(-200) : [];
  return {
    ...base,
    name: String(input.name || base.name).slice(0, 60),
    items: cleanItems,
    cash: Math.max(0, Math.floor(toNum(input.cash))),
    settings,
    lastRebalancedAt: input.lastRebalancedAt ? String(input.lastRebalancedAt) : null,
    lastPrices: input.lastPrices && typeof input.lastPrices === 'object' ? input.lastPrices : {},
    history,
    updatedAt: new Date().toISOString(),
  };
}

module.exports = { load, save, sanitize, defaultPortfolio, FILE };
