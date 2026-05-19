#!/usr/bin/env node
'use strict';

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

// ── Config ────────────────────────────────────────────────────────────────────
const BASE_API  = 'https://ngoaidao.com/api';
const BASE_SITE = 'https://ngoaidao.com';
const OUT_DIR   = path.join(__dirname, 'audio');
const LOG_FILE  = path.join(__dirname, 'fetch.log');

const EMAIL    = process.env.NGOAIDAO_EMAIL    || '';
const PASSWORD = process.env.NGOAIDAO_PASSWORD || '';

// Concurrency tuning
const STORY_CONCURRENCY   = 4;   // stories processed in parallel
const EPISODE_CONCURRENCY = 6;   // episodes downloaded in parallel per story
const RETRY_DELAY_MS      = 300; // retry backoff (was 1200)

// ── Globals ───────────────────────────────────────────────────────────────────
let sessionCookie = '';
let csrfToken     = '';
let bearerToken   = '';
const logStream   = fs.createWriteStream(LOG_FILE, { flags: 'w' });

// ── Helpers ───────────────────────────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toTimeString().slice(0, 8)}] ${msg}`;
  console.log(line);
  logStream.write(line + '\n');
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function sanitizeName(name) {
  return String(name)
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 100);
}

// Run tasks with limited concurrency
async function pLimit(tasks, concurrency) {
  const results = new Array(tasks.length);
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ── HTTP request ──────────────────────────────────────────────────────────────
function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const proto = options.protocol === 'http:' ? http : https;
    const defaultHeaders = {
      'User-Agent'      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
      'Accept'          : 'application/json, text/plain, */*',
      'Accept-Language' : 'vi-VN,vi;q=0.9,en-US;q=0.8',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer'         : BASE_SITE + '/',
      'Origin'          : BASE_SITE,
      'Connection'      : 'keep-alive',
    };
    if (bearerToken)   defaultHeaders['Authorization'] = `Bearer ${bearerToken}`;
    if (sessionCookie) defaultHeaders['Cookie'] = sessionCookie;
    if (csrfToken)     defaultHeaders['X-XSRF-TOKEN'] = csrfToken;

    const opts = { ...options, headers: { ...defaultHeaders, ...(options.headers || {}) } };
    const req = proto.request(opts, (res) => {
      const setCookie = res.headers['set-cookie'];
      if (setCookie) {
        const cookies = setCookie.map(c => c.split(';')[0]);
        sessionCookie = cookies.join('; ');
        const xsrf = cookies.find(c => c.startsWith('XSRF-TOKEN='));
        if (xsrf) csrfToken = decodeURIComponent(xsrf.split('=')[1]);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function apiGet(endpoint, params = {}) {
  const qs = Object.keys(params).length
    ? '?' + Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
    : '';
  const u = new URL(BASE_API + endpoint + qs);
  const res = await request({ protocol: 'https:', hostname: u.hostname, path: u.pathname + u.search, method: 'GET' });
  try { return JSON.parse(res.body.toString()); }
  catch (e) { return { success: false, _raw: res.body.toString().slice(0, 300) }; }
}

async function apiPost(endpoint, data) {
  const body = JSON.stringify(data);
  const u = new URL(BASE_API + endpoint);
  const res = await request({
    protocol: 'https:', hostname: u.hostname, path: u.pathname, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, body);
  try { return JSON.parse(res.body.toString()); }
  catch (e) { return { success: false, _raw: res.body.toString().slice(0, 300) }; }
}

// ── Download ──────────────────────────────────────────────────────────────────
function _downloadOnce(fileUrl, destPath, referer) {
  return new Promise((resolve, reject) => {
    const follow = (currentUrl, hops = 0) => {
      if (hops > 8) return reject(new Error('Too many redirects'));
      const parsed = new URL(currentUrl);
      const proto  = parsed.protocol === 'http:' ? http : https;
      const opts   = {
        hostname: parsed.hostname,
        path    : parsed.pathname + parsed.search,
        method  : 'GET',
        headers : {
          'User-Agent' : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0',
          'Referer'    : referer || BASE_SITE + '/',
          'Accept'     : 'audio/mpeg,audio/*;q=0.9,*/*;q=0.8',
          'Connection' : 'keep-alive',
        },
      };
      if (sessionCookie) opts.headers['Cookie'] = sessionCookie;
      if (bearerToken)   opts.headers['Authorization'] = `Bearer ${bearerToken}`;

      proto.get(opts, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          return follow(new URL(res.headers.location, currentUrl).href, hops + 1);
        }
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const stream = fs.createWriteStream(destPath);
        res.pipe(stream);
        stream.on('finish', resolve);
        stream.on('error', reject);
      }).on('error', reject);
    };
    follow(fileUrl);
  });
}

async function downloadFile(fileUrl, destPath, referer) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await _downloadOnce(fileUrl, destPath, referer);
      const stat = fs.statSync(destPath);
      if (stat.size > 3000) return true;
      fs.unlinkSync(destPath);
      log(`    Thử ${attempt}: file quá nhỏ (${stat.size} B)`);
    } catch (e) {
      log(`    Thử ${attempt}: ${e.message}`);
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
    }
    if (attempt < 3) await sleep(attempt * RETRY_DELAY_MS);
  }
  return false;
}

