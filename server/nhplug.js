'use strict';
/**
 * NH Plug (NH투자증권 Namuh PLUG OpenAPI) REST 클라이언트
 *  - 접근토큰 발급/파일 캐시 (24시간 유효, 만료 전 재발급 금지 → 파일 캐시 + 401 시에만 재발급)
 *  - 초당 호출 제한 (REST 초당 5회 수준) → 최소 호출 간격으로 직렬화
 *  - ETF 현재가 / 주식 현재가 / 계좌목록 / 잔고조회
 *
 * 참고: https://www.nhplug.com/apiservice , https://www.nhplug.com/llms.txt
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const TOKEN_FILE = path.join(DATA_DIR, 'token.json');

const BASE_URL = (process.env.NHPLUG_BASE_URL || 'https://api.nhplug.com:8443').replace(/\/+$/, '');
// 접근토큰 발급은 운영 전용 (모의투자 미제공). 발급 토큰은 운영/모의 양쪽에서 사용 가능.
const AUTH_URL = (process.env.NHPLUG_AUTH_URL || 'https://api.nhplug.com:8443').replace(/\/+$/, '');
const APP_KEY = (process.env.NHPLUG_APP_KEY || '').trim();
const APP_SECRET = (process.env.NHPLUG_APP_SECRET || '').trim();
const MAC_ADDRESS = (process.env.NHPLUG_MAC_ADDRESS || '').trim(); // 법인 고객만 필수
const MARKET_CD = (process.env.NHPLUG_MARKET_CD || 'KRX').trim(); // KRX / NXT / UNT
const MIN_INTERVAL_MS = Math.max(0, Number(process.env.NHPLUG_MIN_INTERVAL_MS || 250));
const TOKEN_SAFETY_MS = 5 * 60 * 1000; // 만료 5분 전부터는 재발급

class NhError extends Error {
  constructor(message, status = 0, body = null, code = '') {
    super(message);
    this.name = 'NhError';
    this.status = status;
    this.body = body;
    this.code = code;
  }
}

function isConfigured() {
  return Boolean(APP_KEY && APP_SECRET);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};
const cleanName = (s) => String(s || '').replace(/^[\s*#]+/, '').trim();

// ---------------------------------------------------------------- 토큰 캐시
function readTokenFile() {
  try {
    const raw = fs.readFileSync(TOKEN_FILE, 'utf8');
    const t = JSON.parse(raw);
    if (t && typeof t.access_token === 'string' && Number.isFinite(t.expires_at)) return t;
  } catch (_) { /* no cache */ }
  return null;
}

function writeTokenFile(tok) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tok, null, 2), { mode: 0o600 });
}

function tokenStatus() {
  const t = readTokenFile();
  if (!t) return { cached: false };
  return { cached: true, issuedAt: t.issued_at || null, expiresAt: t.expires_at, valid: t.expires_at - Date.now() > 0 };
}

let inflightToken = null;
let lastTokenFailure = { at: 0, error: null };
const TOKEN_FAILURE_COOLDOWN_MS = 30 * 1000; // 발급 실패(잘못된 키 등) 직후 30초간 재시도하지 않음

async function getToken({ force = false } = {}) {
  if (!force) {
    const cached = readTokenFile();
    if (cached && cached.expires_at - Date.now() > TOKEN_SAFETY_MS) return cached.access_token;
  }
  if (lastTokenFailure.error && Date.now() - lastTokenFailure.at < TOKEN_FAILURE_COOLDOWN_MS) {
    throw lastTokenFailure.error;
  }
  if (!inflightToken) {
    inflightToken = issueToken()
      .then((tok) => { lastTokenFailure = { at: 0, error: null }; return tok; })
      .catch((e) => { lastTokenFailure = { at: Date.now(), error: e }; throw e; })
      .finally(() => { inflightToken = null; });
  }
  return inflightToken;
}

