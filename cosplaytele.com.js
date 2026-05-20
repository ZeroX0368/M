#!/usr/bin/env node
'use strict';

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

// ── Config ────────────────────────────────────────────────────────────────────
const TARGET_URL = process.env.TARGET_URL || 'https://cosplaytele.com';
const OUT_DIR    = path.join(__dirname, 'images_output');
const LOG_FILE   = path.join(__dirname, 'fetch.log');
const MAX_PAGES  = parseInt(process.env.MAX_PAGES || '50', 10);
const DELAY_MS   = parseInt(process.env.DELAY_MS  || '500', 10);

// ── State ─────────────────────────────────────────────────────────────────────
const visitedPosts  = new Set();
const seenImages    = new Set();
let   imageCounter  = 0;
let   totalDownloaded = 0;
let   totalFailed     = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toTimeString().slice(0, 8)}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function request(reqUrl, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const follow = (currentUrl, hops) => {
      if (hops > 5) return reject(new Error('Too many redirects'));
      const parsed = url.parse(currentUrl);
      const proto  = parsed.protocol === 'http:' ? http : https;
      const opts   = {
        hostname : parsed.hostname,
        port     : parsed.port,
        path     : parsed.path || '/',
        method   : 'GET',
        headers  : {
          'User-Agent'      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
          'Accept'          : 'text/html,application/xhtml+xml,*/*;q=0.8',
          'Accept-Language' : 'en-US,en;q=0.9',
          'Accept-Encoding' : 'identity',
          'Connection'      : 'keep-alive',
          ...extraHeaders,
        },
      };
      proto.request(opts, (res) => {
        if (res.statusCode >= 301 && res.statusCode <= 308 && res.headers.location) {
          res.resume();
          return follow(url.resolve(currentUrl, res.headers.location), hops + 1);
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({
          statusCode : res.statusCode,
          headers    : res.headers,
          body       : Buffer.concat(chunks).toString('utf8'),
          url        : currentUrl,
        }));
      }).on('error', reject).end();
    };
    follow(reqUrl, 0);
  });
}

