#!/usr/bin/env node
/**
 * Signal50 Outlier Scout — real creator baselines, two sources:
 *
 *  A) HarvestAPI (PRIMARY when HARVEST_API_KEY is set) — up to ~100 posts per creator incl. reposts.
 *     GET https://api.harvestapi.io/linkedin/profile-posts?profile=<handle>&page=N   (header X-API-Key)
 *  B) Public LinkedIn pages (FALLBACK, no login) — https://www.linkedin.com/in/<handle>/recent-activity/all/
 *     exposes only the last ~9 posts and LinkedIn returns HTTP 999 after ~5–10 guest pages per IP,
 *     so this path is capped per run (--public-max, default 5) and never used for the full watchlist.
 *
 * Rarity model (robust statistics, per creator):
 *   weighted  = reactions + 3 × comments × ctaFactor + 5 × reposts   (ctaFactor = 0.34 when the post is comment-gated:
 *                                                                     "Comment 'BOT'", "comment X below", "DM me" ...)
 *   median    = median(weighted of this creator's MATURE own posts, age ≥ 24h)
 *   MAD       = median(|weighted − median|), floored at 10% of median
 *   mult      = weighted / median                         gate ≥ 3.0x
 *   z_robust  = (weighted − median) / (1.4826 × MAD)       gate ≥ 2.5
 *   OUTLIER   = mult ≥ 3.0 && z ≥ 2.5 && n ≥ 4            WATCH = mult ≥ 1.5
 *   type      = 'announcement' (book/job/launch/award — not reusable) | 'playbook' (reusable idea)
 *
 * Reposts are only available via HarvestAPI (public pages omit them → term is 0 there).
 * Posts younger than 24h are scored against the baseline but never included in it.
 *
 * Usage:  HARVEST_API_KEY=… node scout/scout.mjs [--only h1,h2] [--delay-ms 2500] [--public-max 5] [--out data/outliers.json]
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : []).filter(Boolean));
const OUT = path.resolve(ROOT, args.out || 'data/outliers.json');
const DELAY = Number(args['delay-ms'] || 2500);
const PUBLIC_MAX = Number(args['public-max'] ?? 5);
const ONLY = args.only ? String(args.only).split(',').map(s => s.trim()) : null;
const HARVEST_KEY = process.env.HARVEST_API_KEY || '';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const GATES = { mult: 3.0, z: 2.5, watch: 1.5, minN: 4 };
const CTA_RE = /\b(comment|type|drop|reply)\s+["“'‘]?[A-Z0-9][\w\-]*["”'’]?\s*(below|to get|and i'?ll|for)|dm\s+me|link in (the )?comments?|comment\s+["“']?\w+["”']?\s*$/im;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const decode = s => s.replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
const median = a => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : 0; };

/** LinkedIn activity IDs are Snowflake-style: the top 41 bits are a Unix ms timestamp (id >> 22). Works on every page variant. */
function postedAt(id) {
  try { return new Date(Number(BigInt(id) >> 22n)); } catch { return null; }
}

async function fetchActivity(handle) {
  // Guests get one of two variants: the activity feed itself, or a 302 to the profile page (which embeds the same ~9 posts).
  const url = `https://www.linkedin.com/in/${handle}/recent-activity/all/`;
  const MAX = 5;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', accept: 'text/html,application/xhtml+xml' }, redirect: 'follow' });
      const html = await res.text();
      const walled = res.status === 999 || res.status === 429 || /\/authwall|checkpoint\/challenge|\/uas\/login/.test(res.url) || (html.length < 40000 && /authwall|Sign in to LinkedIn/i.test(html));
      if (res.status === 404) return { status: 'not_found', html: '' };
      if (!walled && res.status === 200 && html.includes('data-num-reactions')) return { status: 'ok', html, finalUrl: res.url, variant: /recent-activity/.test(res.url) ? 'activity' : 'profile' };
      if (!walled && res.status === 200) return { status: 'no_posts', html };
      console.warn(`  ↳ ${handle}: rate-limited (HTTP ${res.status}) attempt ${attempt}/${MAX}`);
    } catch (e) {
      console.warn(`  ↳ ${handle}: ${e.message} attempt ${attempt}/${MAX}`);
    }
    await sleep(DELAY * attempt + Math.random() * 3000); // 999s are per-IP bursts; patient, jittered backoff clears them
  }
  return { status: 'authwalled', html: '' };
}

