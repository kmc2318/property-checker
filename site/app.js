const $ = (id) => document.getElementById(id);
const form = $('checkForm');
const propertyUrl = $('propertyUrl');
const documentInput = $('document');
const mediaInput = $('media');
const pdfDropzone = $('pdfDropzone');
const mediaDropzone = $('mediaDropzone');
const pdfFile = $('pdfFile');
const mediaPreview = $('mediaPreview');
const submitBtn = $('submitBtn');
const submitLabel = $('submitLabel');
const articleUrl = $('articleUrl');
const modeButtons = [...document.querySelectorAll('.mode-option')];
const articleDocumentInput = $('articleDocument');
const articlePdfDropzone = $('articlePdfDropzone');
const articlePdfFiles = $('articlePdfFiles');
const articlePropertyUrls = $('articlePropertyUrls');

const CONFIG = window.APP_CONFIG || {};
const GEMINI_API_KEY = String(CONFIG.GEMINI_API_KEY || '').trim();
const GEMINI_MODEL = String(CONFIG.GEMINI_MODEL || 'gemini-3.7-flash');
const PROPERTY_CACHE_TTL_MS = Math.max(60_000, Number(CONFIG.PROPERTY_CACHE_TTL_MS || 3_600_000));
const WEB_IMAGE_MAX = Math.max(1, Math.min(10, Number(CONFIG.WEB_IMAGE_MAX || 6)));
const INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const FILES_BASE = 'https://generativelanguage.googleapis.com';

let selectedMedia = [];
let loadingTimer = null;
let loadingStartedAt = 0;
let loadingEstimateSeconds = 60;
let cooldownTimer = null;
let cachedPropertyForCurrentUrl = null;
let currentMode = 'instagram';
let selectedArticlePdfs = [];

