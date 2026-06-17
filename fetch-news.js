#!/usr/bin/env node
/**
 * EdTech ニュース収集アプリ
 * 指定期間（デフォルト直近1週間）の日本・海外EdTechニュースをRSSから収集し、
 * HTML一覧を生成してブラウザで開きます。
 *
 * 使い方:
 *   node fetch-news.js                       直近7日間
 *   node fetch-news.js --days 14             直近14日間
 *   node fetch-news.js --from 2026-06-01 --to 2026-06-17
 *   node fetch-news.js --from 2026-06-01     指定日から今日まで
 *   node fetch-news.js --no-open             ブラウザを自動で開かない
 */

const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const SOURCES = require("./sources");

// ---------- 引数パース ----------
function parseArgs(argv) {
  const args = { days: 7, from: null, to: null, open: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--days") args.days = parseInt(argv[++i], 10);
    else if (a === "--from") args.from = argv[++i];
    else if (a === "--to") args.to = argv[++i];
    else if (a === "--no-open") args.open = false;
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

function parseDate(d) {
  // "YYYY-MM-DD" はローカル日付として解釈（UTCズレ防止）
  if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
    const [y, m, day] = d.split("-").map(Number);
    return new Date(y, m - 1, day);
  }
  return new Date(d);
}
function startOfDay(d) { const x = parseDate(d); x.setHours(0, 0, 0, 0); return x; }
function endOfDay(d) { const x = parseDate(d); x.setHours(23, 59, 59, 999); return x; }
function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function resolveRange(args) {
  let to = args.to ? endOfDay(args.to) : endOfDay(new Date());
  let from;
  if (args.from) {
    from = startOfDay(args.from);
  } else {
    from = startOfDay(new Date(to.getTime() - (args.days - 1) * 86400000));
  }
  return { from, to };
}

// ---------- HTTP取得（タイムアウト・リトライ付き） ----------
async function fetchText(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
      redirect: "follow",
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

// ---------- XML/RSSパース（依存なし） ----------
function decodeEntities(s) {
  if (!s) return "";
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

function stripTags(s) {
  let x = String(s || "");
  x = x.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"); // 先にCDATAを展開（タグ除去より前）
  x = x.replace(/<[^>]+>/g, " ");                      // 残ったタグを除去
  return decodeEntities(x).replace(/\s+/g, " ").trim();
}

function tag(block, names) {
  for (const name of names) {
    // 属性なし要素 <tag>...</tag>
    const re = new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + name + ">", "i");
    const m = block.match(re);
    if (m) return m[1].trim();
  }
  return "";
}

function attrLink(block) {
  // Atom: <link href="..." rel="alternate"/> を優先
  const links = [...block.matchAll(/<link\b([^>]*)\/?>(?:([\s\S]*?)<\/link>)?/gi)];
  let fallback = "";
  for (const m of links) {
    const attrs = m[1] || "";
    const href = (attrs.match(/href\s*=\s*["']([^"']+)["']/i) || [])[1];
    const rel = (attrs.match(/rel\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (href) {
      if (!rel || rel === "alternate") return href;
      if (!fallback) fallback = href;
    }
  }
  return fallback;
}

function parseFeed(xml, source) {
  const items = [];
  // RSS/RDF: <item>...</item>, Atom: <entry>...</entry>
  const blocks = [
    ...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi),
    ...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi),
  ];
  for (const b of blocks) {
    const block = b[0];
    const title = stripTags(tag(block, ["title"]));
    let link = tag(block, ["link"]);
    if (!link || /<link/i.test(block.match(/<link[^>]*\/>/i)?.[0] || "")) {
      const a = attrLink(block);
      if (a) link = a;
    }
    link = stripTags(link) || attrLink(block);
    const dateStr =
      tag(block, ["pubDate", "dc:date", "published", "updated", "date"]) || "";
    const date = dateStr ? new Date(dateStr) : null;
    let summary = stripTags(tag(block, ["description", "summary", "content:encoded", "content"]));
    if (summary.length > 220) summary = summary.slice(0, 220) + "…";
    if (title && link) {
      items.push({
        title, link,
        date: date && !isNaN(date) ? date : null,
        summary,
        source: source.name,
        region: source.region,
      });
    }
  }
  return items;
}

// ---------- メイン ----------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(__filename, "utf8").split("*/")[0].replace(/\/\*\*?/, ""));
    return;
  }
  const { from, to } = resolveRange(args);
  const fmt = fmtDate;
  console.log(`\n📡 EdTechニュース収集中... 期間: ${fmt(from)} 〜 ${fmt(to)}\n`);

  const results = await Promise.allSettled(
    SOURCES.map(async (s) => {
      const xml = await fetchText(s.url);
      return { source: s, items: parseFeed(xml, s) };
    })
  );

  let all = [];
  const status = [];
  results.forEach((r, i) => {
    const s = SOURCES[i];
    if (r.status === "fulfilled") {
      const inRange = r.value.items.filter(
        (it) => it.date && it.date >= from && it.date <= to
      );
      all = all.concat(inRange);
      status.push({ name: s.name, region: s.region, ok: true, total: r.value.items.length, hit: inRange.length });
      console.log(`  ✅ ${s.name.padEnd(18)} 取得${String(r.value.items.length).padStart(3)}件 → 期間内${inRange.length}件`);
    } else {
      status.push({ name: s.name, region: s.region, ok: false, error: String(r.reason && r.reason.message || r.reason) });
      console.log(`  ⚠️  ${s.name.padEnd(18)} 取得失敗: ${r.reason && r.reason.message || r.reason}`);
    }
  });

  // 重複除去（URL）
  const seen = new Set();
  all = all.filter((it) => { if (seen.has(it.link)) return false; seen.add(it.link); return true; });
  // 日付降順
  all.sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0));

  const jpCount = all.filter((x) => x.region === "jp").length;
  const glCount = all.filter((x) => x.region === "global").length;
  console.log(`\n📰 合計 ${all.length}件（日本 ${jpCount} / 海外 ${glCount}）\n`);

  const html = renderHtml({ items: all, from, to, status, fmt });
  const outDir = path.join(__dirname, "reports");
  fs.mkdirSync(outDir, { recursive: true });
  const outName = `edtech-news_${fmt(from)}_${fmt(to)}.html`;
  const outPath = path.join(outDir, outName);
  fs.writeFileSync(outPath, html, "utf8");
  // 最新版を index.html としても保存
  fs.writeFileSync(path.join(__dirname, "index.html"), html, "utf8");
  console.log(`✅ レポート生成: ${outPath}\n`);

  if (args.open) openInBrowser(outPath);
}

