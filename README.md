# EdTech ニュース収集アプリ

指定期間（デフォルト直近1週間）の **日本・海外のEdTechニュース** をRSSから自動収集し、
絞り込み機能付きのHTML一覧を生成してブラウザで開きます。依存パッケージ不要・Node.jsだけで動きます。

## 使い方

### かんたん（ダブルクリック）
`収集する_直近1週間.bat` をダブルクリック → 直近7日間のニュースを収集し、ブラウザで一覧が開きます。

### コマンドライン
```sh
node fetch-news.js                       # 直近7日間（デフォルト）
node fetch-news.js --days 14             # 直近14日間
node fetch-news.js --from 2026-06-01 --to 2026-06-17   # 期間を指定
node fetch-news.js --from 2026-06-01     # 指定日から今日まで
node fetch-news.js --no-open             # ブラウザを自動で開かない
```

## 機能
- 🇯🇵 日本 / 🌐 海外 をタブで切り替え
- ソース別フィルタ・キーワード検索（生成AI / ChatGPT / university など）
- 記事タイトルから各媒体の元ページへ直接リンク
- URL重複の自動除去・日付降順ソート
- ページ下部に各ソースの取得ステータス表示

## 出力
- `index.html` … 常に最新の一覧
- `reports/edtech-news_<開始日>_<終了日>.html` … 期間ごとに保存（履歴として残る）

## ニュースソースの追加・変更
`sources.js` の配列を編集するだけです。`region` は `"jp"`（日本）か `"global"`（海外）、
`url` は RSS / Atom / RDF いずれのフィードURLでもOK。

```js
{ name: "媒体名", region: "jp", url: "https://example.com/feed/" },
```

## 収録ソース（初期設定）
**日本:** ICT教育ニュース / リセマム / リシード(ReseEd)
**海外:** EdSurge / eSchool News / EdTech Magazine / Tech & Learning / Education Week / TechCrunch EdTech

> フィードが提供されていない期間はその媒体の件数が0になることがあります。
> 取得状況はレポート下部の「ソース取得ステータス」で確認できます。