function extractText(segment) {
  // Activity-page variant: <p class="attributed-text-segment-list__content">; profile variant: <div class="see-more-text">
  const pats = [/<p class="attributed-text-segment-list__content[^"]*"[^>]*>([\s\S]*?)<\/p>/g, /<div[^>]*class="see-more-text[^"]*"[^>]*>([\s\S]*?)<\/div>/g];
  for (const re of pats) {
    const found = [...segment.matchAll(re)].map(x => decode(x[1].replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '')).trim()).filter(Boolean);
    if (found.length) return found.pop();
  }
  return '';
}

function parsePosts(html, handle) {
  const urlRe = /https:\/\/www\.linkedin\.com\/posts\/(([a-z0-9\-%]+)_[a-zA-Z0-9_\-%]+-activity-(\d+)-[A-Za-z0-9_\-]+)/g;
  const urls = []; let m;
  while ((m = urlRe.exec(html))) urls.push({ pos: m.index, url: m[0], slug: m[1], author: m[2].toLowerCase(), id: m[3] });
  const posts = []; const seen = new Set();
  const reactRe = /data-num-reactions="(\d+)"/g;
  while ((m = reactRe.exec(html))) {
    const pos = m.index;
    const prev = urls.filter(u => u.pos < pos).pop();
    if (!prev || seen.has(prev.id)) continue;
    seen.add(prev.id);
    const after = html.slice(pos, pos + 4000);
    const comments = Number((/data-num-comments="(\d+)"/.exec(after) || [])[1] || 0);
    const between = html.slice(prev.pos, pos);
    const text = extractText(between).replace(/[\u2800\u00a0]+/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n').trim();
    const reactions = Number(m[1]);
    const isOwn = prev.author === handle.toLowerCase();
    const at = postedAt(prev.id);
    const ageH = at ? +((Date.now() - at.getTime()) / 3.6e6).toFixed(1) : null;
    posts.push({ id: prev.id, url: prev.url, author: prev.author, isOwn, reactions, comments, postedAt: at?.toISOString() || null, ageHours: ageH, text: text.slice(0, 700), hook: text.split('\n').slice(0, 2).join(' / ').slice(0, 210), ctaGated: CTA_RE.test(text) });
  }
  return posts;
}

// Announcements (book / new job / launch / award) spike for reasons you can't reuse. Keep them visible but tagged.
const ANNOUNCE_RE = /\b(i'?m (happy|thrilled|excited|proud) to (share|announce)|my new book|new book|is out today|i'?m joining|i joined|i'?m now (working|at)|announcing|introducing|welcome to|launch(ing|ed)? today|we raised|funding|i'?m on wired|board of directors|new role|new chapter)\b/i;
const classify = text => ANNOUNCE_RE.test((text || '').slice(0, 400)) ? 'announcement' : 'playbook';

/** HarvestAPI profile-posts → normalised post records (same shape as parsePosts). Field names mapped defensively. */
async function fetchHarvest(handle, maxPosts = 100) {
  const all = [];
  for (let page = 1; page <= 5 && all.length < maxPosts; page++) {
    const url = `https://api.harvestapi.io/linkedin/profile-posts?profile=${encodeURIComponent(handle)}&page=${page}`;
    const res = await fetch(url, { headers: { 'X-API-Key': HARVEST_KEY, accept: 'application/json' } });
    if (res.status === 401 || res.status === 403) return { status: 'harvest_unauthorized', posts: [] };
    if (res.status === 402 || res.status === 429) return { status: `harvest_${res.status === 402 ? 'no_credits' : 'rate_limited'}`, posts: all };
    if (!res.ok) return { status: `harvest_http_${res.status}`, posts: all };
    const data = await res.json();
    const els = data.elements || data.posts || data.items || data.data || [];
    if (!Array.isArray(els) || !els.length) break;
    for (const e of els) {
      const eng = e.engagement || e.socialActivity || e.stats || {};
      const reactions = Number(eng.likes ?? eng.reactions ?? eng.numLikes ?? e.likes ?? e.reactions ?? e.numLikes ?? 0);
      const comments = Number(eng.comments ?? eng.numComments ?? e.comments ?? e.numComments ?? 0);
      const reposts = Number(eng.shares ?? eng.reposts ?? eng.numShares ?? e.shares ?? e.reposts ?? e.numShares ?? 0);
      const text = String(e.content ?? e.text ?? e.commentary ?? '').trim();
      const url = e.linkedinUrl || e.url || e.postUrl || '';
      const ts = e.postedAt?.timestamp ?? e.postedAt?.date ?? e.postedAt ?? e.publishedAt ?? e.createdAt ?? null;
      let at = ts ? new Date(typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts) : null;
      const idm = /activity[-:](\d{15,})/.exec(url) || /(\d{15,})/.exec(String(e.id || e.urn || ''));
      if ((!at || isNaN(at)) && idm) at = postedAt(idm[1]);
      const authorHandle = String(e.author?.publicIdentifier || e.author?.username || e.author?.linkedinUrl || e.author?.url || '').split('/in/').pop().replace(/\/.*$/, '').toLowerCase();
      const isRepost = Boolean(e.repost || e.resharedPost || e.isRepost || /reposted|reshare/i.test(e.type || e.postType || ''));
      const isOwn = !isRepost && (!authorHandle || authorHandle === handle.toLowerCase());
      const media = e.document || e.postDocument ? 'document' : (e.video || e.postVideo ? 'video' : (Array.isArray(e.postImages) && e.postImages.length || e.image || e.postImage ? 'image' : (e.article ? 'article' : 'text')));
      all.push({ id: idm ? idm[1] : String(e.id || url), url, author: authorHandle || handle, isOwn, reactions, comments, reposts, postedAt: at && !isNaN(at) ? at.toISOString() : null, ageHours: at && !isNaN(at) ? +((Date.now() - at.getTime()) / 3.6e6).toFixed(1) : null, text: text.slice(0, 700), hook: text.split('\n').filter(Boolean).slice(0, 2).join(' / ').slice(0, 210), ctaGated: CTA_RE.test(text), media });
    }
    const totalPages = Number(data.pagination?.totalPages ?? data.totalPages ?? 1);
    if (page >= totalPages) break;
    await sleep(400);
  }
  return { status: all.length ? 'ok' : 'no_posts', posts: all };
}

function score(creator, posts) {
  const own = posts.filter(p => p.isOwn);
  for (const p of own) {
    p.weighted = Math.round(p.reactions + 3 * p.comments * (p.ctaGated ? 0.34 : 1) + 5 * (p.reposts || 0));
    p.type = classify(p.text);
  }
  const mature = own.filter(p => p.ageHours == null || p.ageHours >= 24);
  const n = mature.length;
  const med = median(mature.map(p => p.weighted));
  let mad = median(mature.map(p => Math.abs(p.weighted - med)));
  if (mad < 0.1 * med) mad = Math.max(mad, 0.1 * med); // floor MAD so an ultra-consistent creator can't make every post a z-outlier
  for (const p of own) {
    p.mult = med ? +(p.weighted / med).toFixed(2) : null;
    p.z = med && mad ? +((p.weighted - med) / (1.4826 * mad)).toFixed(2) : null;
    p.inBaseline = mature.includes(p);
    p.tier = n >= GATES.minN && p.mult >= GATES.mult && p.z >= GATES.z ? 'OUTLIER' : (p.mult >= GATES.watch ? 'WATCH' : null);
    if (p.tier && !p.inBaseline) p.tier += '_EARLY'; // < 24h: promising but not mature
  }
  // Keep the file small: every flagged post + the 12 most recent for context
  const keep = new Set(own.filter(p => p.tier).concat([...own].sort((a, b) => (b.postedAt || '').localeCompare(a.postedAt || '')).slice(0, 12)));
  return { ...creator, n, median: med, mad: +mad.toFixed(1), postsFetched: own.length, posts: [...keep].sort((a, b) => (b.mult || 0) - (a.mult || 0)) };
}

async function main() {
  const watchlist = JSON.parse(await readFile(path.join(ROOT, 'data/watchlist.json'), 'utf8'));
  const targets = watchlist.filter(c => !ONLY || ONLY.includes(c.handle));
  let previous = {};
  try { previous = Object.fromEntries((JSON.parse(await readFile(OUT, 'utf8')).creators || []).map(c => [c.handle, c])); } catch {}
  const creators = [];
  let publicUsed = 0;
  console.log(`Scouting ${targets.length} creators · source: ${HARVEST_KEY ? 'HarvestAPI (primary) + public fallback' : `public pages only (capped at ${PUBLIC_MAX}; set HARVEST_API_KEY for full coverage)`}`);
  for (const c of targets) {
    process.stdout.write(`• ${c.name} (${c.handle}) … `);
    let status = 'skipped', posts = [], source = null, followers = null;
    if (HARVEST_KEY) {
      const r = await fetchHarvest(c.handle);
      status = r.status; posts = r.posts; source = 'harvestapi';
      if (status === 'harvest_unauthorized') { console.log('HARVEST KEY REJECTED — aborting'); process.exit(2); }
    }
    if (status !== 'ok' && publicUsed < PUBLIC_MAX) {
      publicUsed++;
      const r = await fetchActivity(c.handle);
      if (r.status === 'ok') { status = 'ok'; posts = parsePosts(r.html, c.handle); source = 'public'; followers = (/([\d,\.]+[KkMm]?)\s+followers/.exec(r.html) || [])[1] || null; }
      else status = status === 'skipped' ? r.status : `${status}+${r.status}`;
      await sleep(DELAY + Math.random() * 1500);
    }
    if (status !== 'ok') {
      console.log(status.toUpperCase());
      const prev = previous[c.handle];
      creators.push(prev && prev.posts?.length ? { ...prev, status: `stale:${status}` } : { ...c, status, source, n: 0, median: 0, mad: 0, posts: [] });
      continue;
    }
    const scored = score({ ...c, status: 'ok', source, followers: followers || previous[c.handle]?.followers || null, scoutedAt: new Date().toISOString() }, posts);
    const o = scored.posts.filter(p => p.tier?.startsWith('OUTLIER')).length;
    console.log(`${source} · ${scored.postsFetched} posts · baseline n=${scored.n} median=${scored.median} MAD=${scored.mad} · ${o ? `★ ${o} OUTLIER` : 'no outlier'}`);
    creators.push(scored);
  }
  const outliers = creators.flatMap(c => (c.posts || []).filter(p => p.tier).map(p => ({ creator: c.name, handle: c.handle, ring: c.ring, role: c.role || '', followers: c.followers, baselineMedian: c.median, baselineMad: c.mad, baselineN: c.n, source: c.source, ...p })))
    .sort((a, b) => (b.tier.startsWith('OUTLIER') - a.tier.startsWith('OUTLIER')) || (b.mult - a.mult));
  const out = {
    generatedAt: new Date().toISOString(),
    model: { weighted: 'reactions + 3×comments×(ctaGated ? 0.34 : 1) + 5×reposts', baseline: "median & MAD of the creator's own posts aged ≥24h (MAD floored at 10% of median)", gates: GATES, sources: { harvestapi: Boolean(HARVEST_KEY), publicPagesUsed: publicUsed } },
    summary: { creators: creators.length, ok: creators.filter(c => c.status === 'ok').length, stale: creators.filter(c => /stale/.test(c.status)).length, failed: creators.filter(c => !/ok|stale/.test(c.status)).length, outliers: outliers.filter(o => o.tier.startsWith('OUTLIER')).length, playbookOutliers: outliers.filter(o => o.tier.startsWith('OUTLIER') && o.type !== 'announcement').length, watch: outliers.filter(o => o.tier.startsWith('WATCH')).length },
    outliers, creators
  };
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out, null, 2));
  console.log(`\n✔ ${OUT}\n  ${out.summary.ok}/${creators.length} refreshed · ${out.summary.stale} stale · ${out.summary.outliers} OUTLIER (${out.summary.playbookOutliers} reusable) · ${out.summary.watch} WATCH`);
  for (const o of outliers.slice(0, 15)) console.log(`  ${o.tier.padEnd(13)} ${String(o.mult).padStart(6)}x z=${String(o.z).padStart(6)}  ${(o.type === 'announcement' ? '[ann] ' : '')}${o.creator}: ${o.hook.slice(0, 70)}`);
}
main().catch(e => { console.error(e); process.exit(1); });