function downloadImage(imgUrl, destPath, referer) {
  return new Promise((resolve, reject) => {
    const follow = (currentUrl, hops) => {
      if (hops > 5) return reject(new Error('Too many redirects'));
      const parsed = url.parse(currentUrl);
      const proto  = parsed.protocol === 'http:' ? http : https;
      const opts   = {
        hostname : parsed.hostname,
        port     : parsed.port,
        path     : parsed.path || '/',
        method   : 'GET',
        headers  : {
          'User-Agent' : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0',
          'Referer'    : referer || TARGET_URL,
          'Accept'     : 'image/webp,image/apng,image/*,*/*;q=0.8',
        },
      };
      proto.request(opts, (res) => {
        if (res.statusCode >= 301 && res.statusCode <= 308 && res.headers.location) {
          res.resume();
          return follow(url.resolve(currentUrl, res.headers.location), hops + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const stream = fs.createWriteStream(destPath);
        res.pipe(stream);
        stream.on('finish', resolve);
        stream.on('error', reject);
      }).on('error', reject).end();
    };
    follow(imgUrl, 0);
  });
}

// ── Parsing ───────────────────────────────────────────────────────────────────
function isImageUrl(src) {
  if (!src || src.startsWith('data:')) return false;
  return /\.(jpe?g|png|webp|gif|bmp|tiff?)(\?|$)/i.test(src);
}

function resolveUrl(src, base, pageUrl) {
  if (/^https?:\/\//i.test(src)) return src;
  if (src.startsWith('//')) return 'https:' + src;
  if (src.startsWith('/')) return base + src;
  return url.resolve(pageUrl, src);
}

function extractImages(html, pageUrl) {
  const images = new Set();
  const base   = new url.URL(pageUrl).origin;
  let m;

  const imgRegex = /<img[^>]+(?:src|data-src|data-lazy-src|data-original)\s*=\s*["']([^"']+)["'][^>]*>/gi;
  while ((m = imgRegex.exec(html)) !== null) {
    const src = m[1].trim();
    if (isImageUrl(src)) images.add(resolveUrl(src, base, pageUrl));
  }

  const srcsetRegex = /srcset\s*=\s*["']([^"']+)["']/gi;
  while ((m = srcsetRegex.exec(html)) !== null) {
    m[1].split(',').forEach(part => {
      const src = part.trim().split(/\s+/)[0];
      if (src && isImageUrl(src)) images.add(resolveUrl(src, base, pageUrl));
    });
  }

  const directRegex = /https?:\/\/[^\s"'<>()]+\.(?:jpe?g|png|webp|gif)(?:\?[^\s"'<>()]*)?/gi;
  while ((m = directRegex.exec(html)) !== null) {
    if (isImageUrl(m[0])) images.add(m[0]);
  }

  const bgRegex = /background(?:-image)?\s*:\s*url\(\s*["']?([^"')]+)["']?\s*\)/gi;
  while ((m = bgRegex.exec(html)) !== null) {
    const src = m[1].trim();
    if (isImageUrl(src)) images.add(resolveUrl(src, base, pageUrl));
  }

  return [...images];
}

function extractNextPage(html, pageUrl) {
  const base = new url.URL(pageUrl).origin;
  const patterns = [
    /rel=["']next["'][^>]*href=["']([^"']+)["']/i,
    /href=["']([^"']+)["'][^>]*rel=["']next["']/i,
    /<a[^>]+class=["'][^"']*next[^"']*["'][^>]*href=["']([^"']+)["']/i,
    /<a[^>]+href=["']([^"']+)["'][^>]*class=["'][^"']*next[^"']*["']/i,
    /<link[^>]+rel=["']next["'][^>]*href=["']([^"']+)["']/i,
  ];
  for (const pat of patterns) {
    const m = html.match(pat);
    if (m && m[1]) return resolveUrl(m[1].trim(), base, pageUrl);
  }
  return null;
}

function extractPostLinks(html, pageUrl) {
  const links  = new Set();
  const base   = new url.URL(pageUrl).origin;
  const origin = new url.URL(pageUrl).hostname;
  const aRegex = /<a[^>]+href=["']([^"'#]+)["'][^>]*>/gi;
  let m;
  while ((m = aRegex.exec(html)) !== null) {
    const resolved = resolveUrl(m[1].trim(), base, pageUrl);
    try {
      const parsed = new url.URL(resolved);
      if (
        parsed.hostname === origin &&
        resolved !== pageUrl &&
        !resolved.endsWith('.xml') &&
        !resolved.endsWith('.json') &&
        !isImageUrl(resolved) &&
        parsed.pathname.length > 1
      ) {
        links.add(resolved);
      }
    } catch (_) {}
  }
  return [...links];
}

// ── Save one image to disk ────────────────────────────────────────────────────
function safeFilename(name, maxLen = 80) {
  return name
    .replace(/https?:\/\/[^/]+/i, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, maxLen) || 'image';
}

async function saveImage(imgUrl, referer) {
  if (seenImages.has(imgUrl)) return;
  seenImages.add(imgUrl);

  imageCounter++;
  const num      = String(imageCounter).padStart(5, '0');
  const extMatch = imgUrl.match(/\.(jpe?g|png|webp|gif|bmp|tiff?)(\?|$)/i);
  const ext      = extMatch ? extMatch[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
  const urlPath  = url.parse(imgUrl).pathname || '';
  const basename = path.basename(urlPath, path.extname(urlPath));
  const filename = `${num}_${safeFilename(basename)}.${ext}`;
  const destPath = path.join(OUT_DIR, filename);

  if (fs.existsSync(destPath) && fs.statSync(destPath).size > 1000) {
    log(`  [skip] ${filename}`);
    totalDownloaded++;
    return;
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await downloadImage(imgUrl, destPath, referer);
      const size = fs.statSync(destPath).size;
      if (size < 500) {
        fs.unlinkSync(destPath);
        log(`  [tiny] ${filename} (${size}B)`);
        totalFailed++;
        return;
      }
      log(`  [OK]   ${filename} — ${Math.round(size / 1024)} KB`);
      totalDownloaded++;
      return;
    } catch (e) {
      log(`  [err]  attempt ${attempt}: ${e.message}`);
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
      await sleep(attempt * 800);
    }
  }
  totalFailed++;
}

// ── Scrape a post page and immediately download its images ────────────────────
async function processPostPage(postUrl) {
  if (visitedPosts.has(postUrl)) return;
  visitedPosts.add(postUrl);

  let res;
  try {
    res = await request(postUrl);
  } catch (e) {
    log(`  [post-err] ${postUrl}: ${e.message}`);
    return;
  }
  if (res.statusCode !== 200) return;

  const imgs = extractImages(res.body, res.url);
  if (imgs.length === 0) return;

  log(`  → ${imgs.length} images — downloading now…`);
  for (const img of imgs) {
    await saveImage(img, postUrl);
    await sleep(DELAY_MS);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  fs.writeFileSync(LOG_FILE, '');
  log('=== Cosplaytele.com Image Fetcher ===');
  log(`Target : ${TARGET_URL}`);
  log(`Output : ${OUT_DIR}`);
  log('(Downloads start immediately as each page is crawled)\n');

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  let currentUrl = TARGET_URL;

  for (let page = 1; page <= MAX_PAGES; page++) {
    log(`\n══ Listing page ${page}: ${currentUrl}`);

    let res;
    try {
      res = await request(currentUrl);
    } catch (e) {
      log(`ERR: ${e.message}`);
      break;
    }
    if (res.statusCode !== 200) {
      log(`HTTP ${res.statusCode} — stopping.`);
      break;
    }

    // Collect post links found on this listing page
    const postLinks = extractPostLinks(res.body, res.url);
    const newPosts  = postLinks.filter(l => !visitedPosts.has(l));
    log(`  Found ${newPosts.length} new post pages on this listing page`);

    // Scrape and download each post page immediately — no waiting for next listing page
    for (let i = 0; i < newPosts.length; i++) {
      const postUrl = newPosts[i];
      log(`\n  [post ${i + 1}/${newPosts.length}] ${postUrl}`);
      await processPostPage(postUrl);
      await sleep(DELAY_MS);
    }

    log(`\n  Running totals — downloaded: ${totalDownloaded}  failed: ${totalFailed}  images seen: ${seenImages.size}`);

    // Advance to next listing page
    const next = extractNextPage(res.body, res.url);
    if (!next || next === currentUrl) {
      log('\nNo next listing page — done.');
      break;
    }
    currentUrl = next;
    await sleep(DELAY_MS);
  }

  log('\n=== FINISHED ===');
  log(`Total images found   : ${seenImages.size}`);
  log(`Downloaded OK        : ${totalDownloaded}`);
  log(`Failed / Skipped     : ${totalFailed}`);
  log(`Saved to             : ${OUT_DIR}`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