class GeminiHttpError extends Error {
  constructor(message, status = 0, retryAfter = 0) {
    super(message);
    this.name = 'GeminiHttpError';
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function init() {
  const messages = [];
  if (!GEMINI_API_KEY) {
    messages.push('<strong>Gemini APIキーが設定されていません。</strong> GitHubの Repository Secret <code>GEMINI_API_KEY</code> を設定してPagesを再デプロイしてください。');
  }
  messages.push('<strong>GitHub Pages版です。</strong> ファイルはGitHub Pagesには保存せず、ブラウザからGemini APIへ直接送信します。');
  if (messages.length) {
    const notice = $('aiNotice');
    notice.classList.remove('hidden');
    notice.innerHTML = messages.join('<br>');
  }
  setMode('instagram');
}


function idleSubmitLabel() {
  return currentMode === 'article' ? '記事をAIで照合' : '3つの情報をAIで照合';
}

function setMode(mode) {
  currentMode = mode === 'article' ? 'article' : 'instagram';
  modeButtons.forEach(btn => {
    const active = btn.dataset.mode === currentMode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  $('instagramModeFields').classList.toggle('hidden', currentMode !== 'instagram');
  $('articleModeFields').classList.toggle('hidden', currentMode !== 'article');
  propertyUrl.required = currentMode === 'instagram';
  articleUrl.required = currentMode === 'article';
  articlePropertyUrls.required = false;
  $('inputStepBadge').textContent = currentMode === 'article' ? '記事URLだけ必須' : '3つだけ';
  $('modeBadge').textContent = currentMode === 'article' ? 'Web記事 / 柔軟照合' : 'Instagram / 3ソース照合';
  submitLabel.textContent = cooldownTimer ? submitLabel.textContent : idleSubmitLabel();
  $('resultContent').classList.add('hidden');
  $('articleResultContent').classList.add('hidden');
  $('loadingState').classList.add('hidden');
  $('emptyState').classList.remove('hidden');
  $('emptyState').innerHTML = currentMode === 'article'
    ? '<div class="empty-graphic article"><span>ARTICLE</span><span>PDF</span><span>WEB</span><b>✓</b></div><h3>記事のチェック結果はここに表示されます</h3><p>記事URLだけ必須。PDF・物件ページは<br>用意できるものだけ追加してください。</p>'
    : '<div class="empty-graphic"><span>WEB</span><span>PDF</span><span>SNS</span><b>✓</b></div><h3>チェック結果はここに表示されます</h3><p>左の3つの情報を追加して、<br>「AIで照合」を押してください。</p>';
  updateLoadingStepLabels();
}

function updateLoadingStepLabels() {
  const labels = currentMode === 'article'
    ? ['記事取得', 'PDF確認', '物件ページ確認', '差分照合']
    : ['情報取得', 'PDF確認', '画像・動画解析', '差分照合'];
  document.querySelectorAll('#loadingSteps [data-stage]').forEach((el, idx) => { el.textContent = labels[idx] || ''; });
}

modeButtons.forEach(btn => btn.addEventListener('click', () => setMode(btn.dataset.mode)));

function stopDefaults(e) { e.preventDefault(); e.stopPropagation(); }

['dragenter','dragover'].forEach(name => pdfDropzone.addEventListener(name, e => { stopDefaults(e); pdfDropzone.classList.add('dragover'); }));
['dragleave','drop'].forEach(name => pdfDropzone.addEventListener(name, e => { stopDefaults(e); pdfDropzone.classList.remove('dragover'); }));
pdfDropzone.addEventListener('drop', e => {
  const file = [...e.dataTransfer.files].find(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
  if (!file) return;
  const dt = new DataTransfer(); dt.items.add(file); documentInput.files = dt.files; renderPdf(file);
});
documentInput.addEventListener('change', () => renderPdf(documentInput.files[0]));

['dragenter','dragover'].forEach(name => mediaDropzone.addEventListener(name, e => { stopDefaults(e); mediaDropzone.classList.add('dragover'); }));
['dragleave','drop'].forEach(name => mediaDropzone.addEventListener(name, e => { stopDefaults(e); mediaDropzone.classList.remove('dragover'); }));
mediaDropzone.addEventListener('drop', e => addMedia([...e.dataTransfer.files]));
mediaInput.addEventListener('change', () => addMedia([...mediaInput.files]));

['dragenter','dragover'].forEach(name => articlePdfDropzone.addEventListener(name, e => { stopDefaults(e); articlePdfDropzone.classList.add('dragover'); }));
['dragleave','drop'].forEach(name => articlePdfDropzone.addEventListener(name, e => { stopDefaults(e); articlePdfDropzone.classList.remove('dragover'); }));
articlePdfDropzone.addEventListener('drop', e => addArticlePdfs([...e.dataTransfer.files]));
articleDocumentInput.addEventListener('change', () => addArticlePdfs([...articleDocumentInput.files]));

function addArticlePdfs(files) {
  const valid = files.filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
  selectedArticlePdfs = [...selectedArticlePdfs, ...valid]
    .filter((file, index, arr) => index === arr.findIndex(f => f.name === file.name && f.size === file.size))
    .slice(0, 10);
  syncArticlePdfInput();
  renderArticlePdfs();
}

function syncArticlePdfInput() {
  const dt = new DataTransfer();
  selectedArticlePdfs.forEach(f => dt.items.add(f));
  articleDocumentInput.files = dt.files;
}

function removeArticlePdf(index) {
  selectedArticlePdfs.splice(index, 1);
  syncArticlePdfInput();
  renderArticlePdfs();
}

function renderArticlePdfs() {
  articlePdfFiles.innerHTML = selectedArticlePdfs.map((file, index) => `<div class="article-pdf-chip"><span class="file-type">PDF</span><div><strong>${escapeHtml(file.name)}</strong><small>${formatBytes(file.size)}</small></div><button type="button" data-index="${index}" aria-label="削除">×</button></div>`).join('');
  articlePdfFiles.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => removeArticlePdf(Number(btn.dataset.index))));
}

function parseArticlePropertyUrls() {
  return [...new Set(String(articlePropertyUrls.value || '')
    .split(/\r?\n|,/)
    .map(v => v.trim())
    .filter(Boolean))];
}

function renderPdf(file) {
  if (!file) { pdfFile.classList.add('hidden'); return; }
  if (file.size > 2 * 1024 * 1024 * 1024) {
    alert('PDFは2GB以下のファイルを選択してください。');
    documentInput.value = '';
    pdfFile.classList.add('hidden');
    return;
  }
  pdfFile.classList.remove('hidden');
  pdfFile.innerHTML = `<span class="file-type">PDF</span><div><strong>${escapeHtml(file.name)}</strong><small>${formatBytes(file.size)}</small></div><span class="ready">✓ 追加済み</span>`;
}

function addMedia(files) {
  const valid = files.filter(f => f.type.startsWith('image/') || f.type.startsWith('video/'));
  const merged = [...selectedMedia, ...valid];
  selectedMedia = merged
    .filter((file, index, arr) => index === arr.findIndex(f => f.name === file.name && f.size === file.size))
    .slice(0, 12);
  syncMediaInput();
  renderMedia();
}

function syncMediaInput() {
  const dt = new DataTransfer();
  selectedMedia.forEach(f => dt.items.add(f));
  mediaInput.files = dt.files;
}

function removeMedia(index) {
  selectedMedia.splice(index, 1); syncMediaInput(); renderMedia();
}

function renderMedia() {
  mediaPreview.innerHTML = '';
  selectedMedia.forEach((file, index) => {
    const item = document.createElement('div');
    item.className = 'media-card';
    const objectUrl = URL.createObjectURL(file);
    const visual = file.type.startsWith('image/')
      ? `<img src="${objectUrl}" alt="${escapeHtml(file.name)}">`
      : `<video src="${objectUrl}" muted preload="metadata"></video><span class="video-badge">VIDEO</span>`;
    item.innerHTML = `${visual}<button type="button" aria-label="削除">×</button><div><strong>${escapeHtml(file.name)}</strong><small>${formatBytes(file.size)}</small></div>`;
    item.querySelector('button').addEventListener('click', () => { URL.revokeObjectURL(objectUrl); removeMedia(index); });
    mediaPreview.appendChild(item);
  });
}

$('previewPropertyBtn').addEventListener('click', async () => {
  const url = propertyUrl.value.trim();
  if (!url) return showPropertyPreview('URLを入力してください。', true);
  if (!isUnilifeUrl(url)) return showPropertyPreview('UniLifeの物件詳細ページURLを入力してください。', true);
  if (!ensureApiKey()) return;

  const btn = $('previewPropertyBtn'); btn.disabled = true; btn.textContent = '確認中';
  try {
    const page = await resolvePropertyPage(url, true);
    cachedPropertyForCurrentUrl = page;
    showPropertyPreview(`<span>✓</span><div><strong>${escapeHtml(page.title || '物件ページを確認しました')}</strong><small>${escapeHtml(page.description || '物件情報を確認できました。')}</small></div>`);
  } catch (error) {
    handlePossibleRateLimit(error);
    showPropertyPreview(escapeHtml(humanizeError(error)), true);
  } finally {
    btn.disabled = false; btn.textContent = '確認';
  }
});

function showPropertyPreview(html, isError = false) {
  const el = $('propertyPreview'); el.classList.remove('hidden'); el.classList.toggle('error', isError); el.innerHTML = html;
}

propertyUrl.addEventListener('input', () => { cachedPropertyForCurrentUrl = null; });


articleUrl.addEventListener('input', () => {
  $('articlePreview').classList.add('hidden');
});

$('previewArticleBtn').addEventListener('click', () => {
  const url = articleUrl.value.trim();
  const el = $('articlePreview');
  el.classList.remove('hidden');
  if (!url) {
    el.classList.add('error');
    el.innerHTML = 'URLを入力してください。';
    return;
  }
  if (!isUnilifeUrl(url)) {
    el.classList.add('error');
    el.innerHTML = 'UniLifeの公開記事URLを入力してください。';
    return;
  }
  el.classList.remove('error');
  el.innerHTML = '<span>✓</span><div><strong>記事URLを確認しました</strong><small>PDFと入力した物件ページを使って3ソース照合します。</small></div>';
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!ensureApiKey()) return;
  if (currentMode === 'article') return runArticleCheck();
  return runInstagramCheck();
});

async function runInstagramCheck() {
  const url = propertyUrl.value.trim();
  const instagramUrl = $('instagramUrl').value.trim();
  if (!url) return alert('UniLifeの物件ページURLを入力してください。');
  if (!isUnilifeUrl(url)) return alert('UniLifeの物件詳細ページURLを入力してください。');
  if (!selectedMedia.length && !instagramUrl) return alert('Instagramへ投稿予定の画像または動画を追加してください。');

  const videos = selectedMedia.filter(f => f.type.startsWith('video/'));
  const images = selectedMedia.filter(f => f.type.startsWith('image/'));
  if (images.length > 10) return alert('Instagram画像は最大10枚までにしてください。');
  if (videos.length > 1) return alert('安定したチェックのため、動画は1回につき1本までにしてください。');

  setLoading(true);
  try {
    setStage(0, 'Webページの情報を確認しています…');
    const page = cachedPropertyForCurrentUrl?.sourceUrl === url
      ? cachedPropertyForCurrentUrl
      : await resolvePropertyPage(url, false);
    cachedPropertyForCurrentUrl = page;

    setStage(1, 'PDFをGeminiで確認できる形に準備しています…');
    const document = documentInput.files[0] || null;
    const pdfContent = document ? await fileToGeminiContent(document, 'document') : null;

    setStage(2, 'Instagramの画像・動画を準備しています…');
    const mediaContents = [];
    let imageIndex = 0;
    let videoIndex = 0;
    for (const file of selectedMedia) {
      if (file.type.startsWith('image/')) {
        imageIndex += 1;
        mediaContents.push({ type: 'text', text: `【Instagram投稿予定 画像${imageIndex}: ${file.name}】` });
        mediaContents.push(await fileToGeminiContent(file, 'image'));
      } else if (file.type.startsWith('video/')) {
        videoIndex += 1;
        const duration = await getVideoDuration(file);
        setStage(2, `動画を1秒ごとに分解しています…（${file.name}）`);
        const videoParts = await videoToGeminiContents(file, duration);
        mediaContents.push({
          type: 'text',
          text: `【Instagram投稿予定 動画${videoIndex}: ${file.name}】長さ ${duration ? duration.toFixed(1) : '?'}秒。動画は1秒ごとにフレームを抽出し、9コマずつまとめた高解像度コンタクトシートとして添付しています。各コマ左上の時刻（mm:ss）を見て、修正箇所はタイムスタンプ付きで示してください。このGitHub Pages版では動画音声は未解析なので、映像内テロップ・画面情報・見た目を中心に確認してください。`
        });
        mediaContents.push(...videoParts);
        setStage(2, 'Instagramの画像・動画を準備しています…');
      }
    }

    setStage(3, 'Web・PDF・Instagram素材を照合しています…');
    const input = await buildAnalysisInput({ page, propertyUrl: url, instagramUrl, document, pdfContent, mediaContents });
    const result = await callGeminiJson({
      model: GEMINI_MODEL,
      input,
      tools: [{ type: 'url_context' }],
      response_format: { type: 'text', mime_type: 'application/json', schema: buildResultSchema() }
    }, 300_000);

    const data = formatResultPayload(result, page, document, selectedMedia);
    renderResult(data);
  } catch (error) {
    renderCheckError(error);
  } finally {
    setLoading(false, true);
  }
}

async function runArticleCheck() {
  const url = articleUrl.value.trim();
  const propertyUrls = parseArticlePropertyUrls();
  if (!url) return alert('チェックしたい記事URLを入力してください。');
  if (!isUnilifeUrl(url)) return alert('UniLifeの公開記事URLを入力してください。');
  const invalidPropertyUrl = propertyUrls.find(v => !isUnilifePropertyUrl(v));
  if (invalidPropertyUrl) return alert(`物件ページURLを確認してください：${invalidPropertyUrl}`);

  setLoading(true);
  try {
    setStage(0, '記事ページの内容を確認しています…');
    const outline = await resolveArticleOutline(url);

    setStage(1, 'PDFをGeminiで確認できる形に準備しています…');
    const pdfContents = [];
    for (const file of selectedArticlePdfs) {
      pdfContents.push({ file, content: await fileToGeminiContent(file, 'document') });
    }

    setStage(2, propertyUrls.length ? `${propertyUrls.length}件の指定物件ページと記事内リンクを確認しています…` : '記事内の物件ページリンクを自動検出して確認しています…');
    const mergedOutline = mergeArticlePropertyUrls(outline, propertyUrls);
    const today = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const input = buildArticleAnalysisInput(url, today, mergedOutline, propertyUrls, pdfContents);

    const result = await callGeminiJson({
      model: GEMINI_MODEL,
      input,
      tools: [{ type: 'url_context' }],
      response_format: { type: 'text', mime_type: 'application/json', schema: buildArticleResultSchema() }
    }, 420_000);

    setStage(3, '記事と利用可能な参照情報の差分を整理しています…');
    const data = formatArticleResultPayload(result, url);
    if (!data.articleTitle && outline.title) data.articleTitle = outline.title;
    if (!data.overview && outline.overview) data.overview = outline.overview;
    data.pdfCount = selectedArticlePdfs.length;
    renderArticleResult(data);
  } catch (error) {
    renderCheckError(error);
  } finally {
    setLoading(false, true);
  }
}

function mergeArticlePropertyUrls(outline, explicitUrls) {
  const detected = Array.isArray(outline?.properties) ? outline.properties : [];
  const byUrl = new Map(detected.map(item => [normalizeUrlForCompare(item.property_url), item]));
  const properties = explicitUrls.map(url => {
    const found = byUrl.get(normalizeUrlForCompare(url));
    return found || { property_name: '', property_url: url, article_location: '入力された比較対象' };
  });
  detected.forEach(item => {
    const key = normalizeUrlForCompare(item.property_url);
    if (!properties.some(p => normalizeUrlForCompare(p.property_url) === key)) properties.push(item);
  });
  return { ...outline, properties: properties.slice(0, 20) };
}

function buildArticleAnalysisInput(url, today, outline, explicitUrls, pdfContents) {
  const input = [{ type: 'text', text: buildArticleAnalysisPrompt(url, today, outline, explicitUrls, pdfContents.map(x => x.file.name)) }];
  if (pdfContents.length) {
    pdfContents.forEach((entry, index) => {
      input.push({ type: 'text', text: `【比較用PDF ${index + 1}: ${entry.file.name}】物件名を確認し、対応する物件にだけ使用してください。別物件のPDFを混ぜないでください。` });
      input.push(entry.content);
    });
  } else {
    input.push({ type: 'text', text: '【比較用PDF】未添付です。PDFの値は「未添付 / 不明」とし、記事とWebの2ソースだけで断定しすぎないでください。' });
  }
  return input;
}

async function resolveArticleOutline(url) {
  const cacheKey = `unilife-article-outline::${url}`;
  const cached = readCache(cacheKey);
  if (cached) return cached;

  try {
    const direct = await fetchArticleOutlineDirect(url);
    if (direct.properties.length) {
      writeCache(cacheKey, direct, PROPERTY_CACHE_TTL_MS);
      return direct;
    }
  } catch {}

  const result = await callGeminiJson({
    model: GEMINI_MODEL,
    input: [{ type: 'text', text: `次のUniLife記事をURL Contextで開いてください。記事の主本文で紹介されている物件だけを特定し、記事内に実在する https://unilife.co.jp/view/... 形式のリンクを正確に抽出してください。サイト共通ナビ、関連記事、検索一覧へのリンクは除外してください。URLを推測・生成しないでください。\n\n記事URL: ${url}` }],
    tools: [{ type: 'url_context' }],
    response_format: { type: 'text', mime_type: 'application/json', schema: buildArticleOutlineSchema() }
  }, 180_000);
  const outline = {
    title: result.article_title || '',
    overview: result.article_overview || '',
    text: '',
    properties: (result.properties || []).filter(p => isHttpUrl(p.property_url) && isUnilifeUrl(p.property_url)).slice(0, 20),
    via: 'url_context'
  };
  writeCache(cacheKey, outline, PROPERTY_CACHE_TTL_MS);
  return outline;
}

async function fetchArticleOutlineDirect(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, { signal: controller.signal, mode: 'cors', redirect: 'follow' });
    if (!response.ok) throw new Error(`ARTICLE_HTTP_${response.status}`);
    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const title = doc.querySelector('h1,h2,h3')?.textContent?.trim() || doc.querySelector('title')?.textContent?.trim() || '';
    const description = doc.querySelector('meta[name="description"]')?.getAttribute('content')?.trim() || '';
    const links = [];
    doc.querySelectorAll('a[href]').forEach(anchor => {
      const href = toAbsoluteUrl(anchor.getAttribute('href'), url);
      if (!/^https?:\/\/(?:www\.)?unilife\.co\.jp\/view\/\d+\/?(?:[?#].*)?$/i.test(href)) return;
      const propertyName = normalizeText(anchor.textContent || '').slice(0, 160);
      if (!links.some(item => item.property_url === href)) links.push({ property_name: propertyName, property_url: href, article_location: propertyName || '記事本文' });
    });
    return { title, overview: description, text: normalizeText(doc.body?.innerText || '').slice(0, 55000), properties: links.slice(0, 20), via: 'direct' };
  } finally { clearTimeout(timer); }
}

function buildArticleOutlineSchema() {
  return {
    type: 'object',
    required: ['article_title','article_overview','properties'],
    properties: {
      article_title: { type: 'string' },
      article_overview: { type: 'string' },
      properties: {
        type: 'array', items: {
          type: 'object', required: ['property_name','property_url','article_location'],
          properties: { property_name: { type: 'string' }, property_url: { type: 'string' }, article_location: { type: 'string' } }
        }
      }
    }
  };
}

function renderCheckError(error) {
  handlePossibleRateLimit(error);
  $('loadingState').classList.add('hidden');
  $('resultContent').classList.add('hidden');
  $('articleResultContent').classList.add('hidden');
  $('emptyState').classList.remove('hidden');
  $('emptyState').innerHTML = `<div class="empty-graphic error">!</div><h3>チェックできませんでした</h3><p>${escapeHtml(humanizeError(error))}</p>`;
}

function buildArticleAnalysisPrompt(url, today, outline, explicitUrls = [], pdfNames = []) {
  return `あなたはUniLifeのWeb記事・物件情報校正アシスタントです。
チェック対象の記事ページを基準に、利用可能な参照情報だけを使って照合してください。

利用できる情報は次の3種類です。
1. チェック対象の記事ページ（必須）
2. UniLife公式物件ページ（ユーザー指定または記事内リンクから自動検出。なくても可）
3. 添付された物件詳細PDF（なくても可）

PDFと物件ページは両方そろっている必要はありません。片方だけの場合は、その情報と記事を比較してください。両方ある場合は3ソースで比較してください。

【チェック対象の記事URL】
${url}

【今日の日付（日本時間）】
${today}

【ユーザーが指定した比較対象の物件ページ】
${explicitUrls.length ? explicitUrls.map((u, i) => `${i + 1}. ${u}`).join('\n') : '指定なし'}

【記事から検出した主紹介物件・比較候補】
${outline.properties.length ? outline.properties.map((p, i) => `${i + 1}. ${p.property_name || '物件名はページで確認'}
   ${p.property_url}
   記事内位置: ${p.article_location || '不明'}`).join('\n') : '記事内リンクは事前抽出できませんでした。ユーザー指定URLを使ってください。'}
${outline.text ? `\n【ブラウザから取得した記事本文の補助テキスト】\n${outline.text.slice(0, 45000)}` : ''}

【添付PDF】
${pdfNames.length ? pdfNames.map((n, i) => `${i + 1}. ${n}`).join('\n') : '未添付'}

手順:
1. 記事URLをURL Contextで必ず開き、記事本文に書かれている事実表現を確認する。
2. ユーザー指定の物件ページURLがある場合はURL Contextで開く。指定がない場合は、記事本文で確認できる /view/ の物件リンクを自動検出して使う。物件ページを確認できない場合は web_value を「未指定 / 確認できず」とする。
3. PDFが添付されている場合だけ読み、PDF内の物件名を確認して対応する物件だけに紐づける。別物件のPDF情報を混ぜない。PDFがない場合は pdf_value を「未添付」とする。
4. 各項目について「記事」「物件ページ」「PDF」の3欄を返すが、存在しないソースを無理に補完しない。
5. 物件ページとPDFの両方がある場合、それらが一致していれば公式情報の基準として記事を判定する。
6. 物件ページとPDFの両方があり、両者が明確に食い違う場合のみ official_conflict とする。
7. 物件ページかPDFの片方しかない場合は、その1ソースを参照して記事を判定してよい。存在しないソースがないこと自体を needs_review にしない。
8. 記事に複数物件がある場合は、文章・画像・費用・設備を必ず物件ごとに分ける。
9. 記事全体のキャンペーン期間・店舗営業日・広告有効期限なども確認する。PDFに該当情報がなければ無理に補わない。

チェック対象:
- 物件名、住所
- 家賃・共益費・管理費・敷金礼金・入館金などの費用
- 間取り、専有面積、完成年月・築年月
- 駅・バス停までの徒歩分数
- 大学までの徒歩分数・通学情報
- オートロック、防犯カメラ、宅配BOX、家具家電、食事、ネット無料などの設備・サービス
- キャンペーン名、対象者、期間、割引内容
- 空室・募集状況に関する断定表現
- 記事内画像と公式物件ページ/PDF画像の整合性（視覚的根拠を十分確認できる場合のみ）
- 店舗営業日、広告有効期限、日付・曜日の論理的な矛盾
- 広告コピー、キャッチコピー、見出しの事実性

判定ルール:
- match: 利用可能な参照ソースと記事の意味が一致。WebまたはPDFの片方しかない場合でも、その参照ソースと記事が明確に一致していれば match 可。存在しないソースの値は「未添付」「未指定 / 確認できず」など正直に返す。
- mismatch: 記事の記載が、利用可能な物件ページまたはPDFの情報と明確に異なり、修正候補を示せる。
- notation_variation: 意味は同じで表記のみ異なる。「『A』と『B』の表記揺れ」のような小見出しにする。
- needs_review: 情報不足、時点依存、PDFの対応物件が不明、画像根拠が弱いなど、人の確認が必要。
- official_conflict: WebとPDFの両方が提供・確認できており、その公式情報同士に明確な差がある場合のみ使う。
- 「リニューアルオープン」と「フルリニューアルオープン」のように、一語の追加・削除で意味や訴求範囲が変わる場合は notation_variation ではなく mismatch とする。
- 「全室」「全館」「完全」「フル」「新築」「新設」「予定」「限定」「無料」など、事実の範囲や程度を変える語を厳密に確認する。
- 記事に書かれていない情報を勝手にチェック項目へ追加しない。
- 推測でURL・値・物件名を補わない。
- ユーザーが指定した物件ページURLがある場合は比較対象として優先する。未指定なら記事内の物件リンクを使う。
- issue_title は「『徒歩10分』と『徒歩11分』の差」「WebとPDFで家賃が異なります」のように、一目で内容が分かる小見出しにする。
- location は「学生会館○○／アクセス欄」「記事冒頭／店舗営業日」のように探しやすくする。
- image_checks は根拠が弱い場合に無理に同一・別物件と断定しない。

最終結果は、記事全体の確認と、物件ごとの確認を分けて返してください。`;
}

async function buildAnalysisInput({ page, propertyUrl, instagramUrl, document, pdfContent, mediaContents }) {
  const input = [];
  input.push({
    type: 'text',
    text: `あなたはUniLifeの不動産広告・SNSクリエイティブ校正アシスタントです。
公式Webページと物件詳細PDFを一次情報として、Instagramへ投稿予定の画像・動画内に表示されている物件情報を照合してください。

【公式WebページURL】
${propertyUrl}
URL Contextツールを必ず使い、このURLの現在の公開情報を一次情報として確認してください。
${page?.text ? `\nブラウザ側でも取得できた補助テキスト:\n${page.text.slice(0, 45000)}` : ''}
${page?.title ? `\nページタイトル: ${page.title}` : ''}
${page?.description ? `\nページ説明: ${page.description}` : ''}

${instagramUrl ? `【Instagram投稿URL】\n${instagramUrl}\n公開状態で取得可能ならURL Contextでも確認してください。取得できない場合はアップロード素材を優先してください。` : ''}

重要ルール:
- 画像内の文字、動画の画面内文字・図表を確認する。
- 動画は1秒ごとにフレーム抽出したコンタクトシートとして渡される。各コマ左上の時刻ラベルを見て判断する。
- このGitHub Pages版では動画音声は未解析のため、音声由来の断定はしない。
- 広告コピー・キャッチコピー・見出しも事実確認の対象にする。
- 「リニューアルオープン」と「フルリニューアルオープン」のように、一語の追加・削除で意味や訴求範囲が変わる場合は表記揺れではなく mismatch とする。
- 「全室」「全館」「完全」「フル」「新築」「新設」「リニューアル」「オープン」「予定」「限定」「無料」など、事実の範囲・程度・時期を強めたり変えたりする語を厳密に確認する。
- 年月・日付も広告コピーの一部として確認し、「2026年3月リニューアルオープン」のような時期情報の欠落・変更も見逃さない。
- 動画フレーム内のテロップは、各コマごとに文章として正確に読み取ってから公式情報と比較する。
- 文字が小さい・ぼやけている等で正確に読めない場合は、一致扱いにせず needs_review とする。
- 公式情報にない強い表現がInstagram側だけに追加されている場合は mismatch とする。
- 家賃、共益費、管理費、敷金礼金、間取り、専有面積、最寄駅、徒歩分数、大学までの距離・時間、設備、家具家電、築年月、キャンペーン等、投稿内で事実として表現されている項目を対象にする。
- Instagramに書かれていない項目を無理にチェック項目へ追加しない。
- WebとPDFで同じならそれを正とする。WebとPDF自体が矛盾する場合は official_conflict にして、人間確認を促す。
- 数字・単位・「〜」「より」「最大」「予定」などの条件差も確認する。
- 推測で値を補わない。不明なら needs_review とする。
- 文字情報だけでなく、Instagram素材に写る建物外観・エントランス・共用部・室内画像が、Web/PDFに掲載された公式画像と整合するか確認する。
- 同じ写真のトリミング・圧縮・軽い色調整は same_image。撮影角度が異なっても複数の特徴が一致する場合は same_property_likely。
- 室内は似た間取りが多いため、明確な特徴がなければ needs_review。無理に同一物件と断定しない。
- 明らかに外壁・窓・バルコニー・入口などが矛盾する場合のみ different_property_likely。
- テキストだけの画像、地図、ロゴ等で建物照合が不要なら not_applicable。
- 表記の違いだけで意味が同じ場合は notation_variation とし、issue_title に「『A』と『B』の表記揺れ」のような短い見出しを書く。
- issue_title は「家賃が公式情報より2,000円低い」のように一目で分かる具体的な小見出しにする。
- image_checks の official_reference には「公式Web画像2」「PDF 3ページの外観写真」のように、担当者が探せる表現を書く。
- 画像判定の confidence が low の場合は、明確な別物件の証拠がない限り needs_review とする。
- location には「画像2」「動画 00:06」など、修正箇所を探しやすい位置を書く。
- recommended_value は公式情報に基づく修正候補。公式側が矛盾している場合は「要確認」。`
  });

  const officialImages = [...new Set(page?.imageUrls || [])].slice(0, WEB_IMAGE_MAX);
  if (officialImages.length) {
    input.push({ type: 'text', text: `【公式Webページ掲載画像候補】以下${officialImages.length}枚を建物・室内画像照合の補助に使ってください。` });
    officialImages.forEach((url, index) => {
      input.push({ type: 'text', text: `公式Web画像${index + 1}` });
      input.push({ type: 'image', uri: url });
    });
  } else {
    input.push({ type: 'text', text: '【公式Webページ掲載画像】ブラウザから画像URLを抽出できませんでした。URL Contextで得られる情報とPDF内画像を優先し、画像証拠が足りなければ needs_review としてください。' });
  }

  if (document && pdfContent) {
    input.push({ type: 'text', text: `【物件詳細PDF: ${document.name}】PDF内の文字・表・図・写真も一次情報として確認してください。` });
    input.push(pdfContent);
  } else {
    input.push({ type: 'text', text: '【物件詳細PDF】未添付です。PDF値は「未添付 / 不明」としてください。' });
  }
  input.push(...mediaContents);
  return input;
}

async function resolvePropertyPage(url, allowGeminiFallback) {
  const cacheKey = `unilife-page::${url}`;
  const cached = readCache(cacheKey);
  if (cached) return cached;

  try {
    const direct = await fetchPropertyDirect(url);
    writeCache(cacheKey, direct, PROPERTY_CACHE_TTL_MS);
    return direct;
  } catch (directError) {
    if (!allowGeminiFallback) {
      const minimal = { title: '', description: '', text: '', image: '', imageUrls: [], sourceUrl: url, via: 'url_context' };
      writeCache(cacheKey, minimal, 5 * 60_000);
      return minimal;
    }
    const viaGemini = await fetchPropertyViaGemini(url);
    writeCache(cacheKey, viaGemini, PROPERTY_CACHE_TTL_MS);
    return viaGemini;
  }
}

async function fetchPropertyDirect(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, { signal: controller.signal, mode: 'cors', redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const meta = (selector, attr = 'content') => doc.querySelector(selector)?.getAttribute(attr)?.trim() || '';
    const title = meta('meta[property="og:title"]') || doc.querySelector('title')?.textContent?.trim() || '';
    const description = meta('meta[property="og:description"]') || meta('meta[name="description"]');
    const image = toAbsoluteUrl(meta('meta[property="og:image"]'), url);
    const imageUrls = [];
    const add = (raw) => {
      if (!raw) return;
      const first = String(raw).split(',')[0].trim().split(/\s+/)[0];
      const absolute = toAbsoluteUrl(first, url);
      if (!absolute || !isUnilifeUrl(absolute) || /\.(svg|gif)(\?|$)/i.test(absolute)) return;
      if (/(logo|icon|sprite|loading|noimage|no-image|blank|favicon|btn_|button)/i.test(absolute)) return;
      if (!imageUrls.includes(absolute)) imageUrls.push(absolute);
    };
    add(image);
    doc.querySelectorAll('img').forEach(img => {
      add(img.getAttribute('data-src')); add(img.getAttribute('data-original')); add(img.getAttribute('data-lazy-src')); add(img.getAttribute('src')); add(img.getAttribute('srcset'));
    });
    doc.querySelectorAll('source').forEach(node => add(node.getAttribute('srcset')));
    doc.querySelectorAll('script,style,noscript,svg,iframe').forEach(n => n.remove());
    const text = normalizeText(doc.body?.innerText || '').slice(0, 55000);
    return { title, description, text, image, imageUrls: imageUrls.slice(0, 20), sourceUrl: url, via: 'browser' };
  } finally { clearTimeout(timer); }
}

async function fetchPropertyViaGemini(url) {
  const schema = {
    type: 'object', required: ['title','description','image','image_urls','facts'],
    properties: {
      title: { type: 'string' }, description: { type: 'string' }, image: { type: 'string' },
      image_urls: { type: 'array', items: { type: 'string' } }, facts: { type: 'string' }
    }
  };
  const data = await callGeminiJson({
    model: GEMINI_MODEL,
    input: `URL Contextを使って次のUniLife物件ページを確認してください。物件名、短い説明、主要な物件情報をfactsにまとめてください。HTMLや取得内容から物件写真の直接URLが明確に確認できる場合だけimage_urlsに最大${WEB_IMAGE_MAX}件入れてください。推測した画像URLは作らないでください。URL: ${url}`,
    tools: [{ type: 'url_context' }],
    response_format: { type: 'text', mime_type: 'application/json', schema }
  }, 90_000);
  const imageUrls = (data.image_urls || []).filter(isHttpUrl).filter(isUnilifeUrl).slice(0, WEB_IMAGE_MAX);
  return { title: data.title || '', description: data.description || '', text: data.facts || '', image: isHttpUrl(data.image) ? data.image : (imageUrls[0] || ''), imageUrls, sourceUrl: url, via: 'url_context' };
}

async function fileToGeminiContent(file, kind) {
  const inlineLimit = kind === 'document' ? 15 * 1024 * 1024 : 10 * 1024 * 1024;
  if (file.size <= inlineLimit) {
    return { type: kind, data: await fileToBase64(file), mime_type: normalizedMime(file, kind) };
  }
  const uploaded = await uploadFileToGemini(file);
  return { type: kind, uri: uploaded.uri, mime_type: uploaded.mime_type || normalizedMime(file, kind) };
}

async function videoToGeminiContents(file, durationHint = 0) {
  const { video, url } = await loadVideoForFrameExtraction(file);
  try {
    const duration = durationHint || (Number.isFinite(video.duration) ? video.duration : 0);
    if (!duration || duration <= 0) throw new Error('動画の長さを取得できませんでした。');

    const totalFrames = Math.max(1, Math.ceil(duration));

    // 1秒ごとの抽出は維持しつつ、
    // 文字を読みやすくするため1枚あたり9コマに減らす
    const framesPerSheet = 9;

    const isVertical = (video.videoHeight || 0) > (video.videoWidth || 0);

    const columns = 3;
    const rows = 3;

    // 1コマを大きくする
    const cellWidth = isVertical ? 360 : 426;
    const cellHeight = isVertical ? 640 : 240;

    const quality = 0.90;
    const parts = [];

    for (let start = 0; start < totalFrames; start += framesPerSheet) {
      const count = Math.min(framesPerSheet, totalFrames - start);
      const canvas = document.createElement('canvas');
      canvas.width = columns * cellWidth;
      canvas.height = rows * cellHeight;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      let firstLabel = '';
      let lastLabel = '';
      for (let localIndex = 0; localIndex < count; localIndex += 1) {
        const second = start + localIndex;
        const seekTime = Math.min(second + 0.05, Math.max(0.05, duration - 0.05));
        await seekVideo(video, seekTime);

        const label = formatVideoTime(second);
        if (!firstLabel) firstLabel = label;
        lastLabel = label;

        const col = localIndex % columns;
        const row = Math.floor(localIndex / columns);
        const x = col * cellWidth;
        const y = row * cellHeight;
        drawVideoIntoCell(ctx, video, x, y, cellWidth, cellHeight);
        drawFrameLabel(ctx, label, x, y);
      }

      const base64 = await canvasToBase64(canvas, quality);
      const sheetNo = Math.floor(start / framesPerSheet) + 1;
      const sheetTotal = Math.ceil(totalFrames / framesPerSheet);
      parts.push({
        type: 'text',
        text: `動画コンタクトシート ${sheetNo}/${sheetTotal}（${firstLabel}〜${lastLabel}、${count}コマ）`
      });
      parts.push({ type: 'image', data: base64, mime_type: 'image/jpeg' });
    }

    return parts;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function uploadFileToGemini(file) {
  const start = await fetch(`${FILES_BASE}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': GEMINI_API_KEY,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(file.size),
      'X-Goog-Upload-Header-Content-Type': normalizedMime(file),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ file: { display_name: file.name } })
  });
  if (!start.ok) throw await geminiResponseError(start);
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('Gemini Files APIのアップロードURLを取得できませんでした。ブラウザのCORS制限を確認してください。');

  const uploadedRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' },
    body: file
  });
  if (!uploadedRes.ok) throw await geminiResponseError(uploadedRes);
  const uploadedJson = await uploadedRes.json();
  let info = uploadedJson.file || uploadedJson;
  if (!info?.uri) throw new Error('Geminiへのファイルアップロード結果を取得できませんでした。');

  if ((info.state || '').toUpperCase() === 'PROCESSING') {
    info = await waitForGeminiFile(info.name, 180_000);
  }
  if ((info.state || '').toUpperCase() === 'FAILED') throw new Error(`${file.name} のGemini側処理に失敗しました。`);
  return info;
}

async function waitForGeminiFile(name, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await sleep(3000);
    const response = await fetch(`${FILES_BASE}/v1beta/${name}`, { headers: { 'x-goog-api-key': GEMINI_API_KEY } });
    if (!response.ok) throw await geminiResponseError(response);
    const info = await response.json();
    const state = String(info.state || '').toUpperCase();
    if (!state || state === 'ACTIVE') return info;
    if (state === 'FAILED') return info;
  }
  throw new Error('動画のアップロード処理に時間がかかっています。少し待ってからもう一度お試しください。');
}

async function callGeminiJson(payload, timeoutMs = 240_000) {
  const response = await fetchWithTimeout(INTERACTIONS_URL, {
    method: 'POST',
    headers: {
      'x-goog-api-key': GEMINI_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  }, timeoutMs);
  if (!response.ok) throw await geminiResponseError(response);
  const data = await response.json();
  const outputText = extractOutputText(data);
  if (!outputText) throw new Error('Geminiから判定結果を取得できませんでした。');
  try { return JSON.parse(outputText); }
  catch { throw new Error('Geminiの結果をJSONとして読み取れませんでした。もう一度チェックしてください。'); }
}

function extractOutputText(data) {
  const steps = Array.isArray(data?.steps) ? data.steps : [];
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    if (steps[i]?.type !== 'model_output') continue;
    const text = (steps[i].content || []).filter(c => c?.type === 'text').map(c => c.text || '').join('\n').trim();
    if (text) return text;
  }
  if (typeof data?.output_text === 'string') return data.output_text;
  if (Array.isArray(data?.outputs)) return data.outputs.filter(o => o?.type === 'text').map(o => o.text || '').join('\n').trim();
  return '';
}

async function geminiResponseError(response) {
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  const raw = body?.error?.message || body?.message || `HTTP ${response.status}`;
  const serialized = JSON.stringify(body || {});
  const retryMatch = `${raw} ${serialized}`.match(/retry(?:\s+in|Delay[^0-9]*)?\s*[:=]?\s*([\d.]+)s/i);
  const retryAfter = retryMatch ? Math.ceil(Number(retryMatch[1])) : (response.status === 429 ? 40 : 0);
  return new GeminiHttpError(raw, response.status, retryAfter);
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  catch (error) {
    if (error?.name === 'AbortError') throw new Error('AI_TIMEOUT');
    throw error;
  } finally { clearTimeout(timer); }
}

function buildArticleResultSchema() {
  const comparisonItem = {
    type: 'object',
    required: ['label','article_value','web_value','pdf_value','status','location','issue_title','issue','recommended_value','confidence'],
    properties: {
      label: { type: 'string' },
      article_value: { type: 'string' },
      web_value: { type: 'string' },
      pdf_value: { type: 'string' },
      status: { type: 'string', enum: ['match','mismatch','needs_review','notation_variation','official_conflict'] },
      location: { type: 'string' },
      issue_title: { type: 'string' },
      issue: { type: 'string' },
      recommended_value: { type: 'string' },
      confidence: { type: 'string', enum: ['high','medium','low'] }
    }
  };
  const imageCheck = {
    type: 'object',
    required: ['article_location','article_description','official_reference','status','reason','confidence'],
    properties: {
      article_location: { type: 'string' }, article_description: { type: 'string' }, official_reference: { type: 'string' },
      status: { type: 'string', enum: ['same_image','same_property_likely','needs_review','different_property_likely','not_applicable'] },
      reason: { type: 'string' }, confidence: { type: 'string', enum: ['high','medium','low'] }
    }
  };
  return {
    type: 'object',
    required: ['article_title','article_overview','detected_property_count','article_checks','properties','overall_notes'],
    properties: {
      article_title: { type: 'string' },
      article_overview: { type: 'string' },
      detected_property_count: { type: 'integer' },
      article_checks: { type: 'array', items: comparisonItem },
      properties: {
        type: 'array', items: {
          type: 'object',
          required: ['property_name','property_url','article_location','summary','items','image_checks','notes'],
          properties: {
            property_name: { type: 'string' }, property_url: { type: 'string' }, article_location: { type: 'string' }, summary: { type: 'string' },
            items: { type: 'array', items: comparisonItem }, image_checks: { type: 'array', items: imageCheck }, notes: { type: 'array', items: { type: 'string' } }
          }
        }
      },
      overall_notes: { type: 'array', items: { type: 'string' } }
    }
  };
}

function formatArticleResultPayload(result, url) {
  const properties = Array.isArray(result?.properties) ? result.properties : [];
  const articleChecks = Array.isArray(result?.article_checks) ? result.article_checks : [];
  let mismatch = 0, review = 0, match = 0;
  const countItems = items => (items || []).forEach(item => {
    if (item.status === 'mismatch') mismatch += 1;
    else if (item.status === 'needs_review' || item.status === 'notation_variation' || item.status === 'official_conflict') review += 1;
    else if (item.status === 'match') match += 1;
  });
  countItems(articleChecks);
  properties.forEach(prop => countItems(prop.items));
  return {
    articleUrl: url,
    articleTitle: result?.article_title || 'Web記事',
    overview: result?.article_overview || '',
    detectedPropertyCount: Number(result?.detected_property_count ?? properties.length),
    articleChecks,
    properties,
    overallNotes: Array.isArray(result?.overall_notes) ? result.overall_notes : [],
    counts: { mismatch, review, match }
  };
}

function buildResultSchema() {
  return {
    type: 'object',
    required: ['property_name', 'media_overview', 'web_pdf_consistency', 'items', 'image_checks', 'image_summary', 'overall_notes'],
    properties: {
      property_name: { type: 'string' },
      media_overview: { type: 'string' },
      web_pdf_consistency: {
        type: 'object', required: ['status', 'note'],
        properties: { status: { type: 'string', enum: ['一致', '一部不一致', '判定不能'] }, note: { type: 'string' } }
      },
      items: {
        type: 'array', items: {
          type: 'object',
          required: ['label','instagram_value','web_value','pdf_value','status','location','issue_title','issue','issue_type','recommended_value','confidence'],
          properties: {
            label: { type: 'string' }, instagram_value: { type: 'string' }, web_value: { type: 'string' }, pdf_value: { type: 'string' },
            status: { type: 'string', enum: ['match','mismatch','needs_review','official_conflict','notation_variation'] },
            location: { type: 'string' }, issue_title: { type: 'string' }, issue: { type: 'string' },
            issue_type: { type: 'string', enum: ['factual_mismatch','notation_variation','unclear','official_conflict','missing_information','other'] },
            recommended_value: { type: 'string' }, confidence: { type: 'string', enum: ['high','medium','low'] }
          }
        }
      },
      image_checks: {
        type: 'array', items: {
          type: 'object',
          required: ['instagram_location','instagram_description','official_source','official_reference','status','reason','confidence'],
          properties: {
            instagram_location: { type: 'string' }, instagram_description: { type: 'string' },
            official_source: { type: 'string', enum: ['Web','PDF','Web/PDF','見つからない'] }, official_reference: { type: 'string' },
            status: { type: 'string', enum: ['same_image','same_property_likely','needs_review','different_property_likely','not_applicable'] },
            reason: { type: 'string' }, confidence: { type: 'string', enum: ['high','medium','low'] }
          }
        }
      },
      image_summary: { type: 'string' },
      overall_notes: { type: 'array', items: { type: 'string' } }
    }
  };
}

function formatResultPayload(result, page, document, mediaFiles) {
  const items = Array.isArray(result.items) ? result.items : [];
  const counts = { match: 0, mismatch: 0, needs_review: 0, official_conflict: 0, notation_variation: 0, total: items.length };
  items.forEach(item => { if (item.status in counts) counts[item.status] += 1; });
  const imageCounts = { same_image: 0, same_property_likely: 0, needs_review: 0, different_property_likely: 0 };
  (result.image_checks || []).forEach(item => { if (item.status in imageCounts) imageCounts[item.status] += 1; });
  return {
    ok: true,
    property: { title: result.property_name || page?.title || '物件情報', image: page?.image || '', description: page?.description || 'UniLife物件ページ・PDF・Instagram素材を照合しました。' },
    result, counts, imageCounts,
    sourceInfo: { web: true, webMode: 'url_context', pdf: Boolean(document), instagramFiles: mediaFiles.map(f => ({ name: f.name, type: f.type })), webImagesChecked: Math.min(WEB_IMAGE_MAX, page?.imageUrls?.length || 0) },
    warnings: page?.via === 'url_context' ? ['WebページはGeminiのURL Contextを使って確認しています。'] : []
  };
}

function ensureApiKey() {
  if (GEMINI_API_KEY && GEMINI_API_KEY !== '__GEMINI_API_KEY__') return true;
  alert('Gemini APIキーが設定されていません。GitHubの Settings → Secrets and variables → Actions に GEMINI_API_KEY を追加して、Pagesを再デプロイしてください。');
  return false;
}

function handlePossibleRateLimit(error) {
  if (!(error instanceof GeminiHttpError) || error.status !== 429) return;
  startCooldown(error.retryAfter || 40);
}

function startCooldown(seconds) {
  clearInterval(cooldownTimer);
  let left = Math.max(1, Math.round(seconds));
  const notice = $('aiNotice');
  notice.classList.remove('hidden');
  submitBtn.disabled = true;
  const update = () => {
    notice.innerHTML = `<strong>AIの利用上限に一時的に達しました</strong><br>約${left}秒後にもう一度お試しください。 <code>再試行まで ${formatClock(left)}</code>`;
    submitLabel.textContent = `再試行まで ${formatClock(left)}`;
    if (left <= 0) {
      clearInterval(cooldownTimer); cooldownTimer = null;
      submitBtn.disabled = false; submitLabel.textContent = idleSubmitLabel();
      notice.innerHTML = '<strong>再試行できます。</strong> 同じ素材ならそのままもう一度チェックしてください。';
      return;
    }
    left -= 1;
  };
  update();
  cooldownTimer = setInterval(update, 1000);
}

function humanizeError(error) {
  if (error instanceof GeminiHttpError) {
    if (error.status === 429) return `AIの利用上限に一時的に達しました。約${error.retryAfter || 40}秒後にもう一度お試しください。`;
    if (error.status === 401 || error.status === 403) return 'Gemini APIキーまたはAPIの利用設定を確認してください。';
    if (error.status === 404) return `指定モデル「${GEMINI_MODEL}」を利用できません。モデル設定を確認してください。`;
    if (error.status === 400) return `Geminiへの入力形式を処理できませんでした：${error.message}`;
    if (error.status >= 500) return 'Gemini側で一時的なエラーが発生しました。少し待ってもう一度お試しください。';
  }
  if (/AI_TIMEOUT/.test(error?.message || '')) return 'AI解析が5分以内に完了しませんでした。通信状況を確認してもう一度お試しください。';
  if (/Failed to fetch|NetworkError/i.test(error?.message || '')) return '通信に失敗しました。GitHub PagesからGemini APIへ接続できるか、ネットワーク設定を確認してください。';
  return error?.message || 'チェック中にエラーが発生しました。';
}

function estimateProcessingSeconds() {
  if (currentMode === 'article') {
    const pdfMb = selectedArticlePdfs.reduce((sum, f) => sum + f.size, 0) / 1024 / 1024;
    const propertyCount = parseArticlePropertyUrls().length;
    return Math.max(60, Math.min(420, Math.round(55 + propertyCount * 25 + selectedArticlePdfs.length * 15 + Math.min(80, pdfMb * 0.8))));
  }
  const pdf = documentInput.files[0];
  const images = selectedMedia.filter(f => f.type.startsWith('image/'));
  const videos = selectedMedia.filter(f => f.type.startsWith('video/'));
  const totalImageMb = images.reduce((sum, f) => sum + f.size, 0) / 1024 / 1024;
  const totalVideoMb = videos.reduce((sum, f) => sum + f.size, 0) / 1024 / 1024;
  const pdfMb = pdf ? pdf.size / 1024 / 1024 : 0;
  let seconds = 24 + images.length * 7 + Math.min(18, totalImageMb * 0.8);
  if (pdf) seconds += 8 + Math.min(18, pdfMb * 0.7);
  seconds += videos.length * 42 + Math.min(120, totalVideoMb * 1.1);
  return Math.max(30, Math.min(300, Math.round(seconds)));
}

function formatClock(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function updateLoadingUi() {
  if (!loadingStartedAt) return;
  const elapsed = Math.max(0, (Date.now() - loadingStartedAt) / 1000);
  const ratio = elapsed / loadingEstimateSeconds;
  const progress = ratio <= 1 ? Math.min(90, ratio * 90) : Math.min(95, 90 + (ratio - 1) * 2.5);
  $('progressBar').style.width = `${Math.max(2, progress)}%`;
  $('elapsedTime').textContent = `経過 ${formatClock(elapsed)}`;
  const remaining = loadingEstimateSeconds - elapsed;
  if (remaining > 0) {
    $('remainingTime').textContent = `残り約 ${formatClock(remaining)}`;
    $('estimateNote').textContent = '処理時間は素材の枚数・動画の長さ・通信状況による目安です。';
  } else {
    $('remainingTime').textContent = '通常より時間がかかっています';
    $('estimateNote').textContent = '長い動画やGemini APIの混雑で目安を超えることがあります。';
  }
}

function startLoadingEstimate() {
  loadingEstimateSeconds = estimateProcessingSeconds();
  loadingStartedAt = Date.now();
  $('progressBar').style.width = '2%';
  $('remainingTime').textContent = `残り約 ${formatClock(loadingEstimateSeconds)}`;
  $('elapsedTime').textContent = '経過 0:00';
  updateLoadingUi();
  clearInterval(loadingTimer);
  loadingTimer = setInterval(updateLoadingUi, 1000);
}

function stopLoadingEstimate(completed = false) {
  clearInterval(loadingTimer); loadingTimer = null;
  if (completed) $('progressBar').style.width = '100%';
  loadingStartedAt = 0;
}

function setStage(stage, label) {
  $('loadingText').textContent = label;
  document.querySelectorAll('#loadingSteps [data-stage]').forEach((el, idx) => {
    el.classList.toggle('active', idx === stage);
    el.classList.toggle('done', idx < stage);
  });
}

function setLoading(on, preserveResult = false) {
  if (!cooldownTimer) submitBtn.disabled = on;
  submitLabel.textContent = on ? 'チェック中…' : (cooldownTimer ? submitLabel.textContent : idleSubmitLabel());
  if (on) {
    $('emptyState').classList.add('hidden');
    $('resultContent').classList.add('hidden');
    $('articleResultContent').classList.add('hidden');
    $('loadingTitle').textContent = currentMode === 'article' ? '記事と掲載物件を確認しています' : '画像・動画まで確認しています';
    updateLoadingStepLabels();
    $('loadingState').classList.remove('hidden');
    startLoadingEstimate();
  } else {
    stopLoadingEstimate(preserveResult);
    if (!preserveResult) $('loadingState').classList.add('hidden');
  }
}

function renderResult(data) {
  $('loadingState').classList.add('hidden');
  $('emptyState').classList.add('hidden');
  $('articleResultContent').classList.add('hidden');
  $('resultContent').classList.remove('hidden');
  $('modeBadge').textContent = 'Instagram / 3ソース照合';

  $('propertyName').textContent = data.property?.title || '物件情報';
  $('propertyDesc').textContent = data.property?.description || 'UniLife物件ページ・PDF・Instagram素材を照合しました。';
  const thumb = $('propertyThumb');
  if (data.property?.image) { thumb.style.backgroundImage = `url("${data.property.image.replace(/"/g, '%22')}")`; thumb.textContent = ''; }
  else { thumb.style.backgroundImage = ''; thumb.textContent = 'UniLife'; }
  $('pdfBadge').classList.toggle('muted', !data.sourceInfo?.pdf);
  $('pdfBadge').textContent = data.sourceInfo?.pdf ? '● PDF' : '○ PDF未添付';

  $('matchCount').textContent = data.counts.match || 0;
  $('mismatchCount').textContent = data.counts.mismatch || 0;
  $('reviewCount').textContent = (data.counts.needs_review || 0) + (data.counts.official_conflict || 0) + (data.counts.notation_variation || 0);

  const warnings = data.warnings || [];
  $('warningBox').classList.toggle('hidden', warnings.length === 0);
  $('warningBox').innerHTML = warnings.map(w => `<div>⚠ ${escapeHtml(w)}</div>`).join('');

  const consistency = data.result.web_pdf_consistency;
  const conflict = consistency?.status === '一部不一致';
  $('officialConflict').classList.toggle('hidden', !conflict);
  if (conflict) $('officialConflict').innerHTML = `<strong>WebとPDFにも差があります</strong><p>${escapeHtml(consistency.note)}</p>`;

  const mismatch = data.result.items.filter(i => i.status === 'mismatch');
  const review = data.result.items.filter(i => i.status === 'needs_review' || i.status === 'official_conflict' || i.status === 'notation_variation');
  const match = data.result.items.filter(i => i.status === 'match');
  renderMismatch(mismatch); renderReview(review); renderImageChecks(data.result.image_checks || [], data.result.image_summary || '', data.imageCounts || {}); renderMatch(match);

  $('mediaOverview').textContent = data.result.media_overview || '';
  $('overallNotes').innerHTML = (data.result.overall_notes || []).map(n => `<li>${escapeHtml(n)}</li>`).join('');
}

function renderArticleResult(data) {
  $('loadingState').classList.add('hidden');
  $('emptyState').classList.add('hidden');
  $('resultContent').classList.add('hidden');
  $('articleResultContent').classList.remove('hidden');
  $('modeBadge').textContent = 'Web記事 / 3ソース照合';

  $('articleResultTitle').textContent = data.articleTitle || 'Web記事';
  $('articleResultOverview').textContent = data.overview || '記事・物件ページ・PDFの3ソースを照合しました。';
  $('articleResultLink').href = data.articleUrl;
  $('articlePropertyCount').textContent = data.detectedPropertyCount || data.properties.length || 0;
  $('articleMismatchCount').textContent = data.counts.mismatch || 0;
  $('articleReviewCount').textContent = data.counts.review || 0;

  renderArticleGeneralChecks(data.articleChecks || []);
  renderArticleProperties(data.properties || []);
  $('articleOverallNotes').innerHTML = (data.overallNotes || []).map(note => `<li>${escapeHtml(note)}</li>`).join('');
}

function renderArticleGeneralChecks(items) {
  $('articleGeneralSection').classList.toggle('hidden', items.length === 0);
  $('articleGeneralBadge').textContent = `${items.length}件`;
  $('articleGeneralList').innerHTML = items.map(item => renderArticleComparisonRow(item, '記事全体')).join('');
}

function renderArticleProperties(properties) {
  $('articlePropertiesBadge').textContent = `${properties.length}物件`;
  if (!properties.length) {
    $('articlePropertiesList').innerHTML = '<div class="article-no-property"><strong>記事内の物件詳細リンクを特定できませんでした</strong><p>記事内に /view/ の物件リンクがない、またはAIがリンクを確認できなかった可能性があります。人の確認が必要です。</p></div>';
    return;
  }
  $('articlePropertiesList').innerHTML = properties.map((prop, propIndex) => {
    const items = Array.isArray(prop.items) ? prop.items : [];
    const issues = items.filter(i => i.status !== 'match');
    const matches = items.filter(i => i.status === 'match');
    const mismatchCount = items.filter(i => i.status === 'mismatch').length;
    const reviewCount = items.filter(i => i.status === 'needs_review' || i.status === 'notation_variation' || i.status === 'official_conflict').length;
    const imageChecks = (prop.image_checks || []).filter(i => i.status !== 'not_applicable');
    const safeUrl = isHttpUrl(prop.property_url) ? prop.property_url : '';
    return `<article class="article-property-card">
      <div class="article-property-head">
        <div><span class="property-seq">PROPERTY ${propIndex + 1}</span><h4>${escapeHtml(prop.property_name || `物件${propIndex + 1}`)}</h4><p>${escapeHtml(prop.summary || prop.article_location || '')}</p></div>
        <div class="property-actions"><span class="mini-status warn">要修正 ${mismatchCount}</span><span class="mini-status review">要確認 ${reviewCount}</span>${safeUrl ? `<a href="${escapeAttr(safeUrl)}" target="_blank" rel="noopener">公式ページ ↗</a>` : ''}</div>
      </div>
      ${issues.length ? `<div class="article-property-issues">${issues.map(item => renderArticleComparisonRow(item, '記事')).join('')}</div>` : '<div class="article-property-ok">✓ 記事内で確認した物件情報に明確な差分は見つかりませんでした。</div>'}
      ${imageChecks.length ? `<div class="article-image-checks"><strong>掲載画像の確認</strong>${imageChecks.map(img => renderArticleImageCheck(img)).join('')}</div>` : ''}
      ${matches.length ? `<details class="article-match-details"><summary>一致している項目 ${matches.length}件</summary><div>${matches.map(item => `<span><b>✓ ${escapeHtml(item.label)}</b>記事: ${escapeHtml(item.article_value || '')}<br>Web: ${escapeHtml(item.web_value || '')}<br>PDF: ${escapeHtml(item.pdf_value || '')}</span>`).join('')}</div></details>` : ''}
      ${(prop.notes || []).length ? `<ul class="property-notes">${prop.notes.map(n => `<li>${escapeHtml(n)}</li>`).join('')}</ul>` : ''}
    </article>`;
  }).join('');
  $('articlePropertiesList').querySelectorAll('.copy-btn').forEach(btn => btn.addEventListener('click', () => copyText(btn.dataset.copy, btn)));
}

function renderArticleComparisonRow(item, sourceLabel) {
  const status = item.status || 'needs_review';
  const badge = status === 'mismatch' ? '要修正' : status === 'notation_variation' ? '表記を確認' : status === 'official_conflict' ? '公式情報も要確認' : status === 'match' ? '一致' : '要確認';
  const cls = status === 'mismatch' ? 'mismatch' : status === 'notation_variation' ? 'notation' : status === 'official_conflict' ? 'official-conflict' : status === 'match' ? 'match' : 'review';
  return `<div class="article-check-row ${cls}">
    <div class="article-check-top"><div><strong>${escapeHtml(item.issue_title || item.label || '確認項目')}</strong><small>${escapeHtml(item.location || '')}</small></div><span>${badge}</span></div>
    <div class="article-compare-grid">
      <div class="article-source"><small>${escapeHtml(sourceLabel)}</small><strong>${escapeHtml(item.article_value || '不明')}</strong></div>
      <div><small>物件ページ</small><strong>${escapeHtml(item.web_value || '確認できず')}</strong></div>
      <div class="pdf-source"><small>PDF</small><strong>${escapeHtml(item.pdf_value || '未添付 / 不明')}</strong></div>
    </div>
    <p>${escapeHtml(item.issue || '')}</p>
    ${status === 'mismatch' && item.recommended_value ? `<div class="article-fix"><span><small>修正候補</small><strong>${escapeHtml(item.recommended_value)}</strong></span><button class="copy-btn" type="button" data-copy="${escapeAttr(item.recommended_value)}">コピー</button></div>` : ''}
  </div>`;
}

function renderArticleImageCheck(item) {
  const meta = imageStatusMeta(item.status);
  return `<div class="article-image-row"><div><strong>${escapeHtml(item.article_location || '記事内画像')}</strong><small>${escapeHtml(item.article_description || '')}</small></div><span class="image-status ${meta.className}">${meta.label}</span><p><b>${escapeHtml(item.official_reference || '公式画像')}</b><br>${escapeHtml(item.reason || '')}</p></div>`;
}

function renderMismatch(items) {
  $('mismatchSection').classList.toggle('hidden', items.length === 0);
  $('mismatchBadge').textContent = `${items.length}件`;
  $('mismatchList').innerHTML = items.map((item, idx) => `
    <article class="diff-card">
      <div class="diff-top"><span class="issue-no">${idx + 1}</span><div><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.location || 'Instagram素材')}</small></div><span class="confidence ${item.confidence}">${confidenceText(item.confidence)}</span></div>
      <div class="three-source-grid">
        <div class="source-value sns-value"><small>Instagram</small><strong>${escapeHtml(item.instagram_value || '不明')}</strong></div>
        <div class="source-value"><small>Web</small><strong>${escapeHtml(item.web_value || '不明')}</strong></div>
        <div class="source-value"><small>PDF</small><strong>${escapeHtml(item.pdf_value || '未添付 / 不明')}</strong></div>
      </div>
      <div class="issue-note"><span>!</span><div class="issue-copy"><strong>${escapeHtml(item.issue_title || item.label)}</strong><p>${escapeHtml(item.issue)}</p></div></div>
      <div class="fix-row"><div><small>修正候補</small><strong>${escapeHtml(item.recommended_value || '要確認')}</strong></div><button class="copy-btn" type="button" data-copy="${escapeAttr(item.recommended_value || '')}">コピー</button></div>
    </article>`).join('');
  $('mismatchList').querySelectorAll('.copy-btn').forEach(btn => btn.addEventListener('click', () => copyText(btn.dataset.copy, btn)));
}

function renderReview(items) {
  $('reviewSection').classList.toggle('hidden', items.length === 0);
  $('reviewBadge').textContent = `${items.length}件`;
  $('reviewList').innerHTML = items.map(item => {
    const badge = item.status === 'official_conflict' ? '公式情報も要確認' : item.status === 'notation_variation' ? '表記を確認' : '判定保留';
    const cls = item.status === 'notation_variation' ? 'notation' : item.status === 'official_conflict' ? 'official' : 'pending';
    return `<article class="review-row ${cls}"><div class="review-meta"><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.location || 'Instagram素材')}</small></div><div class="review-copy"><strong>${escapeHtml(item.issue_title || item.label)}</strong><p>${escapeHtml(item.issue)}</p></div><span class="review-status">${badge}</span></article>`;
  }).join('');
}

function renderImageChecks(items, summary, counts) {
  const visible = items.filter(item => item.status !== 'not_applicable');
  $('imageCheckSection').classList.toggle('hidden', visible.length === 0);
  $('imageCheckBadge').textContent = `${visible.length}件`;
  if (!visible.length) return;
  const ok = (counts.same_image || 0) + (counts.same_property_likely || 0);
  const review = counts.needs_review || 0;
  const warn = counts.different_property_likely || 0;
  $('imageCheckSummary').innerHTML = `<p>${escapeHtml(summary || 'Instagram素材内の建物・室内画像を、Web/PDFの公式画像と比較しました。')}</p><div class="image-mini-counts"><span class="ok">✓ 整合 ${ok}</span><span class="review">? 要確認 ${review}</span><span class="warn">! 相違の可能性 ${warn}</span></div>`;
  $('imageCheckList').innerHTML = visible.map((item, idx) => {
    const status = imageStatusMeta(item.status);
    return `<article class="image-check-card ${status.className}"><div class="image-check-top"><span class="image-check-no">${idx + 1}</span><div><strong>${escapeHtml(item.instagram_location || 'Instagram素材')}</strong><small>${escapeHtml(item.instagram_description || '画像')}</small></div><span class="image-status ${status.className}">${status.label}</span></div><div class="image-reference"><small>照合した公式画像</small><strong>${escapeHtml(item.official_source || '見つからない')} ${item.official_reference ? `・${escapeHtml(item.official_reference)}` : ''}</strong></div><div class="image-reason"><strong>${status.heading}</strong><p>${escapeHtml(item.reason || '画像の特徴を比較しました。')}</p></div><div class="image-confidence">AI信頼度：${confidenceText(item.confidence)}</div></article>`;
  }).join('');
}

function imageStatusMeta(status) {
  if (status === 'same_image') return { label: '同じ写真', heading: '同一画像の可能性が高いです', className: 'same-image' };
  if (status === 'same_property_likely') return { label: '同じ物件の可能性 高', heading: '撮影角度は違いますが、同じ物件と考えられます', className: 'same-property' };
  if (status === 'different_property_likely') return { label: '相違の可能性', heading: '別物件の画像である可能性があります', className: 'different' };
  return { label: '人の確認が必要', heading: 'AIだけでは同一物件か判断できません', className: 'needs-review' };
}

function renderMatch(items) {
  $('matchSection').classList.toggle('hidden', items.length === 0);
  $('matchBadge').textContent = `${items.length}件`;
  $('matchList').innerHTML = items.map(item => `<div class="match-item"><strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(item.instagram_value)}</span><small>${escapeHtml(item.location)}</small></div>`).join('');
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const before = btn.textContent; btn.textContent = 'コピー済み ✓'; setTimeout(() => btn.textContent = before, 1200);
  } catch { alert(`コピーしてください：${text}`); }
}

$('helpBtn').addEventListener('click', () => $('helpDialog').showModal());
$('closeHelp').addEventListener('click', () => $('helpDialog').close());

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error(`${file.name} を読み込めませんでした。`));
    reader.readAsDataURL(file);
  });
}