function openInBrowser(p) {
  const cmd =
    process.platform === "win32" ? `start "" "${p}"` :
    process.platform === "darwin" ? `open "${p}"` : `xdg-open "${p}"`;
  exec(cmd, (e) => { if (e) console.log("（ブラウザ自動起動に失敗。上記パスを手動で開いてください）"); });
}

// ---------- HTML生成 ----------
function esc(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// バズワード抽出（カタカナ / 英単語 / 漢字熟語の頻度集計）
const STOP_WORDS = new Set([
  "the","and","for","with","that","this","from","are","you","your","our","its",
  "new","how","why","what","when","where","more","now","2026","2025","get","can","has",
  "について","として","による","ます","です","する","した","しま","こと","もの","これ","それ",
  "ため","よう","また","なる","いる","ある","ない","年度","発表","開催","実施","提供","活用","支援","紹介","予定",
]);
function extractKeywords(items) {
  const counts = new Map();
  for (const it of items) {
    const text = it.title + " " + (it.summary || "");
    const tokens = [
      ...(text.match(/[゠-ヿー]{3,}/g) || []),         // カタカナ
      ...(text.match(/[A-Za-z][A-Za-z0-9+#-]{2,}/g) || []),         // 英単語
      ...(text.match(/[一-鿿]{2,4}/g) || []),                // 漢字熟語
    ];
    for (const w of tokens) {
      const k = w.toLowerCase();
      if (STOP_WORDS.has(k) || k.length < 2) continue;
      counts.set(w, (counts.get(w) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
}

// 内容ベースの自動タグ付け
const TAG_RULES = [
  { re: /(生成ai|生成 ai|chatgpt|gpt-?\d|claude|gemini|copilot|\bllm\b|大規模言語|プロンプト)/i, label: "生成AI",     cls: "t-ai" },
  { re: /(プログラミング|コーディング|coding|プログラム教育)/i,                                  label: "プログラミング", cls: "t-prog" },
  { re: /(不登校|フリースクール|オルタナティブ)/i,                                                label: "不登校支援",   cls: "t-soc" },
  { re: /(大学|university|高等教育|college|学長)/i,                                              label: "大学",         cls: "t-univ" },
  { re: /(中学|高校|小学|児童|生徒|k-?12|gakko)/i,                                                label: "K-12",         cls: "t-k12" },
  { re: /(保護者|家庭学習|保育|幼児|親子)/i,                                                      label: "家庭・保護者", cls: "t-home" },
  { re: /(資金調達|シリーズ[a-e]|funding|raises?|million|億円|出資|投資)/i,                       label: "資金調達",     cls: "t-money" },
  { re: /(調査|レポート|report|study|統計|データ)/i,                                              label: "データ",       cls: "t-data" },
  { re: /(イベント|セミナー|フォーラム|サミット|conference|webinar)/i,                            label: "イベント",     cls: "t-ev" },
  { re: /(教員|教師|teacher|研修|professional development)/i,                                    label: "教員",         cls: "t-teach" },
];
function tagsFor(it) {
  const txt = it.title + " " + (it.summary || "");
  return TAG_RULES.filter((t) => t.re.test(txt));
}

function renderHtml({ items, from, to, status, fmt }) {
  const rangeLabel = `${fmt(from)} 〜 ${fmt(to)}`;
  const jp = items.filter((x) => x.region === "jp");
  const gl = items.filter((x) => x.region === "global");
  const buzz = extractKeywords(items);
  const maxBuzz = buzz[0]?.[1] || 1;

  // メディア活性度ランキング
  const srcCounts = new Map();
  for (const it of items) srcCounts.set(it.source, (srcCounts.get(it.source) || 0) + 1);
  const srcRank = [...srcCounts.entries()].sort((a, b) => b[1] - a[1]);
  const maxSrc = srcRank[0]?.[1] || 1;
  const regionOf = (name) => items.find((x) => x.source === name)?.region || "global";

  // ヒーロー: 最新の日本ニュース、サブ: 次の日本、海外トップ
  const hero = jp[0] || items[0];
  const subs = [jp[1] || items[1], gl[0] || items[2]].filter(Boolean).filter((x) => x !== hero);

  const card = (it, big = false) => {
    const d = it.date ? fmt(it.date) : "—";
    const flag = it.region === "jp" ? "🇯🇵" : "🌐";
    const tags = tagsFor(it).map((t) => `<span class="tag ${t.cls}">${esc(t.label)}</span>`).join("");
    return `<a class="card${big ? " big" : ""}" href="${esc(it.link)}" target="_blank" rel="noopener"
       data-region="${it.region}" data-source="${esc(it.source)}"
       data-text="${esc((it.title + " " + it.summary).toLowerCase())}">
      <div class="tags">${tags}</div>
      <h3>${esc(it.title)}</h3>
      ${it.summary ? `<p class="summary">${esc(it.summary)}</p>` : ""}
      <div class="meta-row"><span class="src">${flag} ${esc(it.source)}</span><span class="date">${d}</span></div>
    </a>`;
  };

  const heroHtml = hero ? `
    <section class="hero">
      <div class="hero-label">🔥 THIS WEEK'S TOP STORY</div>
      <a class="hero-card" href="${esc(hero.link)}" target="_blank" rel="noopener">
        <div class="tags">${tagsFor(hero).map((t) => `<span class="tag ${t.cls}">${esc(t.label)}</span>`).join("")}</div>
        <h2>${esc(hero.title)}</h2>
        ${hero.summary ? `<p>${esc(hero.summary)}</p>` : ""}
        <div class="meta-row"><span>${hero.region === "jp" ? "🇯🇵" : "🌐"} ${esc(hero.source)}</span><span>${hero.date ? fmt(hero.date) : "—"}</span></div>
      </a>
      <div class="sub-grid">${subs.map((s) => card(s)).join("")}</div>
    </section>` : "";

  const buzzHtml = buzz.length ? `
    <section class="panel buzz-panel">
      <h3 class="panel-title">📈 今週のバズワード TOP${buzz.length}</h3>
      <ol class="buzz">${buzz.map(([w, n], i) => `
        <li><span class="rank">${i + 1}</span>
          <button class="buzz-word" data-q="${esc(w)}">${esc(w)}</button>
          <span class="bar"><span style="width:${(n / maxBuzz) * 100}%"></span></span>
          <span class="cnt">${n}</span>
        </li>`).join("")}</ol>
    </section>` : "";

  const rankHtml = srcRank.length ? `
    <section class="panel">
      <h3 class="panel-title">📊 メディア活性度ランキング</h3>
      <ol class="srcrank">${srcRank.map(([s, n], i) => `
        <li><span class="rank">${i + 1}</span>
          <span class="name">${regionOf(s) === "jp" ? "🇯🇵" : "🌐"} ${esc(s)}</span>
          <span class="bar"><span style="width:${(n / maxSrc) * 100}%"></span></span>
          <span class="cnt">${n}</span>
        </li>`).join("")}</ol>
    </section>` : "";

  const cardsHtml = items.map((it) => card(it)).join("");

  const srcOptions = [...new Set(items.map((x) => x.source))].sort()
    .map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("");

  const statusRows = status.map((s) => {
    const flag = s.region === "jp" ? "🇯🇵" : "🌐";
    return s.ok
      ? `<li><span class="ok">●</span> ${flag} ${esc(s.name)} — 期間内 <b>${s.hit}</b>件（全${s.total}件取得）</li>`
      : `<li><span class="ng">●</span> ${flag} ${esc(s.name)} — 取得失敗 <span class="err">${esc(s.error)}</span></li>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="ja" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>EdTech WEEKLY ${rangeLabel}</title>
<style>
  :root {
    --bg:#f7f6f2; --card:#fff; --ink:#11131a; --sub:#5b6172; --line:#e5e3dc;
    --accent:#ff2d55; --accent2:#ffb800; --link:#1d4ed8;
    --hero-bg:linear-gradient(135deg,#0f172a 0%,#1e293b 60%,#dc2626 100%);
  }
  [data-theme="dark"] {
    --bg:#0b0d12; --card:#161922; --ink:#f4f4f5; --sub:#a1a1aa; --line:#2a2e3a;
    --accent:#ff3366; --accent2:#fbbf24; --link:#93c5fd;
    --hero-bg:linear-gradient(135deg,#1e1b4b 0%,#7c3aed 50%,#ec4899 100%);
  }
  * { box-sizing: border-box; }
  html, body { margin:0; padding:0; }
  body {
    background:var(--bg); color:var(--ink);
    font-family:"Inter",-apple-system,"Segoe UI","Hiragino Kaku Gothic ProN","Yu Gothic UI",Meiryo,sans-serif;
    line-height:1.65; -webkit-font-smoothing:antialiased;
  }
  a { color:inherit; text-decoration:none; }

  /* ===== ヘッダー（雑誌風） ===== */
  .masthead { background:var(--hero-bg); color:#fff; padding:36px 28px 28px; position:relative; overflow:hidden; }
  .masthead::before {
    content:""; position:absolute; inset:0;
    background:radial-gradient(circle at 80% 20%, rgba(255,255,255,.15), transparent 50%);
  }
  .mast-inner { max-width:1180px; margin:0 auto; position:relative; }
  .brand { display:flex; align-items:baseline; gap:14px; font-weight:900; letter-spacing:.04em; font-size:38px; line-height:1; }
  .brand .accent { color:var(--accent2); }
  .brand .vol { font-size:13px; font-weight:600; opacity:.85; letter-spacing:.2em; }
  .tagline { margin-top:10px; font-size:14px; opacity:.85; }
  .badges { margin-top:18px; display:flex; flex-wrap:wrap; gap:8px; }
  .badge { background:rgba(255,255,255,.13); border:1px solid rgba(255,255,255,.25);
           padding:6px 14px; border-radius:999px; font-size:13px; font-weight:600; backdrop-filter: blur(4px); }
  .badge b { color:var(--accent2); }
  .theme-toggle { position:absolute; top:18px; right:24px; background:rgba(0,0,0,.25); color:#fff;
    border:1px solid rgba(255,255,255,.3); border-radius:999px; padding:8px 14px; cursor:pointer; font-size:13px; }

  .wrap { max-width:1180px; margin:0 auto; padding:28px 24px 60px; }

  /* ===== ヒーロー ===== */
  .hero-label { font-size:11px; font-weight:900; letter-spacing:.25em; color:var(--accent); margin-bottom:10px; }
  .hero-card {
    display:block; background:var(--card); border-radius:18px; padding:32px;
    box-shadow:0 18px 50px -20px rgba(0,0,0,.25); border:1px solid var(--line);
    transition:transform .25s ease, box-shadow .25s ease;
  }
  .hero-card:hover { transform:translateY(-4px); box-shadow:0 30px 60px -20px rgba(0,0,0,.35); }
  .hero-card h2 { font-size:28px; line-height:1.35; margin:14px 0 12px; font-weight:800; letter-spacing:-.01em; }
  .hero-card p { color:var(--sub); margin:0 0 14px; font-size:14.5px; }
  .hero-card .meta-row { display:flex; justify-content:space-between; color:var(--sub); font-size:13px; }
  .sub-grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-top:16px; }
  @media (max-width:760px){ .sub-grid { grid-template-columns:1fr; } .hero-card h2 { font-size:22px; } }

  /* ===== パネル（バズワード/ランキング）===== */
  .panels { display:grid; grid-template-columns:1fr 1fr; gap:18px; margin:28px 0 8px; }
  @media (max-width:820px){ .panels { grid-template-columns:1fr; } }
  .panel { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:20px 22px; }
  .panel-title { margin:0 0 14px; font-size:14px; font-weight:800; letter-spacing:.05em; }
  ol.buzz, ol.srcrank { list-style:none; padding:0; margin:0; }
  ol.buzz li, ol.srcrank li {
    display:grid; grid-template-columns:28px 1fr 80px 30px; gap:10px; align-items:center;
    padding:6px 0; font-size:13.5px;
  }
  .rank { color:var(--sub); font-variant-numeric:tabular-nums; font-weight:700; font-size:12px; text-align:center; }
  .buzz-word { background:transparent; border:none; color:var(--ink); font-weight:700; text-align:left; cursor:pointer; padding:0; font-size:14px; }
  .buzz-word:hover { color:var(--accent); }
  .srcrank .name { font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .bar { background:var(--line); height:8px; border-radius:99px; overflow:hidden; }
  .bar > span { display:block; height:100%; background:linear-gradient(90deg,var(--accent2),var(--accent)); border-radius:99px; }
  .cnt { color:var(--sub); font-variant-numeric:tabular-nums; text-align:right; font-size:13px; }

  /* ===== ガチャボタン ===== */
  .gacha-row { text-align:center; margin:28px 0 8px; }
  .gacha-btn {
    background:linear-gradient(135deg,var(--accent2),var(--accent));
    color:#fff; border:none; padding:14px 28px; border-radius:999px;
    font-size:16px; font-weight:800; cursor:pointer; box-shadow:0 10px 24px -8px rgba(255,45,85,.5);
    transition:transform .15s ease;
  }
  .gacha-btn:hover { transform:scale(1.05); }
  .gacha-btn:active { transform:scale(.97); }

  /* ===== ツールバー ===== */
  .toolbar {
    position:sticky; top:0; background:var(--bg); padding:14px 0; z-index:5;
    display:flex; gap:10px; flex-wrap:wrap; align-items:center; border-bottom:1px solid var(--line);
  }
  .toolbar input, .toolbar select {
    padding:9px 14px; border:1px solid var(--line); border-radius:999px; font-size:14px;
    background:var(--card); color:var(--ink);
  }
  .toolbar input[type=search]{ flex:1; min-width:200px; }
  .tabs button {
    border:1px solid var(--line); background:var(--card); color:var(--ink);
    padding:9px 16px; border-radius:999px; cursor:pointer; font-size:14px; margin-right:6px; font-weight:600;
  }
  .tabs button.active { background:var(--ink); color:var(--bg); border-color:var(--ink); }
  .count { color:var(--sub); font-size:13px; margin:18px 0 8px; font-weight:600; }

  /* ===== カード一覧 ===== */
  .cards { display:grid; grid-template-columns:repeat(auto-fill, minmax(320px,1fr)); gap:16px; }
  .card {
    background:var(--card); border:1px solid var(--line); border-radius:14px; padding:18px 20px;
    display:flex; flex-direction:column; transition:transform .2s ease, box-shadow .2s ease, border-color .2s ease;
  }
  .card:hover { transform:translateY(-3px); box-shadow:0 12px 28px -12px rgba(0,0,0,.2); border-color:var(--accent); }
  .card h3 { font-size:15.5px; line-height:1.5; margin:8px 0 8px; font-weight:700; }
  .card .summary { color:var(--sub); font-size:13px; margin:0 0 12px; flex:1; }
  .card .meta-row { display:flex; justify-content:space-between; color:var(--sub); font-size:12px; margin-top:auto; }
  .card.flash { animation: flash 1.2s ease; box-shadow:0 0 0 4px var(--accent2); }
  @keyframes flash { 0%{transform:scale(.96)} 50%{transform:scale(1.04)} 100%{transform:scale(1)} }

  /* ===== タグ ===== */
  .tags { display:flex; flex-wrap:wrap; gap:5px; }
  .tag { font-size:11px; font-weight:700; padding:3px 9px; border-radius:99px; letter-spacing:.02em; }
  .t-ai    { background:#fee2e2; color:#b91c1c; }
  .t-prog  { background:#dbeafe; color:#1e40af; }
  .t-soc   { background:#fef3c7; color:#92400e; }
  .t-univ  { background:#e0e7ff; color:#3730a3; }
  .t-k12   { background:#dcfce7; color:#166534; }
  .t-home  { background:#fce7f3; color:#9d174d; }
  .t-money { background:#fef9c3; color:#854d0e; }
  .t-data  { background:#cffafe; color:#155e75; }
  .t-ev    { background:#ede9fe; color:#5b21b6; }
  .t-teach { background:#ffedd5; color:#9a3412; }
  [data-theme="dark"] .tag { filter: brightness(.85) saturate(1.3); }

  .empty { padding:60px; text-align:center; color:var(--sub); background:var(--card); border-radius:14px; }
  details { margin-top:32px; background:var(--card); border:1px solid var(--line); border-radius:14px; padding:8px 20px; }
  details summary { cursor:pointer; font-weight:700; padding:12px 0; font-size:14px; }
  details ul { list-style:none; padding:0; margin:0 0 12px; font-size:13px; }
  details li { padding:5px 0; border-bottom:1px solid var(--line); }
  .ok { color:#16a34a; } .ng { color:#dc2626; } .err { color:#b91c1c; }
  footer { text-align:center; color:var(--sub); font-size:12px; padding:36px 20px; }
</style>
</head>
<body>
<header class="masthead">
  <button class="theme-toggle" id="themeToggle" type="button">🌙 Dark</button>
  <div class="mast-inner">
    <div class="brand">EdTech<span class="accent">WEEKLY</span> <span class="vol">VOL. ${esc(rangeLabel)}</span></div>
    <div class="tagline">今週の教育テクノロジー、ぜんぶ載せ。日本と世界のEdTechを横断スクープ。</div>
    <div class="badges">
      <span class="badge">合計 <b>${items.length}</b> 本</span>
      <span class="badge">🇯🇵 日本 <b>${jp.length}</b></span>
      <span class="badge">🌐 海外 <b>${gl.length}</b></span>
      <span class="badge">📡 ${status.filter(s=>s.ok).length}/${status.length} ソース</span>
    </div>
  </div>
</header>

<div class="wrap">
  ${heroHtml}

  <div class="panels">
    ${buzzHtml}
    ${rankHtml}
  </div>

  <div class="gacha-row">
    <button class="gacha-btn" id="gacha" type="button">🎰 ニュースガチャを引く</button>
  </div>

  <div class="toolbar">
    <div class="tabs">
      <button data-f="all" class="active">すべて (${items.length})</button>
      <button data-f="jp">🇯🇵 日本 (${jp.length})</button>
      <button data-f="global">🌐 海外 (${gl.length})</button>
    </div>
    <select id="srcFilter"><option value="">全ソース</option>${srcOptions}</select>
    <input type="search" id="search" placeholder="🔍 キーワードで絞り込み（例: 生成AI, ChatGPT, university）">
  </div>
  <div class="count" id="count"></div>

  ${items.length === 0
    ? `<div class="empty">この期間のニュースは見つかりませんでした。<br>期間を広げて再実行してください（例: <code>node fetch-news.js --days 14</code>）。</div>`
    : `<div class="cards" id="list">${cardsHtml}</div>`}

  <details>
    <summary>📊 ソース取得ステータス（${status.filter(s=>s.ok).length}/${status.length} 成功）</summary>
    <ul>${statusRows}</ul>
  </details>
</div>
<footer>EdTech WEEKLY — RSSから自動収集 / バズワードはタイトル＋要約から頻度抽出 / 各記事は各媒体の元ページへ</footer>

<script>
  // テーマ切替
  const themeBtn = document.getElementById('themeToggle');
  const root = document.documentElement;
  const saved = localStorage.getItem('edtech-theme');
  if (saved) root.dataset.theme = saved;
  themeBtn.textContent = root.dataset.theme === 'dark' ? '☀️ Light' : '🌙 Dark';
  themeBtn.addEventListener('click', () => {
    root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
    themeBtn.textContent = root.dataset.theme === 'dark' ? '☀️ Light' : '🌙 Dark';
    localStorage.setItem('edtech-theme', root.dataset.theme);
  });

  // フィルタ
  const cards = [...document.querySelectorAll('#list .card')];
  const countEl = document.getElementById('count');
  const searchEl = document.getElementById('search');
  const srcEl = document.getElementById('srcFilter');
  let region = 'all';
  function apply() {
    const q = searchEl.value.trim().toLowerCase();
    const src = srcEl.value;
    let n = 0;
    cards.forEach(c => {
      const okR = region === 'all' || c.dataset.region === region;
      const okS = !src || c.dataset.source === src;
      const okQ = !q || c.dataset.text.includes(q);
      const show = okR && okS && okQ;
      c.style.display = show ? '' : 'none';
      if (show) n++;
    });
    countEl.textContent = n + ' 件を表示中';
  }
  document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach(x => x.classList.remove('active'));
    b.classList.add('active'); region = b.dataset.f; apply();
  }));
  searchEl.addEventListener('input', apply);
  srcEl.addEventListener('change', apply);

  // バズワードクリック→検索
  document.querySelectorAll('.buzz-word').forEach(b => b.addEventListener('click', () => {
    searchEl.value = b.dataset.q;
    region = 'all';
    document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('active', x.dataset.f === 'all'));
    apply();
    searchEl.scrollIntoView({ behavior:'smooth', block:'start' });
  }));

  // ニュースガチャ
  document.getElementById('gacha').addEventListener('click', () => {
    const visible = cards.filter(c => c.style.display !== 'none');
    const pool = visible.length ? visible : cards;
    if (!pool.length) return;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    document.querySelectorAll('.card.flash').forEach(c => c.classList.remove('flash'));
    pick.classList.add('flash');
    pick.scrollIntoView({ behavior:'smooth', block:'center' });
  });

  apply();
</script>
</body>
</html>`;
}

if (require.main === module) {
  main().catch((e) => { console.error("エラー:", e); process.exit(1); });
}

module.exports = { parseFeed, fetchText, resolveRange };
