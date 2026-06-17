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

function renderHtml({ items, from, to, status, fmt }) {
  const rangeLabel = `${fmt(from)} 〜 ${fmt(to)}`;
  const jp = items.filter((x) => x.region === "jp");
  const gl = items.filter((x) => x.region === "global");

  const row = (it) => {
    const d = it.date ? fmt(it.date) : "—";
    const flag = it.region === "jp" ? "🇯🇵" : "🌐";
    return `<tr data-region="${it.region}" data-source="${esc(it.source)}" data-text="${esc((it.title + " " + it.summary).toLowerCase())}">
      <td class="date">${d}</td>
      <td class="src">${flag} ${esc(it.source)}</td>
      <td class="title"><a href="${esc(it.link)}" target="_blank" rel="noopener">${esc(it.title)}</a>
        ${it.summary ? `<div class="summary">${esc(it.summary)}</div>` : ""}</td>
    </tr>`;
  };

  const srcOptions = [...new Set(items.map((x) => x.source))].sort()
    .map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("");

  const statusRows = status.map((s) => {
    const flag = s.region === "jp" ? "🇯🇵" : "🌐";
    return s.ok
      ? `<li><span class="ok">●</span> ${flag} ${esc(s.name)} — 期間内 <b>${s.hit}</b>件（全${s.total}件取得）</li>`
      : `<li><span class="ng">●</span> ${flag} ${esc(s.name)} — 取得失敗 <span class="err">${esc(s.error)}</span></li>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>EdTechニュース一覧 ${rangeLabel}</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --ink:#1f2430; --sub:#6b7280; --line:#e5e7eb; --accent:#2563eb; --jp:#dc2626; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font-family:-apple-system,"Segoe UI","Hiragino Kaku Gothic ProN","Yu Gothic UI",Meiryo,sans-serif; line-height:1.6; }
  header { background:linear-gradient(135deg,#1e3a8a,#2563eb); color:#fff; padding:28px 24px; }
  header h1 { margin:0 0 4px; font-size:22px; }
  header .meta { opacity:.9; font-size:14px; }
  .wrap { max-width:1080px; margin:0 auto; padding:20px 24px 60px; }
  .toolbar { position:sticky; top:0; background:var(--bg); padding:14px 0; display:flex; gap:10px; flex-wrap:wrap; align-items:center; border-bottom:1px solid var(--line); z-index:5; }
  .toolbar input, .toolbar select { padding:8px 12px; border:1px solid var(--line); border-radius:8px; font-size:14px; background:#fff; }
  .toolbar input[type=search]{ flex:1; min-width:200px; }
  .tabs button { border:1px solid var(--line); background:#fff; padding:8px 14px; border-radius:999px; cursor:pointer; font-size:14px; margin-right:6px; }
  .tabs button.active { background:var(--accent); color:#fff; border-color:var(--accent); }
  .count { color:var(--sub); font-size:13px; margin:14px 0 6px; }
  table { width:100%; border-collapse:collapse; background:var(--card); border-radius:12px; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,.06); }
  td { padding:14px 16px; border-bottom:1px solid var(--line); vertical-align:top; }
  tr:last-child td { border-bottom:none; }
  td.date { white-space:nowrap; color:var(--sub); font-size:13px; width:96px; font-variant-numeric:tabular-nums; }
  td.src { white-space:nowrap; font-size:13px; color:var(--sub); width:150px; }
  td.title a { color:var(--ink); text-decoration:none; font-weight:600; font-size:15.5px; }
  td.title a:hover { color:var(--accent); text-decoration:underline; }
  .summary { color:var(--sub); font-size:13px; margin-top:4px; }
  .empty { padding:40px; text-align:center; color:var(--sub); }
  details { margin-top:30px; background:var(--card); border-radius:12px; padding:8px 18px; box-shadow:0 1px 3px rgba(0,0,0,.06); }
  details summary { cursor:pointer; font-weight:600; padding:10px 0; }
  details ul { list-style:none; padding:0; margin:0 0 10px; font-size:13px; }
  details li { padding:5px 0; border-bottom:1px solid var(--line); }
  .ok { color:#16a34a; } .ng { color:#dc2626; } .err { color:#b91c1c; }
  footer { text-align:center; color:var(--sub); font-size:12px; padding:30px; }
</style>
</head>
<body>
<header>
  <h1>📰 EdTechニュース一覧</h1>
  <div class="meta">期間: ${rangeLabel} ／ 日本 ${jp.length}件・海外 ${gl.length}件・合計 ${items.length}件 ／ 生成: ${esc(new Date().toLocaleString("ja-JP"))}</div>
</header>
<div class="wrap">
  <div class="toolbar">
    <div class="tabs">
      <button data-f="all" class="active">すべて (${items.length})</button>
      <button data-f="jp">🇯🇵 日本 (${jp.length})</button>
      <button data-f="global">🌐 海外 (${gl.length})</button>
    </div>
    <select id="srcFilter"><option value="">全ソース</option>${srcOptions}</select>
    <input type="search" id="search" placeholder="キーワードで絞り込み（例: 生成AI, university, ChatGPT）">
  </div>
  <div class="count" id="count"></div>
  ${items.length === 0
    ? `<div class="empty">この期間のニュースは見つかりませんでした。<br>期間を広げて再実行してください（例: <code>node fetch-news.js --days 14</code>）。</div>`
    : `<table><tbody id="list">${items.map(row).join("")}</tbody></table>`}

  <details>
    <summary>📊 ソース取得ステータス（${status.filter(s=>s.ok).length}/${status.length} 成功）</summary>
    <ul>${statusRows}</ul>
  </details>
</div>
<footer>EdTech News Collector — RSSから自動収集。記事リンクは各媒体の元ページへ移動します。</footer>
<script>
  const rows = [...document.querySelectorAll('#list tr')];
  const countEl = document.getElementById('count');
  let region = 'all';
  function apply() {
    const q = document.getElementById('search').value.trim().toLowerCase();
    const src = document.getElementById('srcFilter').value;
    let n = 0;
    rows.forEach(r => {
      const okR = region === 'all' || r.dataset.region === region;
      const okS = !src || r.dataset.source === src;
      const okQ = !q || r.dataset.text.includes(q);
      const show = okR && okS && okQ;
      r.style.display = show ? '' : 'none';
      if (show) n++;
    });
    countEl.textContent = n + '件を表示中';
  }
  document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach(x => x.classList.remove('active'));
    b.classList.add('active'); region = b.dataset.f; apply();
  }));
  document.getElementById('search').addEventListener('input', apply);
  document.getElementById('srcFilter').addEventListener('change', apply);
  apply();
</script>
</body>
</html>`;
}

if (require.main === module) {
  main().catch((e) => { console.error("エラー:", e); process.exit(1); });
}

module.exports = { parseFeed, fetchText, resolveRange };