// ── Auth ──────────────────────────────────────────────────────────────────────
async function login() {
  if (!EMAIL || !PASSWORD) {
    log('Chế độ miễn phí (không có thông tin đăng nhập).');
    return false;
  }
  log(`Đăng nhập: ${EMAIL}`);
  const homeRes = await request({ protocol: 'https:', hostname: 'ngoaidao.com', path: '/', method: 'GET', headers: { Accept: 'text/html' } });
  const meta = homeRes.body.toString().match(/name="csrf-token"\s+content="([^"]+)"/);
  if (meta) csrfToken = meta[1];

  const res = await apiPost('/auth/login', { email: EMAIL, password: PASSWORD });
  if (res.success) {
    const token = res.data?.access_token || res.data?.token;
    if (token) { bearerToken = token; csrfToken = ''; log(`  Token: ${token.slice(0, 14)}…`); }
    log('Đăng nhập thành công!');
    return true;
  }
  log(`Đăng nhập thất bại: ${res.message || ''}`);
  return false;
}

// ── Fetch ALL library pages in parallel ───────────────────────────────────────
async function fetchAllLibraryStories() {
  log('--- Lấy danh sách truyện ---');

  // Fetch page 1 to get total pages
  const first = await apiGet('/stories', { page: 1, per_page: 50 });
  const items1 = first.data?.data || first.data?.stories || first.data?.items || (Array.isArray(first.data) ? first.data : []);
  const lastPage = first.data?.last_page || first.data?.meta?.last_page || 1;

  log(`  Tổng trang: ${lastPage}`);

  const allStories = [];
  const addItems = (items) => {
    for (const item of items) {
      allStories.push({ id: item.id, slug: item.slug, title: item.title || item.name || `story_${item.id}` });
    }
  };
  addItems(items1);

  if (lastPage > 1) {
    // Fetch all remaining pages in parallel
    const pageTasks = [];
    for (let p = 2; p <= lastPage; p++) {
      const page = p;
      pageTasks.push(() => apiGet('/stories', { page, per_page: 50 }));
    }
    const pageResults = await pLimit(pageTasks, 10);
    for (const res of pageResults) {
      const items = res.data?.data || res.data?.stories || res.data?.items || (Array.isArray(res.data) ? res.data : []);
      addItems(items);
    }
  }

  if (allStories.length === 0) {
    log('  API rỗng — thử scrape HTML…');
    return scrapeLibraryHtml();
  }

  log(`Tổng truyện: ${allStories.length}`);
  return allStories;
}

