// EdTech ニュースソース定義
// region: "jp"（日本） / "global"（海外）
// 追加・削除はこの配列を編集するだけでOK。url は RSS / Atom / RDF いずれも可。

module.exports = [
  // ===== 日本 =====
  { name: "ICT教育ニュース",     region: "jp", url: "https://ict-enews.net/feed/" },
  { name: "リセマム",           region: "jp", url: "https://resemom.jp/rss/index.rdf" },
  { name: "リシード(ReseEd)",    region: "jp", url: "https://reseed.resemom.jp/rss/index.rdf" },

  // ===== 海外 =====
  { name: "EdSurge",           region: "global", url: "https://www.edsurge.com/articles_rss" },
  { name: "eSchool News",      region: "global", url: "https://www.eschoolnews.com/feed/" },
  { name: "EdTech Magazine",   region: "global", url: "https://edtechmagazine.com/k12/rss.xml" },
  { name: "Tech & Learning",   region: "global", url: "https://www.techlearning.com/rss" },
  { name: "Education Week",     region: "global", url: "https://feeds.feedburner.com/EducationWeekTechnology" },
  { name: "TechCrunch EdTech",  region: "global", url: "https://techcrunch.com/tag/edtech/feed/" },
];
