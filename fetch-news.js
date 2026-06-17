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
  const args = { days: 7, from: null, to: null, open: true, serve: false, port: 3000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--days") args.days = parseInt(argv[++i], 10);
    else if (a === "--from") args.from = argv[++i];
    else if (a === "--to") args.to = argv[++i];
    else if (a === "--no-open") args.open = false;
    else if (a === "--serve") args.serve = true;
    else if (a === "--port") args.port = parseInt(argv[++i], 10) || 3000;
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

// ---------- 収集ロジック（コアパイプライン・再利用可能） ----------
async function collect({ from, to, verbose = true, isServer = false }) {
  const fmt = fmtDate;
  if (verbose) console.log(`\n📡 EdTechニュース収集中... 期間: ${fmt(from)} 〜 ${fmt(to)}\n`);

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
      const inRange = r.value.items.filter((it) => it.date && it.date >= from && it.date <= to);
      all = all.concat(inRange);
      status.push({ name: s.name, region: s.region, ok: true, total: r.value.items.length, hit: inRange.length });
      if (verbose) console.log(`  ✅ ${s.name.padEnd(18)} 取得${String(r.value.items.length).padStart(3)}件 → 期間内${inRange.length}件`);
    } else {
      status.push({ name: s.name, region: s.region, ok: false, error: String(r.reason && r.reason.message || r.reason) });
      if (verbose) console.log(`  ⚠️  ${s.name.padEnd(18)} 取得失敗: ${r.reason && r.reason.message || r.reason}`);
    }
  });

  // 重複除去 → 日付降順
  const seen = new Set();
  all = all.filter((it) => { if (seen.has(it.link)) return false; seen.add(it.link); return true; });
  all.sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0));

  if (verbose) {
    const jp = all.filter((x) => x.region === "jp").length;
    const gl = all.filter((x) => x.region === "global").length;
    console.log(`\n📰 合計 ${all.length}件（日本 ${jp} / 海外 ${gl}）\n`);
  }

  return renderHtml({ items: all, from, to, status, fmt, isServer });
}

// ---------- 静的生成モード（従来挙動） ----------
async function generateStatic(args) {
  const { from, to } = resolveRange(args);
  const fmt = fmtDate;
  const html = await collect({ from, to, verbose: true, isServer: false });
  const outDir = path.join(__dirname, "reports");
  fs.mkdirSync(outDir, { recursive: true });
  const outName = `edtech-news_${fmt(from)}_${fmt(to)}.html`;
  const outPath = path.join(outDir, outName);
  fs.writeFileSync(outPath, html, "utf8");
  fs.writeFileSync(path.join(__dirname, "index.html"), html, "utf8");
  console.log(`✅ レポート生成: ${outPath}\n`);
  if (args.open) openInBrowser(outPath);
}

// ---------- サーバーモード ----------
const CACHE = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5分

async function startServer(port) {
  const http = require("http");
  const url = require("url");
  const fmt = fmtDate;

  const server = http.createServer(async (req, res) => {
    const u = url.parse(req.url, true);
    if (u.pathname !== "/" && u.pathname !== "/index.html") {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404 Not Found");
      return;
    }
    const args = { days: 7, from: u.query.from || null, to: u.query.to || null };
    if (u.query.days) args.days = parseInt(u.query.days, 10) || 7;
    let from, to;
    try { ({ from, to } = resolveRange(args)); }
    catch (e) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Invalid date range: " + e.message);
      return;
    }
    const key = `${fmt(from)}|${fmt(to)}`;
    const cached = CACHE.get(key);
    if (cached && Date.now() - cached.t < CACHE_TTL) {
      console.log(`  ⚡ キャッシュHIT: ${key}`);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(cached.html);
      return;
    }
    try {
      console.log(`\n🔄 リクエスト: ${key}`);
      const html = await collect({ from, to, verbose: true, isServer: true });
      CACHE.set(key, { html, t: Date.now() });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (e) {
      console.error("Server error:", e);
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Server error: " + e.message);
    }
  });

  server.listen(port, () => {
    const URL = `http://localhost:${port}/`;
    console.log(`\n🚀 EdTech WEEKLY サーバー起動: ${URL}`);
    console.log(`   📅 期間: URLパラメータ ?from=YYYY-MM-DD&to=YYYY-MM-DD で指定可\n`);
    openInBrowser(URL);
  });
}

// ---------- メイン ----------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(__filename, "utf8").split("*/")[0].replace(/\/\*\*?/, ""));
    return;
  }
  if (args.serve) {
    await startServer(args.port || 3000);
  } else {
    await generateStatic(args);
  }
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

// レアリティ判定（タグ数 + 海外×資金調達でSSR）
function rarityOf(it) {
  const tags = tagsFor(it);
  const txt = it.title + " " + (it.summary || "");
  const ssr = (it.region === "global" && /(funding|raises?|million|資金調達|億円)/i.test(txt)) || tags.length >= 4;
  if (ssr) return { key: "SSR", label: "✨ SSR", cls: "r-ssr" };
  if (tags.length >= 3) return { key: "SR", label: "💎 SR", cls: "r-sr" };
  if (tags.length >= 1) return { key: "R",  label: "🔵 R",  cls: "r-r"  };
  return { key: "N", label: "⚪ N", cls: "r-n" };
}