// ── Fallback HTML scrape ───────────────────────────────────────────────────────
async function scrapeLibraryHtml() {
  const stories = [];
  const slugSet = new Set();
  let page = 1;
  while (true) {
    const pageUrl = page === 1 ? '/library' : `/library?page=${page}`;
    const res = await request({ protocol: 'https:', hostname: 'ngoaidao.com', path: pageUrl, method: 'GET', headers: { Accept: 'text/html' } });
    const html = res.body.toString();
    const re = /href="https?:\/\/ngoaidao\.com\/(?:truyen|audio|series|tap)\/([a-z0-9\-]+)"/gi;
    let m;
    let found = 0;
    while ((m = re.exec(html)) !== null) {
      if (!slugSet.has(m[1])) { slugSet.add(m[1]); stories.push({ id: null, slug: m[1], title: m[1] }); found++; }
    }
    const hasNext = new RegExp(`page=${page + 1}`).test(html);
    if (!hasNext || found === 0) break;
    page++;
  }
  return stories;
}

// ── Resolve R2 stream URL ─────────────────────────────────────────────────────
async function resolveStreamUrl(ep, tapNum, r2BaseUrl, firstStreamUrl) {
  const streamRes = await apiGet(`/episodes/${ep.id}/stream`);
  if (streamRes.success && streamRes.data?.stream_url) return streamRes.data.stream_url;

  if (r2BaseUrl) {
    const extMatch = firstStreamUrl?.match(/tap-\d+(\.[a-z0-9]+)/i);
    return `${r2BaseUrl}/tap-${tapNum}${extMatch ? extMatch[1] : '.mp3'}`;
  }
  return '';
}

function buildR2AltUrls(r2BaseUrl, firstStreamUrl, tapNum, epSlug) {
  if (!r2BaseUrl) return [];
  const padded   = String(tapNum).padStart(3, '0');
  const exts     = ['mp3', 'm4a', 'aac', 'ogg'];
  const patterns = [`tap-${tapNum}`, `tap-${padded}`, `chapter-${tapNum}`, `ep-${tapNum}`, epSlug].filter(Boolean);
  return patterns.flatMap(pat => exts.map(ext => `${r2BaseUrl}/${pat}.${ext}`));
}

// ── Process one episode ───────────────────────────────────────────────────────
async function processEpisode(ep, i, total, story, storyDir, r2BaseUrl, firstStreamUrl) {
  const tapNum = ep.episode_order || ep.order || (i + 1);
  const num    = String(tapNum).padStart(4, '0');
  const label  = ep.title || ep.name || `Tập ${tapNum}`;

  let streamUrl = '';
  try { streamUrl = await resolveStreamUrl(ep, tapNum, r2BaseUrl, firstStreamUrl); }
  catch (e) { log(`  [${num}] ERR resolve: ${e.message}`); }

  if (!streamUrl) { log(`  [${num}] ERR: không có URL`); return 'skip'; }

  const urlFile  = streamUrl.split('?')[0].split('/').pop();
  const extMatch = urlFile.match(/\.([a-z0-9]+)$/i);
  const ext      = extMatch ? extMatch[1].toLowerCase() : 'mp3';
  const safeName = sanitizeName(label) || urlFile.replace(/\.[^.]+$/, '');
  const filename = `${num}_${safeName}.${ext}`;
  const destPath = path.join(storyDir, filename);

  if (fs.existsSync(destPath) && fs.statSync(destPath).size > 3000) {
    log(`  [${num}/${total}] Đã có — ${filename}`);
    return 'exists';
  }

  log(`  [${num}/${total}] ${label}`);
  const referer = `${BASE_SITE}/tap/${story.slug}/tap-${tapNum}`;
  let ok = await downloadFile(streamUrl, destPath, referer);

  if (!ok) {
    const alts = buildR2AltUrls(r2BaseUrl, firstStreamUrl, tapNum, ep.slug);
    for (const alt of alts) {
      ok = await downloadFile(alt, destPath, referer);
      if (ok) break;
    }
  }

  if (ok) {
    const kb = Math.round(fs.statSync(destPath).size / 1024);
    log(`  [${num}/${total}] OK ${kb} KB → ${filename}`);
    return 'ok';
  }
  log(`  [${num}/${total}] ERR: thất bại`);
  return 'skip';
}

