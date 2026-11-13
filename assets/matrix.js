// Signal50 Matrix layout — "Same N decisions. Different answers." comparison cheat sheet.
// Draws a 1080×1350 (4:5) brand-tinted matrix: up to 5 product columns × up to 6 decision rows,
// each row with a PM-takeaway strip, a closing banner and the Afrina footer. Frame f reveals rows < f
// (frame 0 = header only, last frame = every row) so the GIF Lab's one-frame-per-step loop works unchanged.
// draw() respects whatever transform the caller already set (the PNG exporter pre-scales 1.5×) and
// scales its own 1080×1350 coordinate space down to the (w, h) it is asked to fill.
//
// Spec format (one line each, `|` separated):
//   COLS: Muse (Meta) #0866FF | Claude Duet (Anthropic) #D97757 | dots (OpenAI) #6D5DF6 https://…/image.png
//   CORNER: What each team chose                 (optional, top-left header cell)
//   CHIP: Snapshot · Nov 10, 2026                (optional, top-right chip; defaults to today)
//   01 · Decision label | cell | cell | cell | 👉 PM takeaway (≤ 90 chars)
//   NOTE: bold closing line for the navy banner  (optional)
//   ALSO: small footnote on the right of the banner (optional)
//   SOURCES: one-line source credit              (optional)
// A column may carry an image URL (CORS-enabled hosts only) — otherwise upload images in the GIF Lab.
window.Signal50Matrix = (() => {
  const W = 1080, H = 1350;
  const INK = '#0B1B3A', MUTED = '#5B6880', LINE = 'rgba(11,27,58,0.09)';
  const DEFAULT_COLORS = ['#0866FF', '#D97757', '#6D5DF6', '#E08A00', '#E5484D', '#0E9F6E'];
  const GRAD = ['#0866FF', '#6D5DF6', '#FF7A59'];
  const MAX_COLS = 5, MAX_ROWS = 6;
  const META_RE = /^(COLS|CORNER|CHIP|NOTE|ALSO|SOURCES?)\s*:/i;

  // roundRect polyfill (older Safari / Firefox)
  if (typeof CanvasRenderingContext2D !== 'undefined' && !CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
      const rad = Math.max(0, Math.min(Array.isArray(r) ? r[0] : r, w / 2, h / 2));
      this.moveTo(x + rad, y); this.arcTo(x + w, y, x + w, y + h, rad); this.arcTo(x + w, y + h, x, y + h, rad);
      this.arcTo(x, y + h, x, y, rad); this.arcTo(x, y, x + w, y, rad); this.closePath();
    };
  }

  // ---- helpers -------------------------------------------------------------------------------
  const hexToRgb = hex => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return [8, 102, 255];
    const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const rgba = (hex, a) => { const [r, g, b] = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; };
  const darken = (hex, k = 0.78) => { const [r, g, b] = hexToRgb(hex).map(c => Math.round(c * k)); return `rgb(${r},${g},${b})`; };
  const rr = (ctx, x, y, w, h, r) => { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); };
  const fillRR = (ctx, x, y, w, h, r, fill, stroke, lw = 1) => { rr(ctx, x, y, w, h, r); ctx.fillStyle = fill; ctx.fill(); if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); } };
  const shadowRR = (ctx, x, y, w, h, r, fill, blur = 24, oy = 10, color = 'rgba(11,27,58,0.10)') => { ctx.save(); ctx.shadowColor = color; ctx.shadowBlur = blur; ctx.shadowOffsetY = oy; fillRR(ctx, x, y, w, h, r, fill); ctx.restore(); };
  const font = (ctx, px, weight = 500) => { ctx.font = `${weight} ${px}px -apple-system, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif`; };
  const txt = (ctx, s, x, y, color, align = 'left', base = 'alphabetic') => { ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = base; ctx.fillText(s, x, y); };
  const gradient = (ctx, x0, x1, y = 0) => { const g = ctx.createLinearGradient(x0, y, x1, y); GRAD.forEach((c, i) => g.addColorStop(i / (GRAD.length - 1), c)); return g; };
  const clip1 = (ctx, s, maxW) => { if (ctx.measureText(s).width <= maxW) return s; let t = s; while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1); return t + '…'; };

  function wrap(ctx, s, maxW, maxLines = 99) {
    const lines = [];
    for (const para of String(s || '').split('\n')) {
      const words = para.split(/\s+/).filter(Boolean); let cur = '';
      for (const w of words) {
        const t = cur ? `${cur} ${w}` : w;
        if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t;
        if (lines.length === maxLines) break;
      }
      if (cur && lines.length < maxLines) lines.push(cur);
      if (lines.length >= maxLines) break;
    }
    const all = String(s || '').split(/\s+/).filter(Boolean).join(' ');
    if (lines.length === maxLines && all !== lines.join(' ')) lines[maxLines - 1] = clip1(ctx, lines[maxLines - 1] + '…', maxW);
    return lines;
  }
  // Shrinks the font until the text fits in maxW × maxH (every line within maxW, then clips). Returns { px, lines, lh }.
  function fitBlock(ctx, s, maxW, maxH, startPx, minPx, weight = 500, lhRatio = 1.26) {
    for (let px = startPx; px >= minPx; px -= 0.5) {
      font(ctx, px, weight); const lh = px * lhRatio; const lines = wrap(ctx, s, maxW);
      if (lines.length * lh <= maxH && lines.every(l => ctx.measureText(l).width <= maxW)) return { px, lines, lh };
    }
    font(ctx, minPx, weight); const lh = minPx * lhRatio;
    return { px: minPx, lines: wrap(ctx, s, maxW, Math.max(1, Math.floor(maxH / lh))).map(l => clip1(ctx, l, maxW)), lh };
  }
  // Shrinks the font until the text fits on ONE line (then ellipsises). Leaves ctx.font set. Returns { px, text }.
  function fitLine(ctx, s, maxW, startPx, minPx, weight = 500) {
    for (let px = startPx; px >= minPx; px -= 0.5) { font(ctx, px, weight); if (ctx.measureText(s).width <= maxW) return { px, text: s }; }
    font(ctx, minPx, weight); return { px: minPx, text: clip1(ctx, s, maxW) };
  }
  function pill(ctx, x, y, label, px, fill, color, padX = 10) {
    font(ctx, px, 800); const w = ctx.measureText(label).width + padX * 2, h = px + 12;
    fillRR(ctx, x, y, w, h, h / 2, fill); txt(ctx, label, x + padX, y + h / 2 + 0.5, color, 'left', 'middle'); return w;
  }
  function drawCover(ctx, img, x, y, w, h, r) {
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    const s = Math.max(w / iw, h / ih), dw = iw * s, dh = ih * s;
    ctx.save(); rr(ctx, x, y, w, h, r); ctx.clip(); ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh); ctx.restore();
  }

  // ---- images (data URLs from the upload box, or CORS-enabled URLs from the COLS line) --------
  const images = []; // index = column → { src, img, ok }
  let onImage = null;
  function setImage(i, src) {
    if (!src) { images[i] = null; onImage && onImage(); return; }
    const img = new Image();
    if (!/^data:/.test(src)) img.crossOrigin = 'anonymous';
    const rec = { src, img, ok: false, error: false }; images[i] = rec;
    img.onload = () => { rec.ok = true; onImage && onImage(); };
    img.onerror = () => { rec.ok = false; rec.error = true; onImage && onImage(); };
    img.src = src;
  }
  function clearImages() { images.length = 0; onImage && onImage(); }

  // ---- spec --------------------------------------------------------------------------------------
  function parseSpec(text) {
    const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
    const take = (re) => { const l = lines.find(x => re.test(x)); return l ? l.replace(re, '').trim() : ''; };
    const colsLine = take(/^COLS\s*:/i);
    const corner = take(/^CORNER\s*:/i);
    const chip = take(/^CHIP\s*:/i);
    const note = take(/^NOTE\s*:/i);
    const also = take(/^ALSO\s*:/i);
    const sources = take(/^SOURCES?\s*:/i);
    const cols = (colsLine ? colsLine.split('|') : ['Option A', 'Option B', 'Option C'])
      .map(s => s.trim()).filter(Boolean).slice(0, MAX_COLS).map((raw, i) => {
        let s = raw, url = '';
        const u = /https?:\/\/\S+/.exec(s); if (u) { url = u[0]; s = s.replace(u[0], '').trim(); }
        const c = /#[0-9a-f]{6}\b/i.exec(s); const color = c ? c[0] : DEFAULT_COLORS[i % DEFAULT_COLORS.length]; if (c) s = s.replace(c[0], '').trim();
        const o = /\(([^)]+)\)\s*$/.exec(s); const org = o ? o[1].trim() : ''; if (o) s = s.replace(o[0], '').trim();
        if (url && !images[i]) setImage(i, url);
        return { name: s || `Option ${i + 1}`, org, color, url };
      });
    const rows = lines
      .filter(l => !META_RE.test(l)).slice(0, MAX_ROWS)
      .map(l => {
        const parts = l.split('|').map(s => s.trim());
        const label = (parts.shift() || '').replace(/^0?\d+\s*[·.:)-]\s*/, '');
        let takeaway = '';
        const last = parts[parts.length - 1] || '';
        if (parts.length > cols.length || /^(👉|TK\s*:)/.test(last)) takeaway = parts.pop().replace(/^(👉|TK\s*:)\s*/, '');
        const cells = cols.map((_, i) => parts[i] || '—');
        return { label, cells, takeaway };
      });
    return { cols, rows, corner, chip, note, also, sources };
  }

  // ---- draw ------------------------------------------------------------------------------------
  function draw(ctx, w, h, frame, total, spec) {
    ctx.save(); ctx.scale(w / W, h / H);
    const { cols, rows } = spec; const nC = Math.max(1, cols.length), nR = Math.max(1, rows.length);
    const revealed = Math.min(nR, Math.max(0, frame)); // rows < revealed are visible

    // background: soft mesh
    ctx.fillStyle = '#F5F7FB'; ctx.fillRect(0, 0, W, H);
    const blob = (x, y, r, c) => { const g = ctx.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, c); g.addColorStop(1, 'rgba(255,255,255,0)'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); };
    blob(1100, -80, 640, 'rgba(255,122,89,0.22)'); blob(-100, 0, 700, 'rgba(8,102,255,0.20)'); blob(650, 1450, 620, 'rgba(109,93,246,0.16)');

    // hero
    const M = 36; let y = 34;
    const eyebrow = (spec.brand || 'AI PM CHEAT SHEET').toUpperCase();
    ctx.save(); ctx.letterSpacing = '1.5px';
    font(ctx, 12.5, 800); const ew = ctx.measureText(eyebrow).width + 28; const eyeH = 27;
    ctx.fillStyle = gradient(ctx, M, M + ew); rr(ctx, M, y, ew, eyeH, eyeH / 2); ctx.fill();
    txt(ctx, eyebrow, M + 14, y + eyeH / 2 + 0.5, '#fff', 'left', 'middle'); ctx.restore();
    // snapshot chip (right)
    const chipLabel = spec.chip || `Snapshot · ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
    font(ctx, 13, 700); const cw = ctx.measureText(chipLabel).width + 26;
    shadowRR(ctx, W - M - cw, y - 2, cw, 31, 15.5, '#fff', 14, 4, 'rgba(11,27,58,0.08)'); txt(ctx, chipLabel, W - M - cw / 2, y + 14, INK, 'center', 'middle');

    y += eyeH + 14;
    // title: "{accent}" → gradient segment; "||" or "\n" → line break
    const title = (spec.title || 'Same {5 decisions}. Five different answers.').replace(/\\n|\|\|/g, '\n');
    const tLines = title.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 2);
    const titlePx = tLines.length > 1 ? 46 : 48;
    const titleTop = y; let firstLineW = 0;
    tLines.forEach((line, li) => {
      const segs = line.split(/(\{[^}]+\})/).filter(Boolean).map(s => ({ t: s.replace(/[{}]/g, ''), accent: /^\{/.test(s) }));
      font(ctx, titlePx, 900); let x = M; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      segs.forEach(s => { const sw = ctx.measureText(s.t).width; ctx.fillStyle = s.accent ? gradient(ctx, x, x + sw) : INK; ctx.fillText(s.t, x, y + titlePx * 0.86); x += sw; });
      if (li === 0) firstLineW = x - M;
      y += titlePx * 1.02;
    });
    // legend (right, level with the first title line) — only when it does not collide with the title
    font(ctx, 12.5, 500);
    const legendW = cols.reduce((acc, c) => acc + ctx.measureText(c.name).width + 26, 0);
    if (M + firstLineW + 24 < W - M - legendW) {
      let lx = W - M; const ly = titleTop + titlePx * 0.5;
      [...cols].reverse().forEach(c => { const lw = ctx.measureText(c.name).width; txt(ctx, c.name, lx, ly, MUTED, 'right', 'middle'); lx -= lw + 6; ctx.fillStyle = c.color; ctx.beginPath(); ctx.arc(lx - 5, ly, 5, 0, Math.PI * 2); ctx.fill(); lx -= 20; });
    }
    y += 6;
    font(ctx, 18, 500); const sub = wrap(ctx, spec.subtitle || '', 760, 2); sub.forEach(l => { txt(ctx, l, M, y + 14, MUTED); y += 24; });
    y += 14;

    // table geometry
    const footerH = 54, bannerH = spec.note ? 58 : 0, bottomPad = 26, gaps = 12 + (spec.note ? 12 : 0);
    const tableTop = y, tableX = M, tableW = W - 2 * M;
    const labelW = 168, colW = (tableW - labelW) / nC;
    const headH = 150;
    const availBody = H - tableTop - headH - bannerH - footerH - bottomPad - gaps - 8;
    const tkH = 40;
    const rowH = Math.max(84, Math.min(nR <= 3 ? 190 : 150, Math.floor(availBody / nR) - tkH));
    const tableH = headH + nR * (rowH + tkH);
    const cellPx = rowH >= 150 ? 22 : 18.5;

    // card
    shadowRR(ctx, tableX, tableTop, tableW, tableH, 18, '#fff', 40, 14, 'rgba(11,27,58,0.09)');
    ctx.save(); rr(ctx, tableX, tableTop, tableW, tableH, 18); ctx.clip();

    // header: corner
    ctx.fillStyle = INK; ctx.fillRect(tableX, tableTop, labelW, headH);
    ctx.save(); ctx.letterSpacing = '1.6px'; font(ctx, 11.5, 700); txt(ctx, 'DECISION', tableX + 14, tableTop + headH - 52, '#9DB8FF'); ctx.restore();
    font(ctx, 17, 700); wrap(ctx, spec.corner || 'What each one chose', labelW - 28, 2).forEach((l, i) => txt(ctx, l, tableX + 14, tableTop + headH - 30 + i * 21, '#fff'));
    // header: product tiles
    cols.forEach((c, i) => {
      const x = tableX + labelW + i * colW; const tx = x + 10, tw = colW - 20, ty = tableTop + 12, th = 84;
      ctx.fillStyle = '#fff'; ctx.fillRect(x, tableTop, colW, headH);
      ctx.fillStyle = c.color; ctx.fillRect(x, tableTop + headH - 3, colW, 3);
      const im = images[i];
      ctx.save(); ctx.shadowColor = 'rgba(11,27,58,0.14)'; ctx.shadowBlur = 14; ctx.shadowOffsetY = 5;
      if (im && im.ok) { fillRR(ctx, tx, ty, tw, th, 10, '#fff'); ctx.restore(); drawCover(ctx, im.img, tx, ty, tw, th, 10); }
      else {
        const g = ctx.createLinearGradient(tx, ty, tx + tw, ty + th); g.addColorStop(0, darken(c.color, 0.85)); g.addColorStop(1, c.color);
        fillRR(ctx, tx, ty, tw, th, 10, g); ctx.restore();
        const initial = (c.name.trim()[0] || '?').toUpperCase();
        fillRR(ctx, tx + 14, ty + th / 2 - 20, 40, 40, 11, 'rgba(255,255,255,0.95)');
        font(ctx, 22, 900); txt(ctx, initial, tx + 34, ty + th / 2 + 1, c.color, 'center', 'middle');
        const nm = fitBlock(ctx, c.name.replace(/\s*·\s*/g, '\n'), tw - 70, th - 16, 22, 13, 900, 1.05);
        nm.lines.forEach((l, k) => txt(ctx, l, tx + 64, ty + th / 2 - ((nm.lines.length - 1) * nm.lh) / 2 + k * nm.lh, '#fff', 'left', 'middle'));
      }
      const nm1 = fitLine(ctx, c.name, colW - 20, 19, 13, 800);
      txt(ctx, nm1.text, tx, ty + th + 25, darken(c.color, 0.8));
      ctx.fillStyle = c.color; ctx.beginPath(); ctx.arc(tx + 5, ty + th + 44, 4.5, 0, Math.PI * 2); ctx.fill();
      font(ctx, 12.5, 500); txt(ctx, clip1(ctx, c.org || ' ', colW - 36), tx + 15, ty + th + 48, MUTED);
    });
    ctx.strokeStyle = LINE; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(tableX + labelW, tableTop + headH - 0.5); ctx.lineTo(tableX + tableW, tableTop + headH - 0.5); ctx.stroke();

    // rows
    let ry = tableTop + headH;
    rows.forEach((r, ri) => {
      const on = ri < revealed;
      // label cell
      ctx.fillStyle = '#fff'; ctx.fillRect(tableX, ry, labelW, rowH);
      const bx = tableX + 14, by = ry + 12;
      ctx.save(); ctx.shadowColor = 'rgba(109,93,246,0.35)'; ctx.shadowBlur = 10; ctx.shadowOffsetY = 4;
      fillRR(ctx, bx, by, 30, 30, 9, on ? gradient(ctx, bx, bx + 30) : '#C9D2E3'); ctx.restore();
      font(ctx, 13, 800); txt(ctx, String(ri + 1).padStart(2, '0'), bx + 15, by + 15.5, '#fff', 'center', 'middle');
      const lb = fitBlock(ctx, r.label, labelW - 26, rowH - 56, 17.5, 13, 800, 1.18);
      lb.lines.forEach((l, k) => txt(ctx, l, bx, by + 30 + 22 + k * lb.lh, on ? INK : '#9AA6BC'));
      // cells
      r.cells.forEach((cell, ci) => {
        const c = cols[ci]; const x = tableX + labelW + ci * colW;
        ctx.fillStyle = rgba(c.color, 0.07); ctx.fillRect(x, ry, colW, rowH);
        ctx.strokeStyle = 'rgba(11,27,58,0.05)'; ctx.beginPath(); ctx.moveTo(x + 0.5, ry); ctx.lineTo(x + 0.5, ry + rowH); ctx.stroke();
        fillRR(ctx, x, ry + 10, 3, rowH - 20, 2, on ? c.color : '#D5DCE8');
        if (on) {
          const fb = fitBlock(ctx, cell, colW - 24, rowH - 18, cellPx, 12.5, 500, 1.26);
          fb.lines.forEach((l, k) => txt(ctx, l, x + 13, ry + 10 + fb.px * 0.95 + k * fb.lh, INK));
        } else {
          fillRR(ctx, x + 13, ry + 16, colW * 0.62, 10, 5, 'rgba(11,27,58,0.06)'); fillRR(ctx, x + 13, ry + 34, colW * 0.45, 10, 5, 'rgba(11,27,58,0.05)');
        }
      });
      ctx.strokeStyle = LINE; ctx.beginPath(); ctx.moveTo(tableX + labelW, ry + rowH - 0.5); ctx.lineTo(tableX + tableW, ry + rowH - 0.5); ctx.stroke();
      ry += rowH;
      // takeaway strip
      const g = ctx.createLinearGradient(tableX, ry, tableX + tableW, ry); g.addColorStop(0, '#F3F6FF'); g.addColorStop(0.55, '#FBF4FF'); g.addColorStop(1, '#FFF4EF');
      ctx.fillStyle = g; ctx.fillRect(tableX, ry, tableW, tkH);
      if (on && r.takeaway) {
        const pw = pill(ctx, tableX + 14, ry + 9, 'PM TAKEAWAY', 11, gradient(ctx, tableX + 14, tableX + 120), '#fff', 8);
        const tk = fitLine(ctx, r.takeaway, tableW - pw - 44, 17, 12, 500);
        txt(ctx, tk.text, tableX + 14 + pw + 10, ry + tkH / 2 + 1, '#1B2B4B', 'left', 'middle');
      } else if (!on) { fillRR(ctx, tableX + 14, ry + 15, 160, 10, 5, 'rgba(11,27,58,0.06)'); }
      ctx.strokeStyle = LINE; ctx.beginPath(); ctx.moveTo(tableX, ry + tkH - 0.5); ctx.lineTo(tableX + tableW, ry + tkH - 0.5); ctx.stroke();
      ry += tkH;
    });
    ctx.restore(); // card clip
    rr(ctx, tableX, tableTop, tableW, tableH, 18); ctx.strokeStyle = LINE; ctx.lineWidth = 1; ctx.stroke();

    // banner
    let by2 = tableTop + tableH + 12;
    if (spec.note) {
      shadowRR(ctx, M, by2, tableW, bannerH, 14, INK, 30, 10, 'rgba(11,27,58,0.18)');
      const noteW = spec.also ? tableW * 0.56 : tableW - 36;
      const nb = fitBlock(ctx, spec.note, noteW, bannerH - 14, 19, 13, 800, 1.15);
      nb.lines.forEach((l, k) => txt(ctx, l, M + 18, by2 + bannerH / 2 - ((nb.lines.length - 1) * nb.lh) / 2 + k * nb.lh, '#fff', 'left', 'middle'));
      if (spec.also) {
        const ab = fitBlock(ctx, spec.also, tableW * 0.38, bannerH - 14, 13, 10.5, 500, 1.3);
        ab.lines.forEach((l, k) => txt(ctx, l, M + tableW - 18, by2 + bannerH / 2 - ((ab.lines.length - 1) * ab.lh) / 2 + k * ab.lh, '#C7D4F2', 'right', 'middle'));
      }
      by2 += bannerH + 12;
    }

    // footer — link pill (right) first, so the author + sources lines can use whatever width is left
    const fy = H - bottomPad;
    const cta = spec.cta || 'https://www.linkedin.com/in/afrina-m/';
    const [pillText, rest] = cta.includes('·') ? cta.split('·').map(s => s.trim()) : [cta, ''];
    font(ctx, 14, 500); const restW = rest ? ctx.measureText(rest).width : 0;
    font(ctx, 14, 800); const pw = ctx.measureText(pillText).width + 26; const px = W - M - restW - (rest ? 10 : 0) - pw;
    fillRR(ctx, px, fy - 34, pw, 32, 16, '#DCEEFF'); txt(ctx, pillText, px + pw / 2, fy - 17.5, INK, 'center', 'middle');
    if (rest) { font(ctx, 14, 500); txt(ctx, rest, W - M, fy - 17.5, INK, 'right', 'middle'); }
    const authFit = fitLine(ctx, spec.authorLine || 'Afrina M - AI PM @ Google | Follow along for Build with Antigravity Series', px - M - 16, 16, 11.5, 800);
    txt(ctx, authFit.text, M, fy - 26, INK);
    font(ctx, 11.5, 500); txt(ctx, clip1(ctx, spec.sources || 'Sources: company help centers, launch posts, press coverage. Product images: official brand assets, © their owners.', px - M - 16), M, fy - 7, '#7A889E');
    ctx.restore();
  }

  const PRESETS = {
    agents: {
      brand: 'AI PM CHEAT SHEET · PERSONAL AGENTS',
      title: 'Same 5 decisions.||{Five different answers.}',
      subtitle: 'How Meta, Anthropic, OpenAI, a startup, and open source each built a personal agent.',
      cta: 'https://www.linkedin.com/in/afrina-m/',
      spec: `COLS: Muse (Meta) #0866FF | Claude Duet (Anthropic) #D97757 | dots (OpenAI) #6D5DF6 | Instinct (Startup · Spear Street) #E08A00 | OpenClaw · Hermes (Open source) #E5484D
