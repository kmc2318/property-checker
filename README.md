# UniLife 物件情報チェックAI — GitHub Pages版

`gemini_v25` のUI・照合機能を、Node.js / Express / localhostなしでGitHub Pages上から使える構成に変更した版です。

## 変わったところ

- `server.js` / `npm install` / `npm start` は不要です。
- GitHub PagesのブラウザからGemini Interactions APIを直接呼びます。
- UniLife物件URLは、ブラウザから取得できる場合は直接確認し、CORSで取得できない場合はGeminiのURL Contextで確認します。
- PDF・画像は小さいものは直接Geminiへ渡し、大きいファイルはGemini Files APIへ一時アップロードします。
- 動画はGemini Files APIへ一時アップロードして、映像と音声の両方を確認します。
- 建物・室内画像チェック、表記揺れ、要修正 / 要確認 / 一致の表示は維持しています。
- 429時は待ち時間を表示し、その間は照合ボタンを押せないようにしています。

## フォルダ構成

```text
.
├── .github/
│   └── workflows/
│       └── pages.yml
├── site/
│   ├── index.html
│   ├── styles.css
│   ├── app.js
│   ├── config.js              # ローカル用の空設定。公開時はActionsが上書き
│   ├── config.template.js
│   ├── unilife-logo.png
│   └── .nojekyll
├── .gitignore
└── README.md
```

## GitHubへ公開する手順

### 1. 新しいGitHubリポジトリを作る

GitHubで空のリポジトリを作成します。GitHub FreeでPagesを使う場合は、基本的にPublicリポジトリにするのが簡単です。

### 2. このフォルダをpush

```bash
git init
git add .
git commit -m "Add UniLife property checker"
git branch -M main
git remote add origin https://github.com/あなたのユーザー名/リポジトリ名.git
git push -u origin main
```

### 3. Gemini APIキーをGitHub Secretへ入れる

GitHubのリポジトリで、

`Settings` → `Secrets and variables` → `Actions` → `New repository secret`

を開きます。

- Name: `GEMINI_API_KEY`
- Secret: Google AI Studioで取得したGemini APIキー

APIキーはリポジトリのソースコードには保存されません。

### 4. GitHub Pagesを有効化

`Settings` → `Pages` で、Build and deployment のSourceを **GitHub Actions** にします。

その後 `Actions` タブの `Deploy GitHub Pages` が成功するとPages URLが発行されます。

例:

```text
https://ユーザー名.github.io/リポジトリ名/
```

以後は `git push` するたびに自動でPagesが更新されます。

## 重要：APIキーについて

GitHub Secretを使うため、GitHub上のソースコードにはAPIキーは残りません。ただし、このアプリはブラウザからGemini APIへ直接通信する方式なので、**公開後にブラウザの開発者ツールを使えば、実行時のAPIキーを確認することは技術的に可能です**。

短期プロト用の専用APIキーを使い、課金を有効にしない・検証終了後にキーを無効化する運用をおすすめします。

## ファイル処理について

- PDF: 1ファイル
- Instagram画像: 最大10枚
- 動画: 1回につき1本
- 動画の長さに固定上限は設けていません。
- 長い動画はGeminiのFiles APIと動画処理機能を使うため、短い動画より時間がかかります。
- Gemini Files APIへアップロードされたファイルは一時ファイルとして扱われます。

## UniLifeページの確認方法

GitHub PagesからUniLifeサイトへ直接アクセスすると、ブラウザのCORS制限でHTMLを取得できない場合があります。その場合でも、Geminiの `url_context` を使って指定URLの公開情報を確認するようにしています。

Webページから公式画像URLを抽出できた場合は、Instagram素材の建物・室内画像との照合にも利用します。抽出できない場合はPDF内画像を中心に照合し、根拠が弱い場合は「人の確認が必要」と返す設計です。

## ローカルで画面だけ確認する場合

`site/config.js` の `GEMINI_API_KEY` は空のままなのでAI照合は動きませんが、UIだけなら簡易HTTPサーバーで確認できます。

```bash
cd site
python3 -m http.server 8080
```

`http://localhost:8080` を開いてください。
