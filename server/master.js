'use strict';
/**
 * 국내주식 종목마스터 (m_new_stock.mst) 다운로드/파싱/검색
 *  - 구조체 정의: https://www.nhplug.com/instruments/m_new_stock.h (레코드 237바이트, CP949, LF 종단)
 *  - 인증 불필요. 하루 1회 갱신.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const INSTRUMENTS_BASE = (process.env.NHPLUG_INSTRUMENTS_BASE || 'https://www.nhplug.com/instruments').replace(/\/+$/, '');
const MST_FILE = path.join(DATA_DIR, 'm_new_stock.mst');
const MAX_AGE_MS = Number(process.env.MASTER_MAX_AGE_MS || 24 * 60 * 60 * 1000);

// (필드명, 바이트 길이) — m_new_stock.h 와 1:1
const FIELDS = [
  ['sCode', 6], ['sMarket', 1], ['sKorName', 41], ['sEngName', 41], ['sOldName', 40],
  ['eCapSize', 1], ['sUpCodeM', 6], ['sUpCodeS', 6], ['sGroup', 2], ['gManuf', 1],
  ['sParvalue', 7], ['sPrePrice', 7], ['eRights', 1], ['eUnder', 1], ['eStop', 1],
  ['eWarn', 1], ['eGongsi', 1], ['gTonghap', 1], ['gVenture', 1], ['gKrx300', 1],
  ['gKospi50', 1], ['eAccept', 1], ['gKospiIT', 1], ['gKospiBD', 1], ['gIT', 1],
  ['gKosdaq150', 1], ['gKospi100', 1], ['prdy_avls', 12], ['invt_epmd_issu_yn', 1],
  ['short_over_issu_cls_code', 1], ['alert_gb', 1], ['sltr_yn', 1], ['stck_sdpr', 7],
  ['nxt_yn', 1], ['eNXTStop', 1], ['sUpCodeL', 6], ['nxt_comp_deal_tr_code', 2],
  ['filler', 29], ['dummy', 1],
];
const RECORD_SIZE = FIELDS.reduce((s, [, l]) => s + l, 0); // 237
const MARKET_NAME = { 1: '코스피', 4: '코스닥', A: 'ETN' };
const TYPE_BY_VENTURE = { 8: 'ETF', E: 'ETN' };

let decoder;
try { decoder = new TextDecoder('euc-kr'); } catch (_) { decoder = null; }

const state = { records: [], byCode: new Map(), loadedAt: 0, fileMtime: 0, error: null };

function decodeField(buf) {
  const s = decoder ? decoder.decode(buf) : buf.toString('latin1');
  return s.replace(/\s+$/, '');
}

function parse(buf) {
  if (buf.length % RECORD_SIZE !== 0) {
    throw new Error(`마스터 파일 크기(${buf.length})가 레코드 크기(${RECORD_SIZE})의 배수가 아닙니다 — 구조 개정 여부 확인 필요`);
  }
  const out = [];
  for (let i = 0; i < buf.length; i += RECORD_SIZE) {
    const rec = buf.subarray(i, i + RECORD_SIZE);
    let o = 0;
    const r = {};
    for (const [name, len] of FIELDS) {
      r[name] = decodeField(rec.subarray(o, o + len));
      o += len;
    }
    const type = TYPE_BY_VENTURE[r.gVenture] || (r.sMarket === 'A' ? 'ETN' : 'STOCK');
    out.push({
      code: r.sCode,
      name: r.sKorName.replace(/^[\s*#]+/, ''),
      engName: r.sEngName.trim(),
      market: MARKET_NAME[r.sMarket] || r.sMarket,
      type,
      prevClose: Number(r.sPrePrice) || 0,
      basePrice: Number(r.stck_sdpr) || 0,
      halted: r.eStop === 'Y',
      nxt: r.nxt_yn === 'Y',
    });
  }
  return out;
}

async function download() {
  const res = await fetch(`${INSTRUMENTS_BASE}/m_new_stock.mst`);
  if (!res.ok) throw new Error(`종목마스터 다운로드 실패 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  parse(buf); // 검증
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MST_FILE, buf);
  return buf;
}

function loadFromDisk() {
  const buf = fs.readFileSync(MST_FILE);
  const records = parse(buf);
  state.records = records;
  state.byCode = new Map(records.map((r) => [r.code, r]));
  state.loadedAt = Date.now();
  state.fileMtime = fs.statSync(MST_FILE).mtimeMs;
  state.error = null;
}

let inflight = null;
/** 마스터 준비 (없거나 오래되면 다운로드). 실패해도 기존 캐시가 있으면 그대로 사용. */
async function ensure({ force = false } = {}) {
  if (inflight) return inflight;
  inflight = (async () => {
    let stale = true;
    try {
      const st = fs.statSync(MST_FILE);
      stale = Date.now() - st.mtimeMs > MAX_AGE_MS;
      if (!state.records.length || st.mtimeMs !== state.fileMtime) loadFromDisk();
    } catch (_) { stale = true; }
    if (force || stale) {
      try {
        await download();
        loadFromDisk();
        console.log(`[master] 종목마스터 갱신: ${state.records.length}건`);
      } catch (e) {
        state.error = e.message;
        console.warn(`[master] 종목마스터 갱신 실패: ${e.message}${state.records.length ? ' (기존 캐시 사용)' : ''}`);
        if (!state.records.length) throw e;
      }
    }
    return state;
  })().finally(() => { inflight = null; });
  return inflight;
}

function status() {
  return {
    records: state.records.length,
    etfs: state.records.filter((r) => r.type === 'ETF').length,
    updatedAt: state.fileMtime || null,
    error: state.error,
  };
}

function lookup(code) {
  return state.byCode.get(String(code).toUpperCase()) || null;
}

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');

/** 이름/코드 검색. types: ['ETF'] | ['ETF','ETN'] | [] (전체) */
function search(q, { limit = 20, types = ['ETF'] } = {}) {
  const query = norm(q);
  if (!query) return [];
  const typeSet = new Set(types);
  const terms = String(q).toLowerCase().split(/\s+/).filter(Boolean);
  const hits = [];
  for (const r of state.records) {
    if (typeSet.size && !typeSet.has(r.type)) continue;
    const name = r.name.toLowerCase();
    const nameN = norm(r.name);
    const code = r.code.toLowerCase();
    let score = -1;
    if (code === query) score = 100;
    else if (code.startsWith(query)) score = 90;
    else if (nameN.startsWith(query)) score = 80;
    else if (terms.every((t) => name.includes(t) || nameN.includes(norm(t)))) score = 60;
    else if (nameN.includes(query)) score = 50;
    if (score < 0) continue;
    hits.push({ score, r });
  }
  hits.sort((a, b) => b.score - a.score || a.r.name.localeCompare(b.r.name, 'ko'));
  return hits.slice(0, limit).map((h) => h.r);
}

module.exports = { ensure, status, lookup, search, RECORD_SIZE };