CORNER: What each team chose
CHIP: Snapshot · Nov 10, 2026
01 · When does it ask you first? | Stops before anything that's hard to undo | Shows the exact step, waits for your OK | Default approval rules; you tune them per app | Testers: it sent an email without asking (Aug 2026) | Your rules: allow or ask, per command | 👉 Trust is binary. Put a human check in front of every action you can't take back.
02 · Where do people talk to it? | Its own app, or inside WhatsApp (text or voice) | Its own app. You message it. | Inside ChatGPT (mobile + desktop) | Text or call. No app at all. | WhatsApp, Telegram, or any chat app | 👉 Meet people where they already are. Don't fight for a spot on their home screen.
03 · Where does the work run? | Meta's cloud, in a dedicated secure VM | Cloud VM. Runs even when your laptop is off. | Its own cloud computer, always on | Hosted by Instinct (you only text it) | Your own laptop or server | 👉 Local: data stays with the user. Cloud: your team owns it. That's a security review, not a feature.
04 · How does it reach users? | Rides WhatsApp and Instagram | US waitlist for Claude Pro, Max, Ultra | Bundled into paid ChatGPT plans | Invite-only. Grew by word of mouth. | GitHub + open-source community | 👉 If you already have a distribution engine, ride it. Don't build a funnel from scratch.
05 · What does it cost? | Free tier, then $20 or $100 a month | No extra fee. Uses your plan's limits. | Pro ($100–$500) or Business Premium plans | Free today. No price published yet. | Free (MIT). You pay for model + machine. | 👉 Know what each user costs to run, per task and per month. Value per token per watt wins.
NOTE: Others can copy features. They can't copy trust, or the users you already have.
ALSO: Also in the post: Grok Bot (xAI) ships inside The X Subscription ($30–$200/mo) and Cursor plans.
SOURCES: Sources: company help centers, launch posts, press coverage. Prices in USD, snapshot Nov 10, 2026. Product images: official brand assets, © their owners.`
    }
  };

  // Prompt that asks Antigravity (or any model) to research + fill a new matrix in this exact format.
  function promptFor(fields) {
    const f = fields || {};
    return `You are helping Afrina M (Senior PM at Google — builds Gemini & AI agents; writes "how AI products really get made" on LinkedIn) create a 4:5 comparison cheat sheet for her Signal50 GIF Lab → Visual Density "Matrix".