// ── Process one story ─────────────────────────────────────────────────────────
async function processStory(story) {
  log(`\n══ ${story.title}`);

  const storyRes = await apiGet(`/stories/${story.slug}`);
  if (!storyRes.success || !storyRes.data) {
    log(`  ERR: không lấy được — ${JSON.stringify(storyRes).slice(0, 120)}`);
    return { total: 0, downloaded: 0, skipped: 0 };
  }

  const storyData = storyRes.data;
  const episodes  = storyData.episodes || storyData.chapters || [];
  if (episodes.length === 0) { log('  Không có tập.'); return { total: 0, downloaded: 0, skipped: 0 }; }

  log(`  ${episodes.length} tập`);

  const folderName = sanitizeName(storyData.title || story.title || story.slug);
  const storyDir   = path.join(OUT_DIR, folderName);
  if (!fs.existsSync(storyDir)) fs.mkdirSync(storyDir, { recursive: true });

  // Discover R2 base in parallel with no extra delay
  let r2BaseUrl = '', firstStreamUrl = '';
  const firstRes = await apiGet(`/episodes/${episodes[0].id}/stream`);
  if (firstRes.success && firstRes.data?.stream_url) {
    firstStreamUrl = firstRes.data.stream_url;
    r2BaseUrl = firstStreamUrl.replace(/\/tap-\d+(\.[a-z0-9]+)?(\?.*)?$/i, '');
    if (r2BaseUrl === firstStreamUrl) r2BaseUrl = firstStreamUrl.replace(/\/[^/]+(\.[a-z0-9]+)?(\?.*)?$/i, '');
    log(`  R2: ${r2BaseUrl}`);
  }

  // Download all episodes with concurrency
  const tasks = episodes.map((ep, i) => () =>
    processEpisode(ep, i, episodes.length, story, storyDir, r2BaseUrl, firstStreamUrl)
  );
  const results = await pLimit(tasks, EPISODE_CONCURRENCY);

  const downloaded = results.filter(r => r === 'ok' || r === 'exists').length;
  const skipped    = results.filter(r => r === 'skip').length;
  return { total: episodes.length, downloaded, skipped };
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  log('=== NGOAIDAO FULL LIBRARY DOWNLOADER (FAST) ===');
  log(`Thư mục: ${OUT_DIR} | Truyện song song: ${STORY_CONCURRENCY} | Tập song song: ${EPISODE_CONCURRENCY}`);

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  await login();

  const allStories = await fetchAllLibraryStories();
  if (allStories.length === 0) { log('ERR: Không tìm thấy truyện.'); process.exit(1); }

  let grandTotal = 0, grandDownloaded = 0, grandSkipped = 0;
  const failed = [];
  let done = 0;

  const storyTasks = allStories.map((story, i) => async () => {
    log(`\n[${i + 1}/${allStories.length}] ${story.title}`);
    try {
      const { total, downloaded, skipped } = await processStory(story);
      grandTotal      += total;
      grandDownloaded += downloaded;
      grandSkipped    += skipped;
      if (downloaded === 0 && skipped > 0) failed.push(story.title);
    } catch (e) {
      log(`  FATAL: ${e.message}`);
      failed.push(story.title);
    }
    done++;
    log(`  [${done}/${allStories.length} truyện xong]`);
  });

  await pLimit(storyTasks, STORY_CONCURRENCY);

  log('\n╔══════════════════════════════╗');
  log('║        HOÀN THÀNH            ║');
  log('╚══════════════════════════════╝');
  log(`Truyện          : ${allStories.length}`);
  log(`Tổng tập        : ${grandTotal}`);
  log(`Tải thành công  : ${grandDownloaded}`);
  log(`Lỗi/Bỏ qua     : ${grandSkipped}`);
  log(`Thư mục         : ${OUT_DIR}`);
  if (failed.length > 0) {
    log(`\nThất bại (${failed.length}):`);
    failed.forEach(t => log(`  - ${t}`));
  }
  logStream.end();
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