async function issueToken() {
  const params = new URLSearchParams({
    appkey: APP_KEY,
    appsecretkey: APP_SECRET,
    grant_type: 'client_credentials',
    scope: 'oob',
  });
  // 명세: 쿼리 파라미터 + Content-Type application/x-www-form-urlencoded (본문에도 동일하게 실어 양쪽 모두 만족)
  const res = await fetch(`${AUTH_URL}/oauth2/token?${params.toString()}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not json */ }
  if (!res.ok || !json || !json.access_token) {
    const code = json && (json.error_code || json.rsp_cd || json.error) || '';
    const msg = json && (json.error_description || json.rsp_msg || json.message) || text.slice(0, 300);
    throw new NhError(`접근토큰 발급 실패 (HTTP ${res.status}) ${code} ${msg}`.trim(), res.status, json, code);
  }
  const expiresIn = Number(json.expires_in) > 0 ? Number(json.expires_in) : 86400;
  const tok = {
    access_token: json.access_token,
    token_type: json.token_type || 'Bearer',
    issued_at: Date.now(),
    expires_at: Date.now() + expiresIn * 1000,
  };
  writeTokenFile(tok);
  console.log(`[nhplug] 접근토큰 발급 완료 (만료 ${new Date(tok.expires_at).toLocaleString('ko-KR')})`);
  return tok.access_token;
}

// ---------------------------------------------------------------- 호출 간격 제한
let chain = Promise.resolve();
let lastStart = 0;
function throttle() {
  const p = chain.then(async () => {
    const wait = lastStart + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastStart = Date.now();
  });
  chain = p.catch(() => {});
  return p;
}

const TOKEN_ERROR_CODES = new Set(['IGW40043', 'IGW40044', 'IGW40051']);
const RATE_ERROR_CODES = new Set(['IGW42901', 'IGW42902', 'IGW42903']);

function extractError(json) {
  if (!json || typeof json !== 'object') return null;
  const code = json.error_code || json.errorCode || (typeof json.rsp_cd === 'string' && json.rsp_cd.startsWith('IGW') ? json.rsp_cd : '') || '';
  if (!code) return null;
  return { code, message: json.error_description || json.rsp_msg || json.message || '' };
}

/**
 * REST 호출: POST {BASE_URL}{pathname}  body {"Input_0": input}
 * 반환: { body, headers: { cts, cts_flag }, status }
 */
async function call(pathname, input = {}, opts = {}) {
  const { headers = {}, retry401 = true, retry429 = 2 } = opts;
  if (!isConfigured()) {
    throw new NhError('NH Plug API 키가 설정되지 않았습니다. .env 파일에 NHPLUG_APP_KEY / NHPLUG_APP_SECRET 를 입력하세요.', 0, null, 'NOT_CONFIGURED');
  }
  await throttle();
  const token = await getToken();
  const reqHeaders = {
    'content-type': 'application/json;charset=utf-8',
    authorization: `Bearer ${token}`,
    ...headers,
  };
  if (MAC_ADDRESS) reqHeaders.mac_address = MAC_ADDRESS;

  const res = await fetch(BASE_URL + pathname, {
    method: 'POST',
    headers: reqHeaders,
    body: JSON.stringify({ Input_0: input || {} }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not json */ }
  const err = extractError(json);

  const tokenProblem = res.status === 401 || (err && TOKEN_ERROR_CODES.has(err.code));
  if (tokenProblem && retry401) {
    console.warn(`[nhplug] 토큰 오류 (${res.status} ${err ? err.code : ''}) → 재발급 후 1회 재시도`);
    await getToken({ force: true });
    return call(pathname, input, { ...opts, retry401: false });
  }
  const rateProblem = res.status === 429 || (err && RATE_ERROR_CODES.has(err.code));
  if (rateProblem && retry429 > 0) {
    await sleep(1000 * (3 - retry429)); // 1초, 2초 백오프 (토큰 재발급 금지)
    return call(pathname, input, { ...opts, retry429: retry429 - 1 });
  }
  if (!res.ok || err) {
    const msg = err ? `${err.code} ${err.message}` : text.slice(0, 300);
    throw new NhError(`API 오류 (HTTP ${res.status}) ${msg}`.trim(), res.status, json, err ? err.code : '');
  }
  return {
    body: json,
    status: res.status,
    headers: { cts: res.headers.get('cts') || '', cts_flag: res.headers.get('cts_flag') || '' },
  };
}

// ---------------------------------------------------------------- 시세
const SIGN_DOWN = new Set(['4', '5', '8', '9']);

function normalizeQuote(code, o, extra = {}) {
  const price = num(o.stck_prpr);
  const prevClose = num(o.prdy_clpr) ?? num(o.stck_prdy_clpr);
  let change = num(o.prdy_vrss);
  if (prevClose != null && price != null) change = price - prevClose;
  else if (change != null && SIGN_DOWN.has(String(o.prdy_vrss_sign || ''))) change = -Math.abs(change);
  let changeRate = num(o.prdy_ctrt);
  if (prevClose && price != null) changeRate = Math.round(((price - prevClose) / prevClose) * 10000) / 100;
  else if (changeRate != null && change != null && change < 0) changeRate = -Math.abs(changeRate);
  return {
    code,
    name: cleanName(o.iem_nm),
    price,
    prevClose,
    change,
    changeRate,
    open: num(o.stck_oprc),
    high: num(o.stck_hgpr),
    low: num(o.stck_lwpr),
    volume: num(o.acml_vol),
    time: o.bsop_hour || o.hoga_bsop_hour || '',
    fetchedAt: Date.now(),
    ...extra,
  };
}

/** 국내_주식_시세_ETF현재가 (/krstock/quote/v1/etfCurrent) */
async function getEtfPrice(code) {
  const { body } = await call('/krstock/quote/v1/etfCurrent', { iem_cd: code });
  const o = body && body.Output_0;
  if (!o || num(o.stck_prpr) === null) {
    throw new NhError(`ETF 시세 없음 (${code}): ${(body && body.rsp_msg) || '응답에 Output_0 없음'}`, 200, body, (body && body.rsp_cd) || '');
  }
  const e = (body && body.Output_3) || {};
  return normalizeQuote(code, o, {
    nav: num(e.itmt_last_nav),
    prevNav: num(e.prdy_last_nav),
    dprt: num(e.dprt), // 괴리율
    etfType: e.txtn_type_code || '',
    replication: e.clon_cls_code || '',
    source: 'etfCurrent',
  });
}

/** 국내_주식_시세_현재가 (/krstock/quote/v1/currentPrice) — ETF가 아닌 종목/실패 시 대체 */
async function getStockPrice(code, marketCd = MARKET_CD) {
  const { body } = await call('/krstock/quote/v1/currentPrice', { market_cd: marketCd, iem_cd: code });
  const o = body && body.Output_0;
  if (!o || num(o.stck_prpr) === null) {
    throw new NhError(`시세 없음 (${code}): ${(body && body.rsp_msg) || '응답에 Output_0 없음'}`, 200, body, (body && body.rsp_cd) || '');
  }
  return normalizeQuote(code, o, { source: 'currentPrice', market: marketCd });
}

/** ETF현재가 우선, 실패 시 주식현재가로 대체 */
async function getPrice(code) {
  try {
    return await getEtfPrice(code);
  } catch (e) {
    if (e.code === 'NOT_CONFIGURED') throw e;
    try {
      return await getStockPrice(code);
    } catch (e2) {
      throw e; // 원래(ETF) 오류를 보고
    }
  }
}

// ---------------------------------------------------------------- 계좌
/** 계좌 목록 (/n2/acctinfo) → [{ acct_no, acct_type }]  acct_type 01/02=운영, 03=모의투자 */
async function getAccounts() {
  const { body } = await call('/n2/acctinfo', {});
  const list = (body && body.Output_0) || [];
  return list.map((a) => ({ acct_no: String(a.acct_no || ''), acct_type: String(a.acct_type || '') }));
}

/** 국내_주식_조회_잔고 (/krstock/inquiry/v1/balance) — cts 연속조회로 전체 보유종목 수집 */
async function getBalance(actNo, { qutDitCd = 'UNT' } = {}) {
  const input = {
    act_no: String(actNo),
    bnc_bse_cd: '1', // 1.주식관련 총 평가(체결기준) 5.현재가기준
    ltg_aot_dit_cd: '1', // 1.상장종목
    aet_bse: '1', // 1.순자산
    qut_dit_cd: qutDitCd,
  };
  let summary = {};
  const rows = [];
  const seen = new Set();
  let cts = '';
  let ctsFlag = '';
  for (let page = 0; page < 50; page++) {
    const headers = ctsFlag === 'Y' ? { cts, cts_flag: 'Y' } : {};
    const { body, headers: rh } = await call('/krstock/inquiry/v1/balance', input, { headers });
    if (body && body.Output_0 && typeof body.Output_0 === 'object') summary = { ...summary, ...body.Output_0 };
    for (const r of (body && body.Output_1) || []) rows.push(r);
    const nextCts = rh.cts || '';
    const nextFlag = (rh.cts_flag || 'N').toUpperCase();
    const more = nextFlag === 'Y' || (body && (body.rsp_cd === '00165' || body.rsp_cd === '00218'));
    if (!more || !nextCts || seen.has(nextCts)) break;
    seen.add(nextCts);
    cts = nextCts;
    ctsFlag = 'Y';
  }
  // 동일 종목(현금/융자 등 유형별 행) 합산
  const byCode = new Map();
  for (const r of rows) {
    const code = String(r.iem_cd || '').trim();
    if (!code) continue;
    const qty = num(r.rsdl_qty) ?? num(r.itg_bnc_qty) ?? 0;
    const cur = byCode.get(code) || { code, name: cleanName(r.iem_nm), qty: 0, avgPrice: null, price: null, value: 0, types: [] };
    cur.qty += qty;
    cur.value += num(r.eal_amt) ?? 0;
    if (cur.avgPrice === null) cur.avgPrice = num(r.phs_pr);
    if (cur.price === null) cur.price = num(r.now_pr);
    if (r.tp_cd_nm) cur.types.push(String(r.tp_cd_nm));
    byCode.set(code, cur);
  }
  const positions = [...byCode.values()].map((p) => ({ ...p, qty: Math.round(p.qty * 1e6) / 1e6 }));
  return {
    account: String(actNo),
    cash: num(summary.orr_pbl_amt4) ?? num(summary.dca) ?? 0, // 100% 주문가능금액, 없으면 예수금
    deposit: num(summary.dca),
    depositD2: num(summary.nxt2_dd_dca),
    netAsset: num(summary.nas_amt),
    totalEval: num(summary.tot_eal_amt),
    totalPnl: num(summary.tot_eal_pls),
    positions,
    fetchedAt: Date.now(),
  };
}

module.exports = {
  NhError,
  isConfigured,
  tokenStatus,
  getToken,
  call,
  getPrice,
  getEtfPrice,
  getStockPrice,
  getAccounts,
  getBalance,
  BASE_URL,
  MARKET_CD,
};
