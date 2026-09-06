#!/usr/bin/env python3
"""
종목별 일별 종가 히스토리(docs/history/{code}.json) 유지.
 - 매일: docs/prices.json 의 (baseDate, 전일종가) 를 각 종목 히스토리에 덧붙인다 (외부 호출 없음)
 - 히스토리가 없거나 오래 끊긴 종목만 네이버 금융 일별 시세(fchart)로 1년치 백필
파일 형식: {"code":"069500","d":["20250906",...],"c":[103000,...]}   (d=YYYYMMDD, c=종가)
사용: python scripts/build_history.py [--prices docs/prices.json] [--out docs/history] [--codes 069500,360200] [--no-backfill]
"""
import datetime as dt
import json
import os
import re
import sys
import time
import urllib.request

FCHART = "https://fchart.stock.naver.com/sise.nhn?symbol={code}&timeframe=day&count={count}&requestType=0"
MAX_POINTS = 400        # 약 1년 반
BACKFILL_COUNT = 270    # 백필 시 요청 일수 (영업일)
GAP_DAYS = 10           # 마지막 점이 기준일보다 이보다 오래됐으면 백필로 메움
DELAY = 0.15            # 네이버 호출 간격(초)


def fetch_naver(code, count=BACKFILL_COUNT):
    req = urllib.request.Request(FCHART.format(code=code, count=count), headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        raw = r.read().decode("cp949", "replace")
    pts = []
    for m in re.finditer(r'<item data="(\d{8})\|(\d+)\|(\d+)\|(\d+)\|(\d+)\|(\d+)"', raw):
        d, close = m.group(1), int(m.group(5))
        if close > 0:
            pts.append((d, close))
    return pts


def load(path):
    try:
        h = json.load(open(path, encoding="utf-8"))
        if isinstance(h.get("d"), list) and isinstance(h.get("c"), list) and len(h["d"]) == len(h["c"]):
            return h
    except Exception:
        pass
    return None


def save(path, code, pts):
    pts = sorted({d: c for d, c in pts}.items())[-MAX_POINTS:]
    json.dump({"code": code, "d": [d for d, _ in pts], "c": [c for _, c in pts]}, open(path, "w", encoding="utf-8"), separators=(",", ":"))


def main(argv):
    prices_path, out_dir, only, backfill = "docs/prices.json", "docs/history", None, True
    args = list(argv)
    while args:
        a = args.pop(0)
        if a == "--prices": prices_path = args.pop(0)
        elif a == "--out": out_dir = args.pop(0)
        elif a == "--codes": only = set(args.pop(0).split(","))
        elif a == "--no-backfill": backfill = False
    prices = json.load(open(prices_path, encoding="utf-8"))
    base = prices["baseDate"].replace("-", "")
    base_dt = dt.datetime.strptime(base, "%Y%m%d").date()
    os.makedirs(out_dir, exist_ok=True)
    codes = [c for c in prices["items"] if not only or c in only]
    appended = backfilled = skipped = failed = 0
    for i, code in enumerate(codes):
        path = os.path.join(out_dir, code + ".json")
        price = prices["items"][code][1]
        h = load(path)
        need_backfill = h is None or not h["d"]
        if h and h["d"]:
            last = dt.datetime.strptime(h["d"][-1], "%Y%m%d").date()
            if (base_dt - last).days > GAP_DAYS:
                need_backfill = True
        if need_backfill and backfill:
            try:
                pts = fetch_naver(code)
                time.sleep(DELAY)
            except Exception as e:
                print(f"  backfill 실패 {code}: {e}", file=sys.stderr)
                pts = []
                failed += 1
            if pts:
                if h:
                    pts = list(zip(h["d"], h["c"])) + pts
                pts.append((base, price))
                save(path, code, pts)
                backfilled += 1
                continue
        if h is None:
            h = {"d": [], "c": []}
        if h["d"] and h["d"][-1] >= base:
            skipped += 1
            continue
        pts = list(zip(h["d"], h["c"])) + [(base, price)]
        save(path, code, pts)
        appended += 1
        if (i + 1) % 200 == 0:
            print(f"  진행 {i + 1}/{len(codes)}")
    print(f"히스토리: 기준일 {prices['baseDate']} · 추가 {appended} · 백필 {backfilled} · 최신 {skipped} · 실패 {failed} (총 {len(codes)}종목)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