function loadVideoForFrameExtraction(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(file);
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.onloadedmetadata = () => resolve({ video, url });
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`${file.name} の動画を読み込めませんでした。`));
    };
    video.src = url;
  });
}

function seekVideo(video, timeSec) {
  return new Promise((resolve, reject) => {
    const onSeeked = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error('動画フレームの抽出に失敗しました。')); };
    const cleanup = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    };
    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onError, { once: true });
    try {
      video.currentTime = Math.max(0, timeSec);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

function drawVideoIntoCell(ctx, video, x, y, cellWidth, cellHeight) {
  ctx.fillStyle = '#111827';
  ctx.fillRect(x, y, cellWidth, cellHeight);
  const sourceWidth = video.videoWidth || cellWidth;
  const sourceHeight = video.videoHeight || cellHeight;
  const scale = Math.min(cellWidth / sourceWidth, cellHeight / sourceHeight);
  const drawWidth = Math.round(sourceWidth * scale);
  const drawHeight = Math.round(sourceHeight * scale);
  const drawX = x + Math.round((cellWidth - drawWidth) / 2);
  const drawY = y + Math.round((cellHeight - drawHeight) / 2);
  ctx.drawImage(video, drawX, drawY, drawWidth, drawHeight);
  ctx.strokeStyle = 'rgba(255,255,255,.22)';
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 1, y + 1, cellWidth - 2, cellHeight - 2);
}

