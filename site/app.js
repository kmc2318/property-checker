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
  $('modeBadge').textContent = 'GitHub Pages / Gemini';
}

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

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = propertyUrl.value.trim();
  const instagramUrl = $('instagramUrl').value.trim();
  if (!url) return alert('UniLifeの物件ページURLを入力してください。');
  if (!isUnilifeUrl(url)) return alert('UniLifeの物件詳細ページURLを入力してください。');
  if (!selectedMedia.length && !instagramUrl) return alert('Instagramへ投稿予定の画像または動画を追加してください。');
  if (!ensureApiKey()) return;

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
        mediaContents.push({ type: 'text', text: `【Instagram投稿予定 動画${videoIndex}: ${file.name}】長さ ${duration ? duration.toFixed(1) : '?'}秒。画面内の文字と音声の両方を確認し、修正箇所はタイムスタンプで示してください。` });
        mediaContents.push(await videoToGeminiContent(file, duration));
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
    handlePossibleRateLimit(error);
    $('loadingState').classList.add('hidden');
    $('emptyState').classList.remove('hidden');
    $('emptyState').innerHTML = `<div class="empty-graphic error">!</div><h3>チェックできませんでした</h3><p>${escapeHtml(humanizeError(error))}</p>`;
  } finally {
    setLoading(false, true);
  }
});

async function buildAnalysisInput({ page, propertyUrl, instagramUrl, document, pdfContent, mediaContents }) {
  const input = [];
  input.push({
    type: 'text',
    text: `あなたはUniLifeの不動産広告・SNSクリエイティブ校正アシスタントです。
公式Webページと物件詳細PDFを一次情報として、Instagramへ投稿予定の画像・動画内に表示・発話されている物件情報を照合してください。

【公式WebページURL】
${propertyUrl}
URL Contextツールを必ず使い、このURLの現在の公開情報を一次情報として確認してください。
${page?.text ? `\nブラウザ側でも取得できた補助テキスト:\n${page.text.slice(0, 45000)}` : ''}
${page?.title ? `\nページタイトル: ${page.title}` : ''}
${page?.description ? `\nページ説明: ${page.description}` : ''}

${instagramUrl ? `【Instagram投稿URL】\n${instagramUrl}\n公開状態で取得可能ならURL Contextでも確認してください。取得できない場合はアップロード素材を優先してください。` : ''}

重要ルール:
- 画像内の文字、動画の画面内文字・図表、動画音声の発話を確認する。
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
- location には「画像2」「動画 00:06」「動画音声」など、修正箇所を探しやすい位置を書く。
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

async function videoToGeminiContent(file, duration) {
  const uploaded = await uploadFileToGemini(file);
  const processing = duration > 180
    ? { type: 'agentic' }
    : { type: 'static', fps: duration > 60 ? 0.5 : 1 };
  return { type: 'video', uri: uploaded.uri, mime_type: uploaded.mime_type || normalizedMime(file, 'video'), processing };
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
      'Content-Type': 'application/json',
      'Api-Revision': '2026-05-20'
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
      submitBtn.disabled = false; submitLabel.textContent = '3つの情報をAIで照合';
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
  submitLabel.textContent = on ? 'チェック中…' : (cooldownTimer ? submitLabel.textContent : '3つの情報をAIで照合');
  if (on) {
    $('emptyState').classList.add('hidden');
    $('resultContent').classList.add('hidden');
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
  $('resultContent').classList.remove('hidden');

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