function renderHtml({ items, from, to, status, fmt, isServer = false }) {
  const rangeLabel = `${fmt(from)} 〜 ${fmt(to)}`;
  const jp = items.filter((x) => x.region === "jp");
  const gl = items.filter((x) => x.region === "global");
  const buzz = extractKeywords(items);
  const maxBuzz = buzz[0]?.[1] || 1;

  const srcCounts = new Map();
  for (const it of items) srcCounts.set(it.source, (srcCounts.get(it.source) || 0) + 1);
  const srcRank = [...srcCounts.entries()].sort((a, b) => b[1] - a[1]);
  const maxSrc = srcRank[0]?.[1] || 1;
  const regionOf = (name) => items.find((x) => x.source === name)?.region || "global";

  const hero = jp[0] || items[0];
  const subs = [jp[1] || items[1], gl[0] || items[2]].filter(Boolean).filter((x) => x !== hero);

  // ビンゴのお題（9マス・タグラベル）
  const BINGO = ["生成AI", "プログラミング", "K-12", "大学", "不登校支援", "家庭・保護者", "資金調達", "データ", "イベント"];

  // おみくじ（日替わり・決定論）
  const FORTUNES = [
    { e: "🌈", t: "大吉", m: "今日のニュースは宝の山！どんどん読破しよう！" },
    { e: "🎯", t: "中吉", m: "気になるタグから攻めるとレアが出るかも。" },
    { e: "🎰", t: "ガチャ吉", m: "今日はガチャの引きが冴える日。連打せよ！" },
    { e: "🔥", t: "バズ吉", m: "バズワードを起点に読むとハマる予感。" },
    { e: "🌸", t: "小吉", m: "日本のニュースに今日の発見が眠ってる。" },
    { e: "🌐", t: "海外吉", m: "海外フィードに目を向ける一日にしよう。" },
  ];
  const dateSeed = fmt(new Date()).split("-").join("");
  const seed = [...dateSeed].reduce((a, c) => a + c.charCodeAt(0), 0);
  const todaysFortune = FORTUNES[seed % FORTUNES.length];

  // デイリーチャレンジ（日替わり・決定論）
  const CHALLENGES = [
    [{ k: "jp", n: 3, l: "🇯🇵 日本のニュース3本を読了" }, { k: "gl", n: 2, l: "🌐 海外のニュース2本を読了" }, { k: "tag:生成AI", n: 1, l: "🤖 生成AIタグの記事を1本" }],
    [{ k: "any", n: 5, l: "📰 何でもいいから5本読了" }, { k: "tag:大学", n: 1, l: "🎓 大学タグを1本" }, { k: "tag:資金調達", n: 1, l: "💰 資金調達タグを1本" }],
    [{ k: "gacha", n: 3, l: "🎰 ガチャを3回引く" }, { k: "fav", n: 2, l: "⭐ 2記事をお気に入り" }, { k: "tag:K-12", n: 1, l: "🏫 K-12タグを1本" }],
    [{ k: "jp", n: 5, l: "🇯🇵 日本ニュース5本を読了" }, { k: "tag:プログラミング", n: 1, l: "💻 プログラミングタグを1本" }, { k: "gacha", n: 1, l: "🎰 ガチャを1回" }],
  ];
  const todaysChallenge = CHALLENGES[seed % CHALLENGES.length];

  const card = (it) => {
    const d = it.date ? fmt(it.date) : "—";
    const flag = it.region === "jp" ? "🇯🇵" : "🌐";
    const tagObjs = tagsFor(it);
    const tags = tagObjs.map((t) => `<span class="tag ${t.cls}">${esc(t.label)}</span>`).join("");
    const tagKeys = tagObjs.map((t) => t.label).join("|");
    const rar = rarityOf(it);
    return `<article class="card ${rar.cls}"
       data-region="${it.region}" data-source="${esc(it.source)}"
       data-text="${esc((it.title + " " + it.summary).toLowerCase())}"
       data-link="${esc(it.link)}" data-title="${esc(it.title)}"
       data-tags="${esc(tagKeys)}" data-rarity="${rar.key}">
      <div class="card-top">
        <span class="rarity ${rar.cls}">${rar.label}</span>
        <div class="tags">${tags}</div>
      </div>
      <a class="card-link" href="${esc(it.link)}" target="_blank" rel="noopener">
        <h3>${esc(it.title)}</h3>
        ${it.summary ? `<p class="summary">${esc(it.summary)}</p>` : ""}
      </a>
      <div class="meta-row"><span class="src">${flag} ${esc(it.source)}</span><span class="date">${d}</span></div>
      <div class="actions">
        <button class="act-read" type="button" data-act="read">✓ 読了 <span class="plus">+10XP</span></button>
        <button class="act-fav"  type="button" data-act="fav">⭐ お気に入り <span class="plus">+5XP</span></button>
      </div>
    </article>`;
  };

  const heroHtml = hero ? `
    <section class="hero">
      <div class="hero-label"><span class="wobble">🔥 THIS WEEK'S TOP STORY 🔥</span></div>
      <div class="hero-card ${rarityOf(hero).cls}">
        <div class="card-top">
          <span class="rarity ${rarityOf(hero).cls}">${rarityOf(hero).label}</span>
          <div class="tags">${tagsFor(hero).map((t) => `<span class="tag ${t.cls}">${esc(t.label)}</span>`).join("")}</div>
        </div>
        <a class="card-link" href="${esc(hero.link)}" target="_blank" rel="noopener">
          <h2>${esc(hero.title)}</h2>
          ${hero.summary ? `<p>${esc(hero.summary)}</p>` : ""}
        </a>
        <div class="meta-row"><span>${hero.region === "jp" ? "🇯🇵" : "🌐"} ${esc(hero.source)}</span><span>${hero.date ? fmt(hero.date) : "—"}</span></div>
      </div>
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

  const bingoHtml = `
    <section class="panel bingo-panel">
      <h3 class="panel-title">🎴 EdTech BINGO! <span class="hint">読了した記事のタグでマスが埋まる → 縦・横・斜めで <b>ビンゴ！</b></span></h3>
      <div class="bingo">${BINGO.map((b, i) => `<div class="bcell" data-tag="${esc(b)}"><div class="bcell-stamp">✓</div><span>${esc(b)}</span></div>`).join("")}</div>
    </section>`;

  const challengeHtml = `
    <section class="panel challenge-panel">
      <h3 class="panel-title">🎯 今日のデイリーチャレンジ</h3>
      <ul class="challenges">${todaysChallenge.map((c, i) => `
        <li data-kind="${esc(c.k)}" data-need="${c.n}">
          <span class="ctxt">${esc(c.l)}</span>
          <span class="cbar"><span class="cbar-fill"></span></span>
          <span class="cnum"><b class="cdone">0</b>/${c.n}</span>
        </li>`).join("")}</ul>
    </section>`;

  const fortuneHtml = `
    <section class="panel fortune-panel">
      <h3 class="panel-title">🔮 今日のEdTech運勢</h3>
      <div class="fortune">
        <div class="f-emoji">${todaysFortune.e}</div>
        <div class="f-text"><div class="f-title">${esc(todaysFortune.t)}</div><div class="f-msg">${esc(todaysFortune.m)}</div></div>
      </div>
    </section>`;

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
<title>📰 EdTech FUN! WEEKLY ${rangeLabel}</title>
<style>
  :root {
    --pink:#ff5e9c; --orange:#fdba74; --yellow:#fde047; --mint:#86efac; --sky:#7dd3fc; --purple:#c4b5fd;
    --hot:#ff2d6f; --gold:#fbbf24; --grass:#22c55e; --azure:#06b6d4; --violet:#a855f7;
    --card:#ffffff; --ink:#1a1530; --sub:#6b6685; --line:#f2e9f5;
    --rainbow:linear-gradient(90deg,#ff5e9c,#fdba74,#fde047,#86efac,#7dd3fc,#c4b5fd,#ff5e9c);
  }
  [data-theme="dark"] {
    --card:#1f1a2e; --ink:#fbeefb; --sub:#b8aed0; --line:#39305a;
  }
  * { box-sizing: border-box; }
  html, body { margin:0; padding:0; }
  body {
    color:var(--ink);
    font-family:"Inter","Hiragino Maru Gothic ProN","Yu Gothic UI",-apple-system,"Segoe UI",Meiryo,sans-serif;
    line-height:1.7; -webkit-font-smoothing:antialiased;
    background:
      radial-gradient(900px 600px at 10% -10%, #ffd6e7 0%, transparent 60%),
      radial-gradient(900px 600px at 90% 10%, #fef3c7 0%, transparent 55%),
      radial-gradient(900px 600px at 50% 110%, #d4fbff 0%, transparent 60%),
      linear-gradient(135deg,#fff5fb 0%,#fff7ea 33%,#ecfdf5 66%,#eef2ff 100%);
    background-attachment: fixed;
    animation: bgshift 24s ease-in-out infinite alternate;
  }
  @keyframes bgshift { 0%{filter:hue-rotate(0deg)} 100%{filter:hue-rotate(20deg)} }
  [data-theme="dark"] body {
    background:
      radial-gradient(900px 600px at 10% -10%, #4c1d44 0%, transparent 60%),
      radial-gradient(900px 600px at 90% 10%, #1e3a5f 0%, transparent 55%),
      radial-gradient(900px 600px at 50% 110%, #1b1339 0%, transparent 60%),
      #0e0a1d;
  }
  a { color:inherit; text-decoration:none; }
  ::selection { background:#ffd1e7; }

  /* ===== ヘッダー（ポップ） ===== */
  .masthead { padding:40px 24px 22px; text-align:center; position:relative; }
  .brand {
    font-size:56px; font-weight:900; letter-spacing:-.01em; line-height:1.05;
    background:var(--rainbow); background-size:300% 100%;
    -webkit-background-clip:text; background-clip:text; color:transparent;
    animation: rainbow 6s linear infinite, wobble 2.4s ease-in-out infinite;
    text-shadow: 0 6px 24px rgba(255,94,156,.18);
    display:inline-block;
  }
  @keyframes rainbow { to { background-position: 300% 0; } }
  @keyframes wobble { 0%,100% { transform:rotate(-1deg) translateY(0); } 50% { transform:rotate(1deg) translateY(-4px); } }
  .vol { display:inline-block; margin-top:8px; padding:6px 18px; border-radius:999px;
    background:#fff; border:2px dashed var(--hot); color:var(--hot); font-weight:800; font-size:13px; letter-spacing:.15em; }
  .tagline { margin-top:14px; font-size:15px; color:var(--sub); font-weight:600; }
  .tagline span { display:inline-block; padding:0 4px; }
  .theme-toggle { position:absolute; top:18px; right:20px; background:#fff; color:var(--ink);
    border:2px solid var(--line); border-radius:999px; padding:8px 14px; cursor:pointer; font-size:13px; font-weight:700;
    box-shadow:0 6px 16px -6px rgba(0,0,0,.15); }
  .theme-toggle:hover { transform:translateY(-2px); }

  /* ===== 期間選択パネル ===== */
  .period-panel {
    max-width:1180px; margin:14px auto 0; padding:14px 20px;
    background:var(--card); border:3px solid var(--line); border-radius:18px;
    display:flex; gap:12px; align-items:center; flex-wrap:wrap;
    box-shadow:0 6px 18px -10px rgba(0,0,0,.1);
  }
  .period-panel .pp-label { font-weight:900; color:var(--ink); font-size:14px; }
  .period-panel input[type=date] {
    padding:9px 14px; border:2px solid var(--line); border-radius:99px; font-size:14px; font-weight:600;
    background:#fff; color:var(--ink); font-family:inherit;
  }
  [data-theme="dark"] .period-panel input[type=date] { background:#2a2240; color:var(--ink); color-scheme: dark; }
  .period-panel .pp-arrow { color:var(--sub); font-weight:700; }
  .period-panel .pp-presets { display:flex; gap:6px; flex-wrap:wrap; }
  .period-panel .pp-preset {
    border:2px solid var(--line); background:#fff; color:var(--ink);
    padding:7px 14px; border-radius:99px; cursor:pointer; font-size:13px; font-weight:800;
    transition:transform .15s;
  }
  [data-theme="dark"] .period-panel .pp-preset { background:#2a2240; }
  .period-panel .pp-preset:hover { transform:translateY(-2px); }
  .period-panel .pp-submit {
    border:none; background:linear-gradient(135deg,var(--hot),var(--violet)); color:#fff;
    padding:10px 22px; border-radius:99px; cursor:pointer; font-size:14px; font-weight:900;
    box-shadow:0 8px 18px -6px rgba(255,45,111,.5); transition:transform .15s;
    margin-left:auto;
  }
  .period-panel .pp-submit:hover { transform:scale(1.05); }
  .period-panel .pp-static-note {
    color:#92400e; font-size:13px; font-weight:800; margin-left:auto;
    background:linear-gradient(135deg,#fef9c3,#fde68a); padding:8px 16px; border-radius:99px; border:2px solid #f59e0b;
    display:flex; align-items:center; gap:6px;
  }
  [data-theme="dark"] .period-panel .pp-static-note { background:linear-gradient(135deg,#3a3015,#4a3a18); border-color:#a16207; color:#fde68a; }
  .period-panel .pp-static-note code { background:rgba(0,0,0,.1); padding:1px 6px; border-radius:6px; font-size:11px; }
  .period-panel.loading { opacity:.6; pointer-events:none; }
  .period-panel.loading::after {
    content:"取得中..."; color:var(--hot); font-weight:900; margin-left:8px;
  }
  @media (max-width:760px){
    .period-panel { gap:8px; padding:12px 14px; }
    .period-panel .pp-submit, .period-panel .pp-static-note { margin-left:0; }
  }

  /* ===== プレイヤーステータスバー ===== */
  .playerbar { position:sticky; top:0; z-index:30; background:var(--card); border-bottom:3px solid var(--hot);
    box-shadow:0 4px 16px -8px rgba(0,0,0,.1); padding:10px 18px; }
  .pb-inner { max-width:1180px; margin:0 auto; display:flex; align-items:center; gap:14px; flex-wrap:wrap; font-size:13.5px; font-weight:700; }
  .pb-avatar { width:38px; height:38px; border-radius:50%; background:var(--rainbow); background-size:200% 100%;
    display:grid; place-items:center; font-size:22px; box-shadow:0 4px 12px rgba(255,94,156,.4); animation: rainbow 6s linear infinite; }
  .pb-stat { display:flex; align-items:center; gap:6px; padding:6px 12px; background:#fff5fb; border:2px solid var(--line); border-radius:999px; }
  [data-theme="dark"] .pb-stat { background:#2a2240; }
  .pb-stat b { color:var(--hot); font-size:15px; }
  .pb-xpbar { flex:1; min-width:150px; height:14px; background:var(--line); border-radius:99px; overflow:hidden; position:relative; }
  .pb-xpfill { height:100%; background:linear-gradient(90deg,var(--gold),var(--hot),var(--violet)); width:0%; transition:width .6s cubic-bezier(.4,1.6,.4,1); }
  .pb-xptxt { position:absolute; inset:0; display:grid; place-items:center; font-size:11px; font-weight:800; color:#fff; text-shadow:0 1px 2px rgba(0,0,0,.4); }
  .pb-prog { display:flex; align-items:center; gap:6px; padding:6px 12px; background:linear-gradient(135deg,var(--mint),var(--sky)); border-radius:999px; color:#fff; }
  .pb-prog b { font-size:15px; }
  .pb-badges { display:flex; gap:4px; flex-wrap:wrap; }
  .pb-badge { font-size:18px; padding:4px 6px; background:#fff; border:2px solid var(--line); border-radius:8px;
    animation: pop .5s cubic-bezier(.34,1.56,.64,1); cursor:default; }
  .pb-badge:hover { transform: scale(1.2) rotate(8deg); }
  @keyframes pop { 0%{transform:scale(0) rotate(-90deg)} 100%{transform:scale(1) rotate(0)} }

  .wrap { max-width:1180px; margin:0 auto; padding:28px 24px 60px; }

  /* ===== ヒーロー ===== */
  .hero-label { text-align:center; margin-bottom:16px; font-size:14px; font-weight:900; letter-spacing:.2em; color:var(--hot); }
  .wobble { display:inline-block; animation: wobble 1.6s ease-in-out infinite; }
  .hero-card {
    background:var(--card); border-radius:24px; padding:32px;
    box-shadow:0 20px 50px -18px rgba(255,94,156,.35);
    border:3px solid transparent;
    background-clip: padding-box;
    position:relative;
    transition:transform .25s ease;
  }
  .hero-card::before {
    content:""; position:absolute; inset:-3px; border-radius:24px; padding:3px;
    background:var(--rainbow); background-size:300% 100%;
    -webkit-mask:linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
    -webkit-mask-composite: xor; mask-composite: exclude;
    animation: rainbow 5s linear infinite;
    pointer-events:none;
  }
  .hero-card:hover { transform:translateY(-4px) rotate(-.5deg); }
  .hero-card h2 { font-size:30px; line-height:1.4; margin:14px 0 12px; font-weight:900; letter-spacing:-.01em; }
  .hero-card p { color:var(--sub); margin:0 0 14px; font-size:14.5px; }
  .hero-card .meta-row { display:flex; justify-content:space-between; color:var(--sub); font-size:13px; font-weight:700; }
  .card-link { display:block; }
  .sub-grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-top:16px; }
  @media (max-width:760px){ .sub-grid { grid-template-columns:1fr; } .hero-card h2 { font-size:22px; } .brand { font-size:40px; } }

  /* ===== パネル ===== */
  .panels { display:grid; grid-template-columns:1fr 1fr; gap:18px; margin:28px 0 8px; }
  @media (max-width:820px){ .panels { grid-template-columns:1fr; } }
  .panel { background:var(--card); border:3px solid var(--line); border-radius:20px; padding:22px 24px;
    box-shadow:0 10px 30px -16px rgba(0,0,0,.1); transition:transform .2s; }
  .panel:hover { transform:translateY(-2px); }
  .panel-title { margin:0 0 14px; font-size:16px; font-weight:900; letter-spacing:.03em; display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
  .panel-title .hint { font-size:12px; font-weight:600; color:var(--sub); }
  .fortune-panel { background:linear-gradient(135deg,#fff5fb 0%,#ffe4f1 100%); border-color:var(--pink); }
  [data-theme="dark"] .fortune-panel { background:linear-gradient(135deg,#3a2342 0%,#2a1538 100%); }
  .fortune { display:flex; gap:18px; align-items:center; }
  .f-emoji { font-size:64px; line-height:1; animation: bounce 1.6s ease-in-out infinite; }
  @keyframes bounce { 0%,100%{transform:translateY(0) scale(1)} 50%{transform:translateY(-10px) scale(1.05)} }
  .f-title { font-size:22px; font-weight:900; color:var(--hot); margin-bottom:4px; }
  .f-msg { font-size:14px; color:var(--ink); }

  /* チャレンジ */
  .challenge-panel { background:linear-gradient(135deg,#fffbe7 0%,#fff3c4 100%); border-color:var(--gold); }
  [data-theme="dark"] .challenge-panel { background:linear-gradient(135deg,#3a3015 0%,#2a2110 100%); }
  .challenges { list-style:none; padding:0; margin:0; }
  .challenges li { display:grid; grid-template-columns: 1fr 100px 50px; gap:10px; align-items:center; padding:8px 0; font-size:13.5px; font-weight:700; }
  .challenges li.done .ctxt { text-decoration: line-through; color:var(--sub); }
  .cbar { background:#fff; border:2px solid var(--gold); height:14px; border-radius:99px; overflow:hidden; }
  .cbar-fill { display:block; height:100%; background:linear-gradient(90deg,var(--gold),var(--hot)); width:0%; transition:width .6s cubic-bezier(.4,1.6,.4,1); }
  .cnum { text-align:right; font-variant-numeric:tabular-nums; color:var(--sub); }
  .cnum b { color:var(--hot); font-size:16px; }

  /* ビンゴ */
  .bingo-panel { background:linear-gradient(135deg,#ecfdf5 0%,#d1fae5 100%); border-color:var(--grass); }
  [data-theme="dark"] .bingo-panel { background:linear-gradient(135deg,#0f3a2a 0%,#0a2a20 100%); }
  .bingo { display:grid; grid-template-columns: repeat(3,1fr); gap:10px; max-width:520px; margin:0 auto; }
  .bcell { aspect-ratio:1/1; background:#fff; border:3px solid var(--grass); border-radius:14px;
    display:grid; place-items:center; text-align:center; font-size:13px; font-weight:800; padding:6px;
    position:relative; color:var(--ink); transition:transform .2s; }
  [data-theme="dark"] .bcell { background:#1a2a22; color:var(--ink); }
  .bcell:hover { transform: scale(1.04) rotate(-1deg); }
  .bcell-stamp { position:absolute; inset:0; display:grid; place-items:center; font-size:64px;
    color:var(--hot); transform:scale(0) rotate(-30deg); transition:transform .35s cubic-bezier(.34,1.7,.4,1); pointer-events:none; }
  .bcell.stamped .bcell-stamp { transform:scale(1) rotate(-10deg); }
  .bcell.stamped { background:linear-gradient(135deg,#fff7c4,#ffd1e7); border-color:var(--hot); }
  .bcell.bingo-line { animation: shake .6s ease; box-shadow:0 0 0 4px var(--gold); }
  @keyframes shake { 0%,100%{transform:rotate(0)} 25%{transform:rotate(-3deg)} 75%{transform:rotate(3deg)} }
  ol.buzz, ol.srcrank { list-style:none; padding:0; margin:0; }
  ol.buzz li, ol.srcrank li {
    display:grid; grid-template-columns:28px 1fr 80px 30px; gap:10px; align-items:center;
    padding:6px 0; font-size:13.5px;
  }
  .rank { color:#fff; background:var(--hot); font-variant-numeric:tabular-nums; font-weight:900; font-size:12px;
    text-align:center; border-radius:50%; width:24px; height:24px; line-height:24px; }
  .buzz li:nth-child(1) .rank { background:linear-gradient(135deg,var(--gold),var(--hot)); }
  .buzz li:nth-child(2) .rank { background:var(--violet); }
  .buzz li:nth-child(3) .rank { background:var(--azure); }
  .buzz-word { background:transparent; border:none; color:var(--ink); font-weight:800; text-align:left; cursor:pointer; padding:0; font-size:14px; }
  .buzz-word:hover { color:var(--hot); text-decoration: underline wavy; }
  .srcrank .name { font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .bar { background:var(--line); height:10px; border-radius:99px; overflow:hidden; }
  .bar > span { display:block; height:100%; background:linear-gradient(90deg,var(--gold),var(--hot),var(--violet)); border-radius:99px; }
  .cnt { color:var(--sub); font-variant-numeric:tabular-nums; text-align:right; font-size:13px; font-weight:700; }

  /* ===== ガチャボタン ===== */
  .gacha-row { text-align:center; margin:32px 0 12px; }
  .gacha-btn {
    background:linear-gradient(135deg,var(--gold),var(--hot),var(--violet));
    background-size:200% 100%;
    color:#fff; border:none; padding:18px 38px; border-radius:999px;
    font-size:18px; font-weight:900; cursor:pointer; box-shadow:0 16px 36px -10px rgba(255,45,111,.6);
    transition:transform .15s ease;
    animation: rainbow 4s linear infinite;
    letter-spacing:.05em;
  }
  .gacha-btn:hover { transform:scale(1.08) rotate(-1deg); }
  .gacha-btn:active { transform:scale(.95); }
  .gacha-sub { font-size:12px; color:var(--sub); margin-top:8px; font-weight:600; }

  /* ガチャ結果（ボタン直下にインライン表示） */
  .gacha-result {
    max-width:640px; margin:18px auto 0; background:var(--card); border-radius:24px;
    padding:28px 28px 26px; text-align:center; border:4px solid var(--line);
    box-shadow:0 18px 40px -16px rgba(0,0,0,.2);
    display:none; position:relative;
  }
  .gacha-result.show { display:block; animation: pop .5s cubic-bezier(.34,1.56,.64,1); }
  .gacha-result .close { position:absolute; top:10px; right:12px; background:#fff; border:2px solid var(--line);
    width:34px; height:34px; border-radius:50%; font-size:18px; line-height:1; cursor:pointer; color:var(--ink); font-weight:900; }
  .gacha-get-label { display:inline-block; font-size:12px; font-weight:900; letter-spacing:.3em; color:#fff;
    background:linear-gradient(135deg,var(--gold),var(--hot)); padding:5px 18px; border-radius:99px;
    margin-bottom:12px; animation: pop .5s cubic-bezier(.34,1.56,.64,1); }
  .gacha-rarity-big {
    font-size:80px; font-weight:900; margin:4px 0 8px; line-height:1; letter-spacing:.04em;
    animation: rarityPop .7s cubic-bezier(.34,1.7,.4,1);
    text-shadow: 0 6px 20px rgba(0,0,0,.15);
  }
  @keyframes rarityPop {
    0% { transform: scale(.3) rotate(-30deg); opacity:0; }
    60%{ transform: scale(1.22) rotate(8deg); opacity:1; }
    100%{ transform: scale(1) rotate(0); opacity:1; }
  }
  .gacha-result h3 { font-size:20px; line-height:1.5; margin:10px 16px 6px; font-weight:900; color:var(--ink); }
  .gacha-result .gacha-meta { color:var(--sub); font-size:13px; font-weight:700; margin:0 0 8px; }
  .gacha-result .gacha-summary { color:var(--sub); margin:6px 8px 18px; font-size:13px; line-height:1.65;
    background:rgba(0,0,0,.04); border-radius:12px; padding:10px 14px; max-height:80px; overflow:hidden; text-align:left; }
  [data-theme="dark"] .gacha-result .gacha-summary { background:rgba(255,255,255,.05); }
  .gacha-result .open-link { display:inline-block; background:linear-gradient(135deg,var(--hot),var(--violet));
    color:#fff; padding:12px 26px; border-radius:999px; font-weight:900; font-size:14px;
    box-shadow:0 10px 22px -6px rgba(255,45,111,.5); transition: transform .15s; }
  .gacha-result .open-link:hover { transform:scale(1.06); }
  /* レアリティごとの枠＋背景アクセント */
  .gacha-result.r-ssr { border-color:var(--gold); background:
      radial-gradient(ellipse at top, rgba(251,191,36,.25), transparent 60%), var(--card); }
  .gacha-result.r-ssr .gacha-rarity-big { color:#b45309; text-shadow: 0 0 30px rgba(251,191,36,.7), 0 6px 12px rgba(0,0,0,.15);
    animation: rarityPop .7s cubic-bezier(.34,1.7,.4,1), shineSsr 1.6s ease-in-out infinite; }
  @keyframes shineSsr { 0%,100%{ filter:brightness(1) } 50%{ filter:brightness(1.3) } }
  .gacha-result.r-sr  { border-color:var(--violet); background:
      radial-gradient(ellipse at top, rgba(168,85,247,.18), transparent 60%), var(--card); }
  .gacha-result.r-sr  .gacha-rarity-big { color:var(--violet); text-shadow: 0 0 22px rgba(168,85,247,.55); }
  .gacha-result.r-r   { border-color:var(--azure); background:
      radial-gradient(ellipse at top, rgba(6,182,212,.16), transparent 60%), var(--card); }
  .gacha-result.r-r   .gacha-rarity-big { color:var(--azure); }
  .gacha-result.r-n   .gacha-rarity-big { color:#6b7280; }
  /* カードのrarityチップは従来通り */
  .r-ssr .rarity { background:linear-gradient(135deg,#fff5b1,#ffd84a); color:#7c4a02; }
  .r-sr  .rarity { background:linear-gradient(135deg,#e9d5ff,#a855f7); color:#fff; }
  .r-r   .rarity { background:linear-gradient(135deg,#bae6fd,#0ea5e9); color:#fff; }
  .r-n   .rarity { background:#e5e7eb; color:#374151; }

  /* ===== ツールバー ===== */
  .toolbar {
    margin-top:24px; background:var(--card); padding:14px 18px; border-radius:18px; border:3px solid var(--line);
    display:flex; gap:10px; flex-wrap:wrap; align-items:center;
  }
  .toolbar input, .toolbar select {
    padding:9px 16px; border:2px solid var(--line); border-radius:999px; font-size:14px; font-weight:600;
    background:#fff; color:var(--ink);
  }
  [data-theme="dark"] .toolbar input, [data-theme="dark"] .toolbar select { background:#2a2240; }
  .toolbar input[type=search]{ flex:1; min-width:200px; }
  .toolbar input:focus, .toolbar select:focus { outline:none; border-color:var(--hot); }
  .tabs button {
    border:2px solid var(--line); background:#fff; color:var(--ink);
    padding:9px 18px; border-radius:999px; cursor:pointer; font-size:14px; margin-right:6px; font-weight:800;
    transition:transform .15s;
  }
  [data-theme="dark"] .tabs button { background:#2a2240; }
  .tabs button:hover { transform:translateY(-2px); }
  .tabs button.active { background:linear-gradient(135deg,var(--hot),var(--violet)); color:#fff; border-color:transparent; }
  .count { color:var(--sub); font-size:13px; margin:18px 0 8px; font-weight:700; }

  /* ===== カード一覧 ===== */
  .cards { display:grid; grid-template-columns:repeat(auto-fill, minmax(320px,1fr)); gap:16px; margin-top:20px; }
  .card {
    background:var(--card); border:3px solid var(--line); border-radius:18px; padding:18px 20px;
    display:flex; flex-direction:column; gap:8px;
    transition:transform .2s ease, box-shadow .2s ease, border-color .2s ease;
    position:relative;
  }
  .card:hover { transform:translateY(-4px) rotate(-.3deg); box-shadow:0 16px 32px -14px rgba(255,94,156,.4); border-color:var(--pink); }
  .card-top { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .card h3 { font-size:16px; line-height:1.55; margin:6px 0 8px; font-weight:800; }
  .card .summary { color:var(--sub); font-size:13px; margin:0 0 8px; flex:1; }
  .card .meta-row { display:flex; justify-content:space-between; color:var(--sub); font-size:12px; font-weight:700; }
  .card.flash { animation: flashy 1.4s ease; box-shadow:0 0 0 6px var(--gold), 0 0 30px var(--hot); }
  @keyframes flashy { 0%{transform:scale(.92) rotate(-3deg)} 30%{transform:scale(1.08) rotate(2deg)} 100%{transform:scale(1) rotate(0)} }
  .card.read { background:linear-gradient(135deg,#f0fdf4 0%,#dcfce7 100%); border-color:var(--grass); }
  [data-theme="dark"] .card.read { background:linear-gradient(135deg,#0a2a1c 0%,#143524 100%); }
  .card.read::after { content:"✓ 読了"; position:absolute; top:8px; right:8px; background:var(--grass); color:#fff;
    padding:3px 10px; border-radius:99px; font-size:11px; font-weight:800; }
  .card.fav { box-shadow:0 0 0 3px var(--gold); }
  .card.fav .act-fav { background:var(--gold); color:#fff; }

  /* レアリティ枠 */
  .card.r-ssr { border-color:var(--gold); box-shadow:0 0 20px rgba(251,191,36,.4); }
  .card.r-sr  { border-color:var(--violet); }
  .card.r-r   { border-color:var(--azure); }
  .rarity { font-size:11px; font-weight:900; padding:3px 10px; border-radius:99px; letter-spacing:.05em; }

  /* アクションボタン */
  .actions { display:flex; gap:8px; margin-top:8px; }
  .actions button { flex:1; border:none; background:#fff5fb; color:var(--hot); border:2px solid var(--line);
    padding:7px 8px; border-radius:99px; font-size:12px; font-weight:800; cursor:pointer;
    transition:transform .15s; display:flex; align-items:center; justify-content:center; gap:4px; }
  [data-theme="dark"] .actions button { background:#2a2240; }
  .actions button:hover { transform:translateY(-2px) scale(1.03); }
  .actions button .plus { font-size:10px; color:var(--sub); }
  .act-read { color:var(--grass) !important; }
  .card.read .act-read { background:var(--grass); color:#fff !important; border-color:var(--grass); }
  .card.read .act-read .plus { color:rgba(255,255,255,.8); }

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
  details { margin-top:32px; background:var(--card); border:3px solid var(--line); border-radius:18px; padding:8px 22px; }
  details summary { cursor:pointer; font-weight:800; padding:12px 0; font-size:14px; }
  details ul { list-style:none; padding:0; margin:0 0 12px; font-size:13px; }
  details li { padding:5px 0; border-bottom:1px solid var(--line); }
  .ok { color:#16a34a; } .ng { color:#dc2626; } .err { color:#b91c1c; }
  footer { text-align:center; color:var(--sub); font-size:12px; padding:36px 20px; font-weight:700; }

  /* トースト */
  .toast { position:fixed; bottom:24px; left:50%; transform:translateX(-50%) translateY(120%);
    background:linear-gradient(135deg,var(--hot),var(--violet)); color:#fff;
    padding:14px 24px; border-radius:99px; font-size:14px; font-weight:800;
    box-shadow:0 16px 40px rgba(255,45,111,.5); z-index:80; transition:transform .4s cubic-bezier(.34,1.56,.64,1);
    display:flex; align-items:center; gap:10px; max-width:90%;
  }
  .toast.show { transform:translateX(-50%) translateY(0); }
  .toast .emoji { font-size:24px; }

  /* 紙吹雪 */
  .confetti { position:fixed; pointer-events:none; inset:0; overflow:hidden; z-index:90; }
  .conf-piece { position:absolute; top:-10px; width:10px; height:14px; opacity:.9;
    animation: confall linear forwards; }
  @keyframes confall {
    to { transform: translateY(110vh) rotate(720deg); opacity:.4; }
  }
</style>
</head>
<body>
<header class="masthead">
  <button class="theme-toggle" id="themeToggle" type="button">🌙 Dark</button>
  <div class="brand">📰 EdTech FUN! WEEKLY 🎉</div>
  <div><span class="vol">VOL. ${esc(rangeLabel)}</span></div>
  <div class="tagline"><span>🇯🇵 日本</span><span>×</span><span>🌐 世界</span><span>×</span><span>🤖 教育テクノロジー、全部楽しもう！</span></div>
</header>

<!-- 期間選択パネル -->
<form class="period-panel" id="periodPanel" method="get" action="/">
  <span class="pp-label">📅 期間</span>
  <input type="date" name="from" id="ppFrom" value="${esc(fmt(from))}">
  <span class="pp-arrow">〜</span>
  <input type="date" name="to" id="ppTo" value="${esc(fmt(to))}">
  <div class="pp-presets">
    <button type="button" class="pp-preset" data-days="3">3日</button>
    <button type="button" class="pp-preset" data-days="7">1週間</button>
    <button type="button" class="pp-preset" data-days="14">2週間</button>
    <button type="button" class="pp-preset" data-days="30">1ヶ月</button>
  </div>
  ${isServer
    ? `<button type="submit" class="pp-submit">🔄 最新を取得</button>`
    : `<span class="pp-static-note">⚠️ この公開サイトは静的版です。期間変更にはローカルで <code>node fetch-news.js --serve</code></span>`}
</form>

<!-- プレイヤーステータスバー（読了で経験値が貯まる！） -->
<div class="playerbar">
  <div class="pb-inner">
    <div class="pb-avatar">🧑‍🎓</div>
    <div class="pb-stat">Lv. <b id="pbLv">1</b></div>
    <div class="pb-xpbar"><div class="pb-xpfill" id="pbXp"></div><div class="pb-xptxt" id="pbXpTxt">0 / 50 XP</div></div>
    <div class="pb-stat">📖 <b id="pbRead">0</b> / ${items.length}</div>
    <div class="pb-prog">🎯 コンプ率 <b id="pbProg">0</b>%</div>
    <div class="pb-badges" id="pbBadges"></div>
  </div>
</div>

<div class="wrap">
  <div class="panels">
    ${fortuneHtml}
    ${challengeHtml}
  </div>

  ${heroHtml}

  ${bingoHtml}

  <div class="gacha-row">
    <button class="gacha-btn" id="gacha" type="button">🎰 ニュースガチャ！</button>
    <div class="gacha-sub">レア度: ⚪N → 🔵R → 💎SR → ✨SSR ／ ガチャ回数: <b id="gachaCount">0</b></div>
  </div>
  <!-- ガチャ結果（インライン） -->
  <div class="gacha-result" id="gachaResult">
    <button class="close" id="gachaClose" type="button">×</button>
    <div class="gacha-get-label">🎉 GET!</div>
    <div class="gacha-rarity-big" id="gachaRarity">✨ SSR</div>
    <h3 id="gachaTitle"></h3>
    <div class="gacha-meta" id="gachaMeta"></div>
    <div class="gacha-summary" id="gachaSummary"></div>
    <a class="open-link" id="gachaLink" target="_blank" rel="noopener">この記事を読む →</a>
  </div>

  <div class="panels">
    ${buzzHtml}
    ${rankHtml}
  </div>

  <div class="toolbar">
    <div class="tabs">
      <button data-f="all" class="active">✨ すべて (${items.length})</button>
      <button data-f="jp">🇯🇵 日本 (${jp.length})</button>
      <button data-f="global">🌐 海外 (${gl.length})</button>
    </div>
    <select id="srcFilter"><option value="">📰 全ソース</option>${srcOptions}</select>
    <input type="search" id="search" placeholder="🔍 キーワードで絞り込み（例: 生成AI, ChatGPT）">
  </div>
  <div class="count" id="count"></div>

  ${items.length === 0
    ? `<div class="empty">😢 この期間のニュースは見つかりませんでした。<br>期間を広げて再実行してください（例: <code>node fetch-news.js --days 14</code>）。</div>`
    : `<div class="cards" id="list">${cardsHtml}</div>`}

  <details>
    <summary>📊 ソース取得ステータス（${status.filter(s=>s.ok).length}/${status.length} 成功）</summary>
    <ul>${statusRows}</ul>
  </details>
</div>
<footer>📰 EdTech FUN! WEEKLY — 読了でXP・バッジ獲得・ビンゴでお祝い ／ 進捗はブラウザに保存されます</footer>


<script>
  // ===== 永続化（プレイヤー進捗） =====
  const STORE_KEY = 'edtech-fun-v1';
  const today = new Date().toISOString().slice(0,10);
  let store = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
  store.read       = new Set(store.read || []);
  store.fav        = new Set(store.fav  || []);
  store.badges     = new Set(store.badges || []);
  store.bingo      = new Set(store.bingo || []);
  store.gachaCount = store.gachaCount || 0;
  store.xp         = store.xp || 0;
  store.dailyDate  = store.dailyDate || today;
  if (store.dailyDate !== today) { store.dailyDate = today; }
  function save() {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      read:[...store.read], fav:[...store.fav], badges:[...store.badges],
      bingo:[...store.bingo], gachaCount:store.gachaCount, xp:store.xp, dailyDate:store.dailyDate,
    }));
  }

  // ===== 期間選択 =====
  const periodPanel = document.getElementById('periodPanel');
  const ppFrom = document.getElementById('ppFrom');
  const ppTo = document.getElementById('ppTo');
  const isServerMode = ${isServer ? 'true' : 'false'};
  function fmtIso(d) {
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  }
  function staticAlert(days) {
    const cmd = days ? '  node fetch-news.js --days ' + days : '  node fetch-news.js --serve';
    alert('🔒 期間変更にはサーバーモードが必要です（RSSのCORS制限のため）。\\n\\n' +
          '【方法1】 サーバー起動.bat をダブルクリック\\n' +
          '【方法2】 ターミナルで:\\n' + cmd + '\\n\\n' +
          'GitHubのソースから cloneして実行してください: \\n' +
          'https://github.com/studypark2011/edtech-news');
  }
  document.querySelectorAll('.pp-preset').forEach(b => b.addEventListener('click', () => {
    const days = parseInt(b.dataset.days, 10);
    const to = new Date(); to.setHours(0,0,0,0);
    const from = new Date(to.getTime() - (days-1) * 86400000);
    ppFrom.value = fmtIso(from);
    ppTo.value = fmtIso(to);
    if (isServerMode) periodPanel.requestSubmit();
    else staticAlert(days);
  }));
  // 日付入力直接変更時も静的モードならアラート
  if (!isServerMode) {
    [ppFrom, ppTo].forEach(el => el.addEventListener('change', () => staticAlert()));
  }
  if (isServerMode) {
    periodPanel.addEventListener('submit', () => { periodPanel.classList.add('loading'); });
  } else {
    periodPanel.addEventListener('submit', e => { e.preventDefault(); staticAlert(); });
  }

  // ===== テーマ =====
  const themeBtn = document.getElementById('themeToggle');
  const root = document.documentElement;
  const savedTheme = localStorage.getItem('edtech-theme');
  if (savedTheme) root.dataset.theme = savedTheme;
  themeBtn.textContent = root.dataset.theme === 'dark' ? '☀️ Light' : '🌙 Dark';
  themeBtn.addEventListener('click', () => {
    root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
    themeBtn.textContent = root.dataset.theme === 'dark' ? '☀️ Light' : '🌙 Dark';
    localStorage.setItem('edtech-theme', root.dataset.theme);
  });

  // ===== UI参照 =====
  const cards = [...document.querySelectorAll('#list .card')];
  const countEl = document.getElementById('count');
  const searchEl = document.getElementById('search');
  const srcEl = document.getElementById('srcFilter');
  const TOTAL = cards.length;

  // ===== ステータスバー更新 =====
  function lvOf(xp) { return 1 + Math.floor(Math.sqrt(xp / 20)); }
  function xpForLv(lv) { return Math.pow(lv - 1, 2) * 20; }
  function refreshStatus() {
    const lv = lvOf(store.xp);
    const cur = store.xp - xpForLv(lv);
    const need = xpForLv(lv+1) - xpForLv(lv);
    document.getElementById('pbLv').textContent = lv;
    document.getElementById('pbXp').style.width = Math.min(100, (cur/need)*100) + '%';
    document.getElementById('pbXpTxt').textContent = cur + ' / ' + need + ' XP';
    document.getElementById('pbRead').textContent = store.read.size;
    document.getElementById('pbProg').textContent = TOTAL ? Math.round((store.read.size/TOTAL)*100) : 0;
    document.getElementById('gachaCount').textContent = store.gachaCount;
    // badges
    const bb = document.getElementById('pbBadges');
    bb.innerHTML = '';
    [...store.badges].forEach(b => {
      const s = document.createElement('span'); s.className = 'pb-badge'; s.textContent = BADGES[b]?.e || '🏅';
      s.title = (BADGES[b]?.t || b) + ' — ' + (BADGES[b]?.d || '');
      bb.appendChild(s);
    });
  }

  // ===== バッジ =====
  const BADGES = {
    first:   { e:'🥉', t:'初読了',         d:'最初の1本を読んだ' },
    five:    { e:'📚', t:'5本マイスター',  d:'5本読破' },
    ten:     { e:'🥈', t:'10本マスター',   d:'10本読破' },
    jp5:     { e:'🇯🇵', t:'ニッポン通',     d:'日本ニュース5本' },
    gl3:     { e:'🌐', t:'海外通',         d:'海外ニュース3本' },
    tag5:    { e:'🏷️', t:'タグハンター',   d:'5種類のタグを読破' },
    gacha10: { e:'🎰', t:'ガチャ職人',     d:'ガチャ10回' },
    bingo:   { e:'🎴', t:'BINGO!',         d:'ビンゴ達成' },
    comp:    { e:'👑', t:'コンプリート',   d:'全ニュース読破' },
    ssr:     { e:'✨', t:'SSRハンター',    d:'SSRをGET' },
  };
  function award(id) {
    if (store.badges.has(id)) return;
    store.badges.add(id); save(); refreshStatus();
    toast('🏆 バッジ獲得！ ' + BADGES[id].e + ' ' + BADGES[id].t);
    confetti();
  }
  function checkBadges() {
    if (store.read.size >= 1)  award('first');
    if (store.read.size >= 5)  award('five');
    if (store.read.size >= 10) award('ten');
    if (store.read.size >= TOTAL && TOTAL > 0) award('comp');
    const reg = c => c.dataset.region;
    const readCards = cards.filter(c => store.read.has(c.dataset.link));
    if (readCards.filter(c => reg(c)==='jp').length >= 5) award('jp5');
    if (readCards.filter(c => reg(c)==='global').length >= 3) award('gl3');
    const tagSet = new Set();
    readCards.forEach(c => (c.dataset.tags||'').split('|').filter(Boolean).forEach(t => tagSet.add(t)));
    if (tagSet.size >= 5) award('tag5');
    if (store.gachaCount >= 10) award('gacha10');
  }

  // ===== トースト & 紙吹雪 =====
  function toast(msg) {
    const old = document.querySelector('.toast'); if (old) old.remove();
    const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(()=>t.remove(), 500); }, 2800);
  }
  function confetti() {
    const wrap = document.createElement('div'); wrap.className = 'confetti';
    const colors = ['#ff5e9c','#fbbf24','#06b6d4','#a855f7','#22c55e','#fdba74'];
    for (let i=0; i<60; i++) {
      const s = document.createElement('span'); s.className = 'conf-piece';
      s.style.left = Math.random()*100 + 'vw';
      s.style.background = colors[i%colors.length];
      s.style.animationDuration = (1.6 + Math.random()*1.5) + 's';
      s.style.animationDelay = Math.random()*0.3 + 's';
      s.style.transform = 'rotate(' + (Math.random()*360) + 'deg)';
      wrap.appendChild(s);
    }
    document.body.appendChild(wrap);
    setTimeout(() => wrap.remove(), 3500);
  }

  // ===== ビンゴ =====
  const LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  const bcells = [...document.querySelectorAll('.bcell')];
  function refreshBingo() {
    bcells.forEach((cell, i) => {
      const stamped = store.bingo.has(cell.dataset.tag);
      cell.classList.toggle('stamped', stamped);
    });
    // 揃ったライン
    const stampedIdx = new Set();
    bcells.forEach((c, i) => { if (c.classList.contains('stamped')) stampedIdx.add(i); });
    let bingoHit = false;
    LINES.forEach(line => {
      if (line.every(i => stampedIdx.has(i))) {
        line.forEach(i => bcells[i].classList.add('bingo-line'));
        bingoHit = true;
      }
    });
    if (bingoHit && !store.badges.has('bingo')) {
      award('bingo');
      toast('🎴 ビンゴ達成！おめでとう！');
      confetti();
    }
  }
  function stampTags(tagsStr) {
    (tagsStr||'').split('|').filter(Boolean).forEach(t => {
      if (bcells.some(c => c.dataset.tag === t)) store.bingo.add(t);
    });
    refreshBingo();
  }

  // ===== デイリーチャレンジ =====
  const challItems = [...document.querySelectorAll('.challenges li')];
  function challProgress(kind) {
    const reg = c => c.dataset.region;
    const readCards = cards.filter(c => store.read.has(c.dataset.link));
    if (kind === 'jp')  return readCards.filter(c => reg(c)==='jp').length;
    if (kind === 'gl')  return readCards.filter(c => reg(c)==='global').length;
    if (kind === 'any') return readCards.length;
    if (kind === 'fav') return store.fav.size;
    if (kind === 'gacha') return store.gachaCount;
    if (kind.startsWith('tag:')) {
      const t = kind.slice(4);
      return readCards.filter(c => (c.dataset.tags||'').split('|').includes(t)).length;
    }
    return 0;
  }
  function refreshChallenges() {
    challItems.forEach(li => {
      const kind = li.dataset.kind;
      const need = parseInt(li.dataset.need, 10);
      const cur = Math.min(challProgress(kind), need);
      li.querySelector('.cdone').textContent = cur;
      li.querySelector('.cbar-fill').style.width = (cur/need)*100 + '%';
      li.classList.toggle('done', cur >= need);
    });
  }

  // ===== フィルタ =====
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

  // バズワード→検索
  document.querySelectorAll('.buzz-word').forEach(b => b.addEventListener('click', () => {
    searchEl.value = b.dataset.q; region = 'all';
    document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('active', x.dataset.f === 'all'));
    apply(); searchEl.scrollIntoView({ behavior:'smooth', block:'start' });
  }));

  // ===== 記事カード：読了 / お気に入り =====
  function applyCardState(card) {
    card.classList.toggle('read', store.read.has(card.dataset.link));
    card.classList.toggle('fav',  store.fav.has(card.dataset.link));
  }
  cards.forEach(card => {
    applyCardState(card);
    card.querySelector('.act-read').addEventListener('click', e => {
      e.stopPropagation();
      const link = card.dataset.link;
      if (store.read.has(link)) {
        store.read.delete(link); store.xp = Math.max(0, store.xp - 10);
      } else {
        store.read.add(link); store.xp += 10;
        toast('✓ 読了！ +10 XP'); stampTags(card.dataset.tags);
      }
      applyCardState(card); save(); refreshStatus(); refreshChallenges(); checkBadges();
    });
    card.querySelector('.act-fav').addEventListener('click', e => {
      e.stopPropagation();
      const link = card.dataset.link;
      if (store.fav.has(link)) {
        store.fav.delete(link); store.xp = Math.max(0, store.xp - 5);
      } else {
        store.fav.add(link); store.xp += 5;
        toast('⭐ お気に入り！ +5 XP');
      }
      applyCardState(card); save(); refreshStatus(); refreshChallenges();
    });
  });

  // ===== ガチャ（インライン結果カード） =====
  const result = document.getElementById('gachaResult');
  const closeBtn = document.getElementById('gachaClose');
  closeBtn.addEventListener('click', () => result.classList.remove('show'));

  document.getElementById('gacha').addEventListener('click', () => {
    const visible = cards.filter(c => c.style.display !== 'none');
    const pool = visible.length ? visible : cards;
    if (!pool.length) return;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    store.gachaCount++; save(); refreshStatus(); refreshChallenges();

    const rar = pick.dataset.rarity;
    const rarMap = { SSR:'✨ SSR', SR:'💎 SR', R:'🔵 R', N:'⚪ N' };
    result.classList.remove('r-ssr','r-sr','r-r','r-n','show');
    // forced reflow to restart animation
    void result.offsetWidth;
    result.classList.add('r-' + rar.toLowerCase(), 'show');
    document.getElementById('gachaRarity').textContent = rarMap[rar];
    document.getElementById('gachaTitle').textContent = pick.dataset.title;
    const flag = pick.dataset.region === 'jp' ? '🇯🇵' : '🌐';
    document.getElementById('gachaMeta').textContent = flag + ' ' + pick.dataset.source;
    const summary = pick.querySelector('.summary');
    const sumEl = document.getElementById('gachaSummary');
    if (summary && summary.textContent.trim()) {
      sumEl.textContent = summary.textContent; sumEl.style.display = '';
    } else { sumEl.style.display = 'none'; }
    document.getElementById('gachaLink').href = pick.dataset.link;

    if (rar === 'SSR') { confetti(); award('ssr'); }
    if (rar === 'SR')  confetti();
    checkBadges();

    // 結果カードをビューにスクロール
    result.scrollIntoView({ behavior:'smooth', block:'center' });

    document.querySelectorAll('.card.flash').forEach(c => c.classList.remove('flash'));
    pick.classList.add('flash');
  });

  // ===== 初期表示 =====
  refreshStatus(); refreshBingo(); refreshChallenges(); apply();
  // 起動時にもバッジチェック
  checkBadges();
</script>
</body>
</html>`;
}

if (require.main === module) {
  main().catch((e) => { console.error("エラー:", e); process.exit(1); });
}

module.exports = { parseFeed, fetchText, resolveRange };