function drawFrameLabel(ctx, label, x, y) {
  ctx.fillStyle = 'rgba(15,23,42,.82)';
  ctx.fillRect(x + 8, y + 8, 78, 28);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 17px Arial, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x + 16, y + 22);
}

function canvasToBase64(canvas, quality = 0.86) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (!blob) return reject(new Error('動画フレーム画像の生成に失敗しました。'));
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(new Error('動画フレーム画像を読み込めませんでした。'));
      reader.readAsDataURL(blob);
    }, 'image/jpeg', quality);
  });
}

function formatVideoTime(totalSeconds) {
  const value = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(value / 60);
  const seconds = value % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function getVideoDuration(file) {
  return new Promise(resolve => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(file);
    const finish = value => { URL.revokeObjectURL(url); resolve(value); };
    video.preload = 'metadata';
    video.onloadedmetadata = () => finish(Number.isFinite(video.duration) ? video.duration : 0);
    video.onerror = () => finish(0);
    video.src = url;
  });
}

function normalizedMime(file, kind = '') {
  if (file?.type) return file.type === 'video/mov' ? 'video/quicktime' : file.type;
  const name = (file?.name || '').toLowerCase();
  if (kind === 'document' || name.endsWith('.pdf')) return 'application/pdf';
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.webp')) return 'image/webp';
  if (name.endsWith('.mov')) return 'video/quicktime';
  if (name.endsWith('.webm')) return 'video/webm';
  if (name.endsWith('.mp4')) return 'video/mp4';
  return kind === 'image' ? 'image/jpeg' : 'application/octet-stream';
}