TOPIC / HEADLINE: ${f.title || 'Same {5 decisions}.||Five different answers.'}
SUBTITLE: ${f.subtitle || 'How <company A>, <company B>, <company C>, a startup, and open source each built <product category>.'}
PRODUCTS TO COMPARE (max 5 columns): <Name (Org) #brandhex> — in the order they should appear
DECISIONS TO COMPARE (max 6 rows): the product trade-offs every team had to make (e.g. permissions, surface, where it runs, distribution, pricing)

RULES
1. Facts only. Every cell must come from a primary source (company help center, launch post, docs) or major press. After the spec, add a SOURCES_LIST with one URL per cell. Write "Not published" when unknown — never guess, never fill a gap with a plausible number.
2. Plain English in Afrina's voice: short sentences, no jargon, none of these words: delve, unlock, game-changer, landscape, tapestry, testament, seamless. Prices in USD. Public facts only — nothing from inside Google.
3. Length limits (they are what makes the layout fit): row label ≤ 32 characters, cell ≤ 45 characters, PM takeaway ≤ 90 characters, NOTE ≤ 90, ALSO ≤ 110. Takeaways state the product principle, not the feature.
4. Keep the column order identical in every row. Row labels are written as the question the team had to answer.
5. Output ONLY the spec block (then SOURCES_LIST), ready to paste into the "System Spec" box. Then suggest a 1-line headline using {braces} around the phrase to highlight and "||" for the line break.

SPEC FORMAT
COLS: Name (Org) #0866FF | Name (Org) #D97757 | Name (Org) #6D5DF6 | Name (Org) #E08A00 | Name (Org) #E5484D
CORNER: What each team chose
CHIP: Snapshot · <Mon D, YYYY>
01 · <decision as a question> | <cell> | <cell> | <cell> | <cell> | <cell> | 👉 <PM takeaway>
02 · … (one line per decision, same column order, up to 06)
NOTE: <one bold closing truth, ≤ 90 chars>
ALSO: <one footnote for what did not fit, ≤ 110 chars>
SOURCES: Sources: company help centers, launch posts, press coverage. Prices in USD, snapshot <date>. Product images: official brand assets, © their owners.

CURRENT SPEC (format reference — replace the content, keep the shape):
${f.spec || PRESETS.agents.spec}`;
  }

  return { draw, parseSpec, PRESETS, promptFor, images, setImage, clearImages, set onImage(fn) { onImage = fn; }, MAX_COLS, MAX_ROWS };
})();
