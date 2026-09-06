#!/usr/bin/env python3
"""
NH Plug 국내주식 종목마스터(m_new_stock.mst)에서 ETF/ETN 전일종가를 뽑아 docs/prices.json 을 만든다.
 - 인증 불필요 (공개 파일). 구조: https://www.nhplug.com/instruments/m_new_stock.h (237바이트 고정길이, CP949)
 - 가격이 직전 파일과 완전히 같으면(주말·휴일 등) 파일을 다시 쓰지 않는다 → 기준일이 잘못 앞당겨지지 않음
 - 기준일(baseDate) = 가격이 바뀐 날의 "직전 영업일(월~금)". --base-date 로 강제 지정 가능.
사용: python scripts/build_prices.py [출력경로] [--base-date YYYY-MM-DD] [--mst 로컬파일]
"""
import datetime as dt
import json
import os
import sys
import urllib.request

MST_URL = os.environ.get("NHPLUG_MST_URL", "https://www.nhplug.com/instruments/m_new_stock.mst")
FIELDS = [  # (이름, 바이트 길이) — m_new_stock.h 와 1:1
    ("sCode", 6), ("sMarket", 1), ("sKorName", 41), ("sEngName", 41), ("sOldName", 40),
    ("eCapSize", 1), ("sUpCodeM", 6), ("sUpCodeS", 6), ("sGroup", 2), ("gManuf", 1),
    ("sParvalue", 7), ("sPrePrice", 7), ("eRights", 1), ("eUnder", 1), ("eStop", 1),
    ("eWarn", 1), ("eGongsi", 1), ("gTonghap", 1), ("gVenture", 1), ("gKrx300", 1),
    ("gKospi50", 1), ("eAccept", 1), ("gKospiIT", 1), ("gKospiBD", 1), ("gIT", 1),
    ("gKosdaq150", 1), ("gKospi100", 1), ("prdy_avls", 12), ("invt_epmd_issu_yn", 1),
    ("short_over_issu_cls_code", 1), ("alert_gb", 1), ("sltr_yn", 1), ("stck_sdpr", 7),
    ("nxt_yn", 1), ("eNXTStop", 1), ("sUpCodeL", 6), ("nxt_comp_deal_tr_code", 2),
    ("filler", 29), ("dummy", 1),
]
RECORD = sum(n for _, n in FIELDS)  # 237
KST = dt.timezone(dt.timedelta(hours=9))


def parse(buf):
    if len(buf) % RECORD:
        raise SystemExit(f"마스터 파일 크기({len(buf)})가 레코드({RECORD})의 배수가 아닙니다. 구조 개정 확인 필요")
    for i in range(0, len(buf), RECORD):
        rec, off, row = buf[i:i + RECORD], 0, {}
        for name, n in FIELDS:
            row[name] = rec[off:off + n].decode("cp949", "replace").rstrip()
            off += n
        yield row


def to_int(s):
    try:
        return int(s)
    except (TypeError, ValueError):
        return 0


def prev_business_day(d):
    d -= dt.timedelta(days=1)
    while d.weekday() >= 5:  # 토·일 제외 (공휴일은 미반영)
        d -= dt.timedelta(days=1)
    return d


def main(argv):
    out = "docs/prices.json"
    base_override = None
    mst_local = None
    args = list(argv)
    while args:
        a = args.pop(0)
        if a == "--base-date":
            base_override = args.pop(0)
        elif a == "--mst":
            mst_local = args.pop(0)
        else:
            out = a

    if mst_local:
        buf = open(mst_local, "rb").read()
    else:
        with urllib.request.urlopen(MST_URL, timeout=60) as r:
            buf = r.read()

    items = {}
    for row in parse(buf):
        if row["gVenture"] == "8":
            typ = "ETF"
        elif row["gVenture"] == "E" or row["sMarket"] == "A":
            typ = "ETN"
        else:
            continue
        price = to_int(row["sPrePrice"]) or to_int(row["stck_sdpr"])
        if price <= 0:
            continue
        name = row["sKorName"].lstrip(" *#").strip()
        items[row["sCode"]] = [name, price, typ]
    if len(items) < 100:
        raise SystemExit(f"ETF/ETN 이 {len(items)}건뿐입니다. 파일 구조가 바뀐 것 같습니다.")

    prev = None
    if os.path.exists(out):
        try:
            prev = json.load(open(out, encoding="utf-8"))
        except Exception:
            prev = None
    prev_prices = {k: v[1] for k, v in (prev or {}).get("items", {}).items()}
    now_prices = {k: v[1] for k, v in items.items()}
    unchanged = prev is not None and prev_prices == now_prices and not base_override

    if unchanged:
        print(f"가격 변동 없음 (기준일 {prev.get('baseDate')} 유지, {len(items)}건) — 파일을 다시 쓰지 않습니다.")
        return 0

    now = dt.datetime.now(KST)
    base_date = base_override or prev_business_day(now.date()).isoformat()
    data = {
        "baseDate": base_date,
        "fetchedAt": now.isoformat(timespec="seconds"),
        "count": len(items),
        "source": MST_URL,
        "note": "NH Plug 종목마스터의 전일종가. 기준일은 파일 수집일의 직전 영업일(월~금)로 추정.",
        "items": items,
    }
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print(f"작성: {out} — 기준일 {base_date}, ETF/ETN {len(items)}건, 수집 {data['fetchedAt']}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