function readCache(key) {
  try {
    const raw = localStorage.getItem(key); if (!raw) return null;
    const parsed = JSON.parse(raw); if (!parsed?.expiresAt || parsed.expiresAt < Date.now()) { localStorage.removeItem(key); return null; }
    return parsed.value;
  } catch { return null; }
}
function writeCache(key, value, ttlMs) {
  try { localStorage.setItem(key, JSON.stringify({ expiresAt: Date.now() + ttlMs, value })); } catch {}
}
function normalizeUrlForCompare(value) {
  try {
    const u = new URL(value);
    u.hash = '';
    u.search = '';
    return u.href.replace(/\/$/, '');
  } catch { return String(value || '').replace(/\/$/, ''); }
}
function isUnilifePropertyUrl(value) {
  try {
    const u = new URL(value);
    const h = u.hostname.toLowerCase();
    return (h === 'unilife.co.jp' || h.endsWith('.unilife.co.jp')) && /^\/view\/\d+\/?$/.test(u.pathname);
  } catch { return false; }
}
function isUnilifeUrl(value) {
  try { const h = new URL(value).hostname.toLowerCase(); return h === 'unilife.co.jp' || h.endsWith('.unilife.co.jp'); } catch { return false; }
}
function isHttpUrl(value) { try { const u = new URL(value); return u.protocol === 'https:' || u.protocol === 'http:'; } catch { return false; } }
function toAbsoluteUrl(value, base) { if (!value) return ''; try { return new URL(value, base).href; } catch { return ''; } }
function normalizeText(v='') { return String(v).replace(/\u00a0/g,' ').replace(/[\t\r]+/g,' ').replace(/\n{3,}/g,'\n\n').replace(/ {2,}/g,' ').trim(); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function formatBytes(bytes) { if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`; if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`; return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`; }
function confidenceText(v) { return v === 'high' ? '高信頼' : v === 'medium' ? '中信頼' : '要確認'; }
function escapeHtml(v='') { return String(v).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function escapeAttr(v='') { return escapeHtml(v).replace(/`/g, '&#96;'); }

init();
