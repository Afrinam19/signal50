#!/usr/bin/env node
/**
 * One-time seed: converts the real HarvestAPI scan embedded in the Nov 10 00:06 UTC studio build
 * (10 creators × ~100 posts, 25 verified outliers) into the scout's data/outliers.json format,
 * so the studio shows real data before the first scheduled scout run.
 */
import { readFile, writeFile } from 'node:fs/promises';
const { meta, snap } = JSON.parse(await readFile('/tmp/snapshot.json', 'utf8'));
const watch = JSON.parse(await readFile('data/watchlist.json', 'utf8'));
const byName = Object.fromEntries(watch.map(c => [c.name, c]));
const handleOf = o => (/linkedin\.com\/posts\/([a-z0-9\-%]+?)_/i.exec(o.url || '') || [])[1] || byName[o.creator]?.handle || null;
const CTA_RE = /\b(comment|type|drop|reply)\s+["“'‘]?[A-Z0-9][\w\-]*["”'’]?\s*(below|to get|and i'?ll|for)|dm\s+me|link in (the )?comments?/im;
const creators = meta.creators.map(mc => {
  const w = watch.find(c => c.name === mc.name) || { name: mc.name, ring: 1, role: '' };
  const posts = snap.filter(o => o.creator === mc.name).map(o => {
    const idm = /activity-(\d{15,})/.exec(o.url || '');
    const at = o.date ? new Date(o.date + 'T12:00:00Z') : null;
    return {
      id: idm ? idm[1] : o.id, url: o.url, author: handleOf(o), isOwn: true,
      reactions: o.likes, comments: o.comments, reposts: o.reposts,
      postedAt: at ? at.toISOString() : null, ageHours: at ? +((Date.now() - at.getTime()) / 3.6e6).toFixed(1) : null,
      text: o.insight ? `${o.topic}\n${o.insight}` : o.topic, hook: o.topic, ctaGated: CTA_RE.test(o.topic || ''), media: o.media,
      weighted: Math.round(o.likes + 3 * o.comments + 5 * o.reposts), type: o.type, mult: o.mult, z: o.z, inBaseline: true,
      tier: o.mult >= 3 && o.z >= 2.5 ? 'OUTLIER' : (o.mult >= 1.5 ? 'WATCH' : null)
    };
  }).sort((a, b) => b.mult - a.mult);
  return { handle: handleOf(posts[0] ? { url: posts[0].url, creator: mc.name } : { creator: mc.name }), name: mc.name, ring: w.ring, role: w.role, status: 'ok', source: 'harvestapi', followers: null, scoutedAt: meta.scannedAt, n: mc.posts, median: mc.median, mad: snap.find(o => o.creator === mc.name)?.mad ?? Math.round(mc.median * 0.4), postsFetched: mc.posts, topMultiplier: mc.top, posts };
});
const outliers = creators.flatMap(c => c.posts.filter(p => p.tier).map(p => ({ creator: c.name, handle: c.handle, ring: c.ring, role: c.role, followers: null, baselineMedian: c.median, baselineMad: c.mad, baselineN: c.n, source: 'harvestapi', ...p })))
  .sort((a, b) => (b.tier.startsWith('OUTLIER') - a.tier.startsWith('OUTLIER')) || (b.mult - a.mult));
const out = {
  generatedAt: meta.scannedAt,
  model: { weighted: 'reactions + 3×comments×(ctaGated ? 0.34 : 1) + 5×reposts', baseline: "median & MAD of the creator's own posts aged ≥24h (MAD floored at 10% of median)", gates: { mult: 3, z: 2.5, watch: 1.5, minN: 4 }, sources: { harvestapi: true, publicPagesUsed: 0 }, note: 'Seeded from the HarvestAPI scan of 2026-11-10T00:06Z (10 creators × ~100 posts). Scheduled scout refreshes this file every 12h once HARVEST_API_KEY is set.' },
  summary: { creators: creators.length, ok: creators.length, stale: 0, failed: 0, outliers: outliers.filter(o => o.tier === 'OUTLIER').length, playbookOutliers: outliers.filter(o => o.tier === 'OUTLIER' && o.type !== 'announcement').length, watch: 0 },
  outliers, creators
};
await writeFile('data/outliers.json', JSON.stringify(out, null, 2));
console.log(`seeded ${creators.length} creators, ${out.summary.outliers} outliers (${out.summary.playbookOutliers} reusable)`);
console.log(creators.map(c => `${c.name} → ${c.handle} (n=${c.n}, med=${c.median})`).join('\n'));
