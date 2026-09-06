'use strict';
require('dotenv').config();
const path = require('path');
const express = require('express');
const nh = require('./nhplug');
const master = require('./master');
const store = require('./store');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1'; // API 키를 다루므로 기본은 로컬 전용
const PRICE_CACHE_MS = Number(process.env.PRICE_CACHE_MS || 30 * 1000);
const PRICE_SOURCE = (process.env.PRICE_SOURCE || (nh.isConfigured() ? 'nhplug' : 'mock')).toLowerCase();
const MOCK = PRICE_SOURCE === 'mock';

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
});

// ------------------------------------------------------------------ 헬퍼
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  const status = e instanceof nh.NhError ? (e.code === 'NOT_CONFIGURED' ? 503 : 502) : 400;
  console.error(`[api] ${req.method} ${req.path} → ${e.message}`);
  res.status(status).json({ error: e.message, code: e.code || '' });
});

const priceCache = new Map(); // code → { data, at }

async function mockPrice(code) {
  await master.ensure().catch(() => null);
  const m = master.lookup(code);
  if (!m) throw new nh.NhError(`종목마스터에 없는 코드: ${code}`, 404, null, 'NOT_FOUND');
  const price = m.prevClose || m.basePrice;
  if (!price) throw new nh.NhError(`기준가 없음: ${code}`, 404, null, 'NO_PRICE');
  return {
    code, name: m.name, price, prevClose: price, change: 0, changeRate: 0,
    time: '', fetchedAt: Date.now(), source: 'mock(종목마스터 전일종가)', mock: true,
  };
}

async function fetchPrice(code, { fresh = false } = {}) {
  const hit = priceCache.get(code);
  if (!fresh && hit && Date.now() - hit.at < PRICE_CACHE_MS) return { ...hit.data, cached: true };
  const data = MOCK ? await mockPrice(code) : await nh.getPrice(code);
  if (!data.name) {
    const m = master.lookup(code);
    if (m) data.name = m.name;
  }
  priceCache.set(code, { data, at: Date.now() });
  return data;
}

// ------------------------------------------------------------------ 라우트
app.get('/api/status', wrap(async (req, res) => {
  res.json({
    configured: nh.isConfigured(),
    mock: MOCK,
    priceSource: PRICE_SOURCE,
    baseUrl: nh.BASE_URL,
    marketCd: nh.MARKET_CD,
    token: nh.isConfigured() ? nh.tokenStatus() : { cached: false },
    master: master.status(),
    priceCacheMs: PRICE_CACHE_MS,
    now: Date.now(),
  });
}));

app.get('/api/portfolio', wrap(async (req, res) => {
  res.json(store.load());
}));

app.put('/api/portfolio', wrap(async (req, res) => {
  const clean = store.sanitize(req.body);
  // 종목명 비어 있으면 마스터에서 보완
  await master.ensure().catch(() => null);
  for (const it of clean.items) {
    if (!it.name) {
      const m = master.lookup(it.code);
      if (m) it.name = m.name;
    }
  }
  res.json(store.save(clean));
}));

/** GET /api/prices?codes=069500,360750&fresh=1 → { prices:{code:{...}}, errors:{code:msg}, mock } */
app.get('/api/prices', wrap(async (req, res) => {
  const codes = [...new Set(String(req.query.codes || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))].slice(0, 50);
  const fresh = req.query.fresh === '1';
  const prices = {};
  const errors = {};
  await Promise.all(codes.map(async (code) => {
    try {
      prices[code] = await fetchPrice(code, { fresh });
    } catch (e) {
      errors[code] = e.message;
      if (e.code === 'NOT_CONFIGURED') throw e;
    }
  }));
  res.json({ prices, errors, mock: MOCK, fetchedAt: Date.now() });
}));

/** GET /api/etf/search?q=코스피&types=ETF,ETN */
app.get('/api/etf/search', wrap(async (req, res) => {
  await master.ensure();
  const types = String(req.query.types || 'ETF').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const results = master.search(String(req.query.q || ''), { limit: Number(req.query.limit) || 20, types: types.includes('ALL') ? [] : types });
  res.json({ results, master: master.status() });
}));

app.get('/api/etf/:code', wrap(async (req, res) => {
  await master.ensure();
  const m = master.lookup(req.params.code);
  if (!m) return res.status(404).json({ error: `종목마스터에 없는 코드: ${req.params.code}` });
  res.json(m);
}));

app.post('/api/master/refresh', wrap(async (req, res) => {
  await master.ensure({ force: true });
  res.json(master.status());
}));

app.get('/api/accounts', wrap(async (req, res) => {
  const accounts = await nh.getAccounts();
  res.json({ accounts });
}));

/** GET /api/balance?act_no=... → 계좌 잔고 (예수금 + 보유종목 수량) */
app.get('/api/balance', wrap(async (req, res) => {
  const actNo = String(req.query.act_no || '').trim();
  if (!actNo) return res.status(400).json({ error: '계좌번호(act_no)가 필요합니다' });
  const bal = await nh.getBalance(actNo);
  await master.ensure().catch(() => null);
  for (const p of bal.positions) {
    const m = master.lookup(p.code);
    p.type = m ? m.type : 'UNKNOWN';
    if (!p.name && m) p.name = m.name;
  }
  res.json(bal);
}));

// 정적 파일 (프론트엔드)
app.use(express.static(path.join(__dirname, '..', 'public'), { etag: true, maxAge: 0 }));
app.use((req, res) => res.status(404).json({ error: 'not found' }));

// ------------------------------------------------------------------ 기동
app.listen(PORT, HOST, () => {
  console.log(`연금 ETF 리밸런서: http://${HOST}:${PORT}`);
  console.log(`시세 소스: ${MOCK ? '모의(종목마스터 전일종가) — .env 에 NHPLUG_APP_KEY/NHPLUG_APP_SECRET 설정 시 실시간 전환' : `NH Plug 실시간 (${nh.BASE_URL})`}`);
  master.ensure().catch((e) => console.warn(`[master] ${e.message}`));
});
