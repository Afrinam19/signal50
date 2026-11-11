/* Signal50 — "Factory" dense B2B visual renderer (4:5, base 720×900; scales to 1080×1350)
 * Modeled on the structure of high-save B2B system diagrams: 1 central hub + 5 satellite stations,
 * numbered callout cards with tool chips, named workers, conveyor belts, and ONLY the envelopes animate.
 * Pure canvas: no external assets, crisp text at any scale, deterministic per post.
 */
window.Signal50Factory = (() => {
  const P = {
    cream: '#F3EDE3', floor: '#EBE2D3', paper: '#FFFFFF', ink: '#1F1A17', mute: '#6E655C', line: '#D8CFC2',
    terra: '#B5543A', terraDark: '#8E3F2B', terraPale: '#EBD2C6', belt: '#DDBBAB', rail: '#C79C8B',
    brick: '#A3523B', brickLine: '#7E3E2D', window: '#F6EFE4', sand: '#D9C7A8', amber: '#D9A441',
    skin: '#F2D2BD', hair: '#2E2320', shadow: 'rgba(60,35,20,0.16)'
  };
  const TINTS = {
    blue: { a: '#8FA6C4', b: '#DCE5F0', c: '#6F89AB' }, sage: { a: '#9DB8A4', b: '#DFEADF', c: '#7C9A84' },
    mauve: { a: '#B79DBE', b: '#E8DEEC', c: '#977CA0' }, pink: { a: '#D9A5A5', b: '#F2DCDC', c: '#BF8484' },
    teal: { a: '#7FB3AE', b: '#D6E9E6', c: '#5E948F' }, sand: { a: '#D9C7A8', b: '#EFE5D2', c: '#B9A47F' }
  };
  const TOOLS = {
    antigravity: ['#1F1A17', 'A'], gemini: ['#4285F4', 'G'], 'gemini flash': ['#4285F4', 'F'], 'flash-lite': ['#5E97F6', 'L'], 'ai studio': ['#4285F4', 'S'],
    mcp: ['#6B4EFF', 'M'], slack: ['#611F69', 's'], gmail: ['#EA4335', 'M'], drive: ['#FBBC04', 'D'], docs: ['#4285F4', 'D'], sheets: ['#0F9D58', 'S'],
    slides: ['#F4B400', 'P'], calendar: ['#4285F4', '31'], meet: ['#00897B', 'V'], notebooklm: ['#1E88E5', 'N'], notion: ['#111111', 'N'],
    github: ['#24292E', 'G'], figma: ['#A259FF', 'F'], imagen: ['#7B1FA2', 'I'], veo: ['#00897B', 'V'], playwright: ['#2EAD33', 'P'],
    claude: ['#D97757', 'C'], 'claude code': ['#D97757', 'C'], openai: ['#10A37F', 'O'], chatgpt: ['#10A37F', 'C'], linkedin: ['#0A66C2', 'in'],
    harvestapi: ['#F59E0B', 'H'], bigquery: ['#669DF6', 'B'], 'cloud run': ['#4285F4', 'R'], 'cloud logging': ['#4285F4', 'L'], looker: ['#4285F4', 'L'],
    vertex: ['#34A853', 'V'], jira: ['#0052CC', 'J'], linear: ['#5E6AD2', 'L'], salesforce: ['#00A1E0', 'S'], hubspot: ['#FF7A59', 'H'], instantly: ['#3B82F6', 'I'],
    fireflies: ['#7C3AED', 'F'], clay: ['#F97316', 'C'], zapier: ['#FF4F00', 'Z'], n8n: ['#EA4B71', 'n'], redis: ['#DC382D', 'R'], 'context cache': ['#5F6368', 'C'],
    hooks: ['#1F1A17', '#'], ci: ['#2088FF', 'CI'], forms: ['#7248B9', 'F'], support: ['#0F9D58', 'S'], svg: ['#FFB13B', 'S'], 'google search': ['#4285F4', 'G'],
    youtube: ['#FF0000', '▶'], canva: ['#00C4CC', 'C'], stripe: ['#635BFF', 'S'], perplexity: ['#20808D', 'P'], apify: ['#97D700', 'A']
  };
  const toolStyle = name => {
    const k = String(name || '').trim().toLowerCase();
    const hit = TOOLS[k] || Object.entries(TOOLS).find(([key]) => k.includes(key))?.[1];
    return hit ? { color: hit[0], glyph: hit[1] } : { color: '#6B7280', glyph: (k[0] || '?').toUpperCase() };
  };

  // ---------- parsing ----------
  function parseSpec(text) {
    const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
    const parseLine = l => {
      const parts = l.replace(/^HUB\s*:\s*/i, '').split('|').map(s => s.trim());
      return { title: parts[0] || '', sub: parts[1] || '', tools: (parts[2] || '').split(',').map(s => s.trim()).filter(Boolean), workers: (parts[3] || '').split(',').map(s => s.trim()).filter(Boolean) };
    };
    let hubLine = lines.find(l => /^HUB\s*:/i.test(l));
    const rest = lines.filter(l => l !== hubLine);
    const hub = hubLine ? parseLine(hubLine) : { title: 'Orchestrator', sub: 'routes every ask to the right worker', tools: ['Antigravity', 'Gemini', 'MCP'], workers: [] };
    // Classic "01 · Label | detail" step lines also work: title = label, tools inferred from words.
    const stations = rest.slice(0, 5).map(l => {
      const s = parseLine(l.replace(/^0?\d+\s*[·.:)-]\s*/, ''));
      if (!s.tools.length) s.tools = s.title.split(/[\s+→&,/]+/).filter(w => toolStyle(w).glyph && TOOLS[w.toLowerCase()]);
      return s;
    });
    while (stations.length < 5) stations.push({ title: `Station ${stations.length + 2}`, sub: '', tools: [], workers: [] });
    return { hub, stations };
  }

  // ---------- primitives ----------
  const rr = (ctx, x, y, w, h, r) => { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); };
  const fillRR = (ctx, x, y, w, h, r, fill, stroke, lw = 1) => { rr(ctx, x, y, w, h, r); ctx.fillStyle = fill; ctx.fill(); if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); } };
  const shadowRR = (ctx, x, y, w, h, r, fill, blur = 10, oy = 4) => { ctx.save(); ctx.shadowColor = P.shadow; ctx.shadowBlur = blur; ctx.shadowOffsetY = oy; fillRR(ctx, x, y, w, h, r, fill); ctx.restore(); };
  const font = (ctx, px, weight = 500, fam = 'sans') => { ctx.font = `${weight} ${px}px ${fam === 'serif' ? 'Georgia, "Times New Roman", serif' : '-apple-system, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif'}`; };
  const txt = (ctx, s, x, y, color, align = 'left') => { ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'alphabetic'; ctx.fillText(s, x, y); };
  const clip = (ctx, s, maxW) => { if (ctx.measureText(s).width <= maxW) return s; let t = s; while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1); return t + '…'; };

  function chip(ctx, x, y, size, tool) {
    const { color, glyph } = toolStyle(tool);
    fillRR(ctx, x, y, size, size, size * 0.28, color);
    font(ctx, glyph.length > 1 ? size * 0.48 : size * 0.62, 800);
    ctx.fillStyle = '#FFFFFF'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(glyph, x + size / 2, y + size / 2 + 0.5);
    ctx.textBaseline = 'alphabetic';
  }

  // Greedy word-wrap into at most `max` lines; the last line absorbs the rest and is ellipsised if it overflows.
  function wrap(ctx, s, maxW, max = 2) {
    const words = String(s || '').split(/\s+/).filter(Boolean); const lines = []; let cur = '';
    for (let i = 0; i < words.length; i++) {
      const t = cur ? `${cur} ${words[i]}` : words[i];
      if (ctx.measureText(t).width <= maxW || !cur) { cur = t; continue; }
      lines.push(cur); cur = words[i];
      if (lines.length === max - 1) { cur = words.slice(i).join(' '); break; }
    }
    if (cur) lines.push(clip(ctx, cur, maxW));
    return lines.slice(0, max);
  }
  function fitFont(ctx, s, maxW, start, min, weight = 800) { let px = start; font(ctx, px, weight); while (px > min && ctx.measureText(s).width > maxW) { px -= 1; font(ctx, px, weight); } return px; }

  function callout(ctx, x, y, w, n, title, sub, tools) {
    const h = 80;
    shadowRR(ctx, x, y, w, h, 10, P.paper, 12, 4);
    ctx.beginPath(); ctx.arc(x + 17, y + 19, 9, 0, Math.PI * 2); ctx.fillStyle = P.terra; ctx.fill();
    font(ctx, 10, 800); txt(ctx, String(n), x + 17, y + 22.5, '#fff', 'center');
    fitFont(ctx, title, w - 44, 14.5, 11.5); txt(ctx, clip(ctx, title, w - 44), x + 32, y + 24, P.ink);
    font(ctx, 10.5, 500); wrap(ctx, sub, w - 22, 2).forEach((l, i) => txt(ctx, l, x + 11, y + 38 + i * 12.5, P.mute));
    tools.slice(0, Math.floor((w - 22) / 19)).forEach((t, i) => chip(ctx, x + 11 + i * 19, y + 59, 14, t));
    return h;
  }

  function worker(ctx, x, y, tint, tool, name, variant = 0) {
    const T = TINTS[tint] || TINTS.blue;
    // chair back + body
    fillRR(ctx, x + 19, y + 15, 20, 18, 5, T.c);
    // head
    ctx.beginPath(); ctx.arc(x + 29, y + 9, 8.5, 0, Math.PI * 2); ctx.fillStyle = P.skin; ctx.fill();
    ctx.beginPath(); ctx.arc(x + 29, y + 7, 8.5, Math.PI, 0); ctx.fillStyle = [P.hair, '#5B3A2A', '#1E2B3A', '#7A4A2A'][variant % 4]; ctx.fill();
    if (variant % 3 === 1) { ctx.beginPath(); ctx.arc(x + 29, y + 2, 5, Math.PI, 0); ctx.fillStyle = P.amber; ctx.fill(); } // hard hat / beret accent
    // desk
    fillRR(ctx, x + 2, y + 28, 54, 22, 4, T.b, T.a, 1);
    ctx.fillStyle = T.a; ctx.fillRect(x + 2, y + 44, 54, 6);
    // monitor with tool
    fillRR(ctx, x + 15, y + 17, 28, 20, 3, '#FFFFFF', P.ink, 1.2);
    chip(ctx, x + 22, y + 20, 14, tool);
    ctx.fillStyle = P.ink; ctx.fillRect(x + 27, y + 37, 4, 3);
    // name tag
    fillRR(ctx, x + 1, y + 53, 56, 13, 3, '#FFFFFF', P.line, 1);
    font(ctx, 8.2, 700); txt(ctx, clip(ctx, name, 50), x + 29, y + 62.5, P.ink, 'center');
  }

  function stationBlock(ctx, x, y, w, tint, workers, tools) {
    const T = TINTS[tint] || TINTS.blue;
    const n = Math.max(1, workers.length);
    const step = Math.min(70, (w - 12) / n);
    shadowRR(ctx, x, y, w, 82, 10, T.b, 8, 3);
    ctx.fillStyle = T.a; ctx.globalAlpha = 0.35; ctx.fillRect(x, y + 70, w, 12); ctx.globalAlpha = 1;
    workers.forEach((name, i) => worker(ctx, x + 6 + i * step + (step - 58) / 2, y + 8, tint, tools[i % Math.max(1, tools.length)] || 'gemini', name, i));
  }

  function hub(ctx, x, y, w, h, spec) {
    shadowRR(ctx, x, y, w, h, 12, P.terra, 16, 6);
    fillRR(ctx, x, y, w, 30, [12, 12, 0, 0], P.terraDark);
    ctx.beginPath(); ctx.arc(x + 20, y + 15, 9, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
    font(ctx, 10, 800); txt(ctx, '1', x + 20, y + 18.5, P.terra, 'center');
    fitFont(ctx, spec.title, w - 46, 19, 12); txt(ctx, clip(ctx, spec.title, w - 46), x + 36, y + 21, '#fff');
    spec.tools.slice(0, 8).forEach((t, i) => chip(ctx, x + 12 + i * 21, y + 38, 16, t));
    font(ctx, 10, 500); wrap(ctx, spec.sub, w - 24, 2).forEach((l, i) => txt(ctx, l, x + 12, y + 68 + i * 12, '#F9E9E2'));
    // room: window + shelf
    fillRR(ctx, x + w - 58, y + 90, 44, 54, 4, P.sand, P.terraDark, 1);
    for (let i = 0; i < 4; i++) { ctx.fillStyle = ['#8FA6C4', '#9DB8A4', '#B79DBE', '#D9A5A5'][i]; ctx.fillRect(x + w - 52 + (i % 2) * 18, y + 96 + Math.floor(i / 2) * 24, 14, 17); }
    // plant
    [[x + 22, y + 118, 9], [x + 32, y + 110, 8], [x + 14, y + 110, 7]].forEach(([cx, cy, r]) => { ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fillStyle = '#9DB8A4'; ctx.fill(); });
    fillRR(ctx, x + 16, y + 126, 14, 14, 3, P.sand);
    // chief: mascot head, body, desk
    fillRR(ctx, x + 70, y + 118, 48, 30, 10, P.terraDark);
    ctx.beginPath(); ctx.arc(x + 94, y + 104, 20, 0, Math.PI * 2); ctx.fillStyle = '#F7F0E6'; ctx.fill();
    ctx.fillStyle = P.ink; ctx.beginPath(); ctx.ellipse(x + 87, y + 104, 3, 5, 0, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.ellipse(x + 101, y + 104, 3, 5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#E8B4A2'; ctx.fillRect(x + 92, y + 118, 4, 12);
    fillRR(ctx, x + 50, y + 140, 92, 14, 4, P.sand, P.terraDark, 1);
    fillRR(ctx, x + 120, y + 126, 18, 14, 2, '#fff', P.ink, 1); chip(ctx, x + 123, y + 128, 10, spec.tools[0] || 'antigravity');
  }

  // ---------- belts ----------
  function polyLen(pts) { let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return L; }
  function pointAt(pts, s) {
    for (let i = 1; i < pts.length; i++) {
      const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (s <= d) { const t = d ? s / d : 0; return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t]; }
      s -= d;
    }
    return pts[pts.length - 1];
  }
  function belt(ctx, pts, width = 16) {
    ctx.save(); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath(); pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
    ctx.strokeStyle = P.rail; ctx.lineWidth = width + 4; ctx.stroke();
    ctx.strokeStyle = P.belt; ctx.lineWidth = width; ctx.stroke();
    // rail ticks
    const L = polyLen(pts); ctx.strokeStyle = P.rail; ctx.lineWidth = 2;
    for (let s = 6; s < L; s += 12) { const [x, y] = pointAt(pts, s); const [x2, y2] = pointAt(pts, Math.min(L, s + 0.1)); const a = Math.atan2(y2 - y, x2 - x) + Math.PI / 2; ctx.beginPath(); ctx.moveTo(x - Math.cos(a) * width / 2, y - Math.sin(a) * width / 2); ctx.lineTo(x + Math.cos(a) * width / 2, y + Math.sin(a) * width / 2); ctx.stroke(); }
    ctx.restore();
  }
  function parcel(ctx, x, y, kind, tool) {
    ctx.save(); ctx.shadowColor = P.shadow; ctx.shadowBlur = 4; ctx.shadowOffsetY = 2;
    if (kind === 'box') { fillRR(ctx, x - 9, y - 7, 18, 14, 2, P.sand, '#B9A47F', 1); ctx.fillStyle = '#B9A47F'; ctx.fillRect(x - 1, y - 7, 2, 14); }
    else { fillRR(ctx, x - 10, y - 7, 20, 14, 2, '#FFFFFF', P.line, 1); ctx.strokeStyle = P.rail; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(x - 10, y - 7); ctx.lineTo(x, y + 1); ctx.lineTo(x + 10, y - 7); ctx.stroke(); }
    ctx.restore();
    chip(ctx, x + 3, y - 1, 8, tool);
  }

  // ---------- scene ----------
  function drawHeader(ctx, w, spec) {
    // brand pill
    font(ctx, 10.5, 800); const bw = ctx.measureText(spec.brand).width + 26;
    fillRR(ctx, w / 2 - bw / 2, 24, bw, 22, 11, P.paper, P.terra, 1.2); txt(ctx, spec.brand, w / 2, 39, P.terra, 'center');
    // title with {accent}
    font(ctx, 38, 800);
    const segs = spec.title.split(/(\{[^}]+\})/).filter(Boolean).map(s => ({ t: s.replace(/[{}]/g, ''), accent: /^\{/.test(s) }));
    let tw = segs.reduce((a, s) => a + ctx.measureText(s.t).width, 0);
    if (tw > w - 60) { font(ctx, 31, 800); tw = segs.reduce((a, s) => a + ctx.measureText(s.t).width, 0); }
    let x = w / 2 - tw / 2; ctx.textAlign = 'left';
    segs.forEach(s => { txt(ctx, s.t, x, 88, s.accent ? P.terra : P.ink); x += ctx.measureText(s.t).width; });
    // subtitle with **bold** or auto-number emphasis
    let sub = spec.subtitle; if (!/\*\*/.test(sub)) sub = sub.replace(/(\d[\d,\.]*[%+xX]?\s?(?:AI workers|workers|minutes|mins|hours|steps|agents|days|weeks)?)/g, '**$1**');
    font(ctx, 16, 500);
    const ss = sub.split(/(\*\*[^*]+\*\*)/).filter(Boolean).map(s => ({ t: s.replace(/\*\*/g, ''), b: /^\*\*/.test(s) }));
    const sw = ss.reduce((a, s) => { font(ctx, 16, s.b ? 800 : 500); return a + ctx.measureText(s.t).width; }, 0);
    x = w / 2 - sw / 2;
    ss.forEach(s => { font(ctx, 16, s.b ? 800 : 500); txt(ctx, s.t, x, 116, s.b ? P.terra : P.mute); x += ctx.measureText(s.t).width; });
  }

  function drawFooter(ctx, w, h, spec) {
    ctx.beginPath(); ctx.arc(52, h - 36, 19, 0, Math.PI * 2); ctx.fillStyle = P.ink; ctx.fill();
    font(ctx, 13, 800); txt(ctx, spec.initials || 'AM', 52, h - 31, '#fff', 'center');
    font(ctx, 15, 800); txt(ctx, spec.author || 'Afrina M', 80, h - 38, P.ink);
    font(ctx, 10, 500); txt(ctx, clip(ctx, spec.authorLine || '15+ yrs building product · Gemini & AI agents @ Google', 240), 80, h - 24, P.mute);
    // CTA pill: "Comment  [KEY]  to get the full setup"
    const m = /["“]([^"”]+)["”]/.exec(spec.cta || ''); const key = m ? m[1] : 'SETUP';
    const pre = (spec.cta || 'Comment "SETUP" to get the full setup').split(/["“][^"”]+["”]/)[0].trim() || 'Comment';
    const post = (spec.cta || '').split(/["“][^"”]+["”]/)[1]?.trim() || 'to get the full setup';
    font(ctx, 14, 700); const preW = ctx.measureText(pre).width, postW = ctx.measureText(post).width;
    font(ctx, 14, 900); const keyW = ctx.measureText(key).width + 22;
    const pillW = preW + keyW + postW + 50, px = w - 30 - pillW, py = h - 56, ph = 40;
    shadowRR(ctx, px, py, pillW, ph, 20, P.terra, 10, 4);
    font(ctx, 14, 700); txt(ctx, pre, px + 18, py + 25, '#fff');
    fillRR(ctx, px + 18 + preW + 8, py + 8, keyW, 24, 12, '#fff');
    font(ctx, 14, 900); txt(ctx, key, px + 18 + preW + 8 + keyW / 2, py + 25, P.terra, 'center');
    font(ctx, 14, 700); txt(ctx, post, px + 18 + preW + 8 + keyW + 8, py + 25, '#fff');
  }

  const TINT_ORDER = ['blue', 'sage', 'mauve', 'pink', 'teal'];
  const LAYOUT = {
    top: { callout: [238, 186, 262], block: [66, 270, 588] },
    left: { callout: [34, 386, 200], block: [34, 472, 200] },
    right: { callout: [486, 386, 200], block: [486, 472, 200] },
    bl: { callout: [50, 636, 240], block: [50, 722, 240] },
    br: { callout: [430, 636, 240], block: [430, 722, 240] },
    hub: [266, 404, 188, 160]
  };
  // Ring around the hub + spurs from each station. Parcels travel the ring clockwise and the spurs inward.
  const RING = [[250, 372], [470, 372], [470, 594], [250, 594], [250, 372]];
  const SPURS = [
    [[360, 352], [360, 372]], [[234, 513], [250, 513]], [[486, 513], [470, 513]],
    [[170, 636], [170, 594]], [[550, 636], [550, 594]]
  ];

  function draw(ctx, w, h, frame, total, spec) {
    const sx = w / 720, sy = h / 900;
    ctx.save(); ctx.scale(sx, sy);
    const W = 720, H = 900, t = total ? (frame % total) / total : 0;
    // background + paper grain
    ctx.fillStyle = P.cream; ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 0.05; for (let i = 0; i < 900; i++) { ctx.fillStyle = i % 2 ? '#000' : '#fff'; ctx.fillRect((i * 97) % W, (i * 53) % H, 1.2, 1.2); } ctx.globalAlpha = 1;
    drawHeader(ctx, W, spec);
    // floor
    shadowRR(ctx, 22, 134, 676, 700, 18, P.floor, 18, 8);
    fillRR(ctx, 22, 134, 676, 52, [18, 18, 0, 0], P.brick);
    ctx.strokeStyle = P.brickLine; ctx.lineWidth = 1; for (let y = 142; y < 186; y += 8) { ctx.beginPath(); ctx.moveTo(26, y); ctx.lineTo(694, y); ctx.stroke(); }
    [[60, 144, 120, 34], [540, 144, 120, 34]].forEach(([x, y, ww, hh]) => { fillRR(ctx, x, y, ww, hh, 3, P.window, P.brickLine, 1.5); ctx.strokeStyle = P.brickLine; for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo(x + i * ww / 4, y); ctx.lineTo(x + i * ww / 4, y + hh); ctx.stroke(); } ctx.beginPath(); ctx.moveTo(x, y + hh / 2); ctx.lineTo(x + ww, y + hh / 2); ctx.stroke(); });
    fillRR(ctx, 300, 142, 120, 38, 3, P.sand, P.brickLine, 1.5); for (let i = 0; i < 12; i++) { ctx.fillStyle = ['#8FA6C4', '#9DB8A4', '#B79DBE', '#D9A5A5', '#D9A441'][i % 5]; ctx.fillRect(306 + (i % 6) * 18, 147 + Math.floor(i / 6) * 16, 12, 12); }
    for (let x = 22; x < 698; x += 16) { ctx.fillStyle = (x / 16) % 2 ? P.amber : P.ink; ctx.fillRect(x, 186, 16, 4); }
    // lane lines + props
    ctx.setLineDash([10, 8]); ctx.strokeStyle = P.amber; ctx.lineWidth = 2; [[44, 600, 44, 820], [676, 600, 676, 820]].forEach(([x1, y1, x2, y2]) => { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }); ctx.setLineDash([]);
    [[36, 356], [52, 356], [44, 340]].forEach(([x, y]) => fillRR(ctx, x, y, 16, 16, 2, P.sand, '#B9A47F', 1));
    fillRR(ctx, 652, 334, 26, 44, 6, P.terra, P.terraDark, 1); ctx.fillStyle = '#fff'; ctx.fillRect(657, 346, 16, 4); fillRR(ctx, 661, 378, 8, 12, 1, P.terraDark);
    // belts
    belt(ctx, RING, 16); SPURS.forEach(s => belt(ctx, s, 14));
    // stations
    const st = spec.stations; const keys = ['top', 'left', 'right', 'bl', 'br'];
    keys.forEach((k, i) => { const s = st[i]; const L = LAYOUT[k]; stationBlock(ctx, L.block[0], L.block[1], L.block[2], TINT_ORDER[i], (s.workers.length ? s.workers : ['Worker']).slice(0, k === 'top' ? 8 : 3), s.tools); });
    hub(ctx, ...LAYOUT.hub, spec.hub);
    keys.forEach((k, i) => { const s = st[i]; const L = LAYOUT[k]; callout(ctx, L.callout[0], L.callout[1], L.callout[2], i + 2, s.title, s.sub, s.tools); });
    // parcels (the only animated layer)
    const RL = polyLen(RING); const allTools = [...spec.hub.tools, ...st.flatMap(s => s.tools)].filter(Boolean);
    for (let i = 0; i < 9; i++) { const [x, y] = pointAt(RING, ((t + i / 9) % 1) * RL); parcel(ctx, x, y, i % 3 === 2 ? 'box' : 'mail', allTools[i % Math.max(1, allTools.length)] || 'gemini'); }
    SPURS.forEach((sp, i) => { const L = polyLen(sp); const [x, y] = pointAt(sp, ((t * 1.0 + i * 0.2) % 1) * L); parcel(ctx, x, y, 'mail', st[i].tools[0] || 'gemini'); });
    drawFooter(ctx, W, H, spec);
    ctx.restore();
  }

  const PRESETS = {
    deck: {
      brand: 'BUILT WITH ANTIGRAVITY', title: 'The {Enterprise Deck} Factory', subtitle: '1 orchestrator for 14 AI workers. Rough notes → board-ready Google Slides in 6 minutes.', cta: 'Comment "DECK" to get the full setup',
      spec: `HUB: Deck Orchestrator | routes every brief to the right worker, keeps brand + facts locked | Antigravity, Gemini, MCP, Drive, Slides, Calendar, GitHub
Intake | one worker per source, each with its own context | Drive, Gmail, Meet, NotebookLM, Sheets, Slack, Figma, Jira | Transcript, CSV, Notes, Figma, Jira, Slack, Docs, Email
Fact Check | every number traced to a source, or flagged | BigQuery, Sheets, Gemini | Auditor, Pricing
Narrative | SCQA headlines, exec summary, a so-what per slide | Gemini, NotebookLM, Docs | Storyline, Headlines, Notes
Design System | brand tokens, grid and typography enforced | Figma, Imagen, SVG | Tokens, Diagrams, Icons
Ship + QA | native editable Slides, speaker notes, human review | Slides, Docs, Playwright, GitHub | Builder, QA, Export`
    },
    gtm: {
      brand: 'BUILT WITH ANTIGRAVITY', title: 'The {Release-to-Demo} Factory', subtitle: '1 orchestrator for 12 AI workers. GitHub release notes → live customer demo in 10 minutes.', cta: 'Comment "DEMO" to get the full setup',
      spec: `HUB: GTM Orchestrator | reads every merged PR, decides what customers should see | Antigravity, Gemini, MCP, GitHub, Calendar, Slack
Release Intake | one worker per repo and product area | GitHub, Jira, Linear, Slack, Docs | Core, API, Console, Mobile, Billing, Infra, SDK, Docs
Value Lens | rewrites each change for buyer, user and partner | Gemini, Docs, Sheets | CFO, User, Partner
Demo Capture | records the real UI flow, no slides | Playwright, Veo, Imagen | Recorder, Narrator
Enablement | 1-page brief, FAQ, objection handling | Docs, Slides, Gmail | Brief, FAQ, Deck
Distribution | sales Slack, CRM notes, customer email | Slack, Salesforce, Gmail, LinkedIn | AE Feed, CRM, Email`
    },
    agency: {
      brand: 'BUILT WITH ANTIGRAVITY', title: 'The {Agency Margin} Factory', subtitle: '1 orchestrator for 15 AI workers. A 15-hour client deliverable in 12 minutes, with human QA.', cta: 'Comment "MARGIN" to get the full setup',
      spec: `HUB: Account Orchestrator | one brain per client: brand, history, approvals | Antigravity, Gemini, MCP, Drive, Slack, HubSpot
Client Ops | one worker per client, with its own context | Slack, Gmail, Drive, Notion, HubSpot, Calendar, Meet, Docs | Acme, Northwind, Globex, Initech, Umbrella, Hooli, Vandelay, Private
Research | positioning audit, competitor gaps, search demand | Google Search, NotebookLM, Perplexity | Audit, Competitors
Creative | hooks, angles, ROI math, 3 brand-safe variants | Gemini, Imagen, Canva | Copy, Visual, ROI
Reporting | daily recap: sent, replies, pipeline | Sheets, Looker, Slack | Recap, Pipeline, Alerts
QA Gate | human approval before anything ships | Slack, Docs, Gmail | Reviewer, Legal, Client`
    },
    spotify: {
      brand: 'OUTLIER PLAYBOOK · CREDIT: AAKASH GUPTA / SPOTIFY', title: 'The {Token Budget} Factory', subtitle: '1 cost gate for 13 AI workers. The 5 moves behind a 90% cut in the agent bill.', cta: 'Comment "TOKENS" to get the checklist',
      spec: `HUB: Cost Gate | every agent run passes one budget check before it reads anything | Antigravity, Gemini, MCP, BigQuery, Sheets
Trace Intake | split last week's traces: reading vs reasoning | Cloud Logging, BigQuery, Sheets, Looker | Reads, Reasoning, Tool Calls, Retries, Caching, Errors, Latency, Cost
Cheap Readers | files over ~350 lines go to a small model | Gemini Flash, Flash-Lite | Reader A, Reader B
Cache | system prompts, policies and docs cached once | Context Cache, Redis, Drive | System, Policy, Docs
Budget | a cost ceiling and an alert for every workflow | Sheets, Looker, Slack | Ceiling, Alert, Report
Enforce in Code | a hook that blocks the read, not a prompt note | GitHub, Hooks, CI, MCP | Pre-read Hook, Linter, CI`
    },
    evals: {
      brand: 'OUTLIER PLAYBOOK · CREDIT: HAMEL HUSAIN', title: 'The {Evals for PMs} Factory', subtitle: '1 eval owner (you) and 14 AI workers. No code. 6 steps from real asks to pass/fail.', cta: 'Comment "EVALS" to get the template',
      spec: `HUB: Eval Owner (you) | reads outputs, writes pass/fail, decides what ships | Sheets, Docs, Gemini, MCP, GitHub
Real Asks | 30 real prompts, including the messy ones | Gmail, Slack, Support, Forms, Docs | Sales, Support, Ops, Legal, Finance, HR, Eng, Exec
Read Outputs | note what went wrong, in plain words | Sheets, Docs | Reader, Notes
Group Failures | 3–5 repeat problems = your first evals | Sheets, Gemini | Clusters, Labels, Severity
Pass / Fail | "Did it cite the source?" yes or no | Sheets, GitHub, CI | Assertions, Golden Set, Runner
Human Check | where a wrong answer costs the most | Slack, Docs, Gmail | Reviewer, Escalation, Sign-off`
    },
    humancheck: {
      brand: 'OUTLIER PLAYBOOK · CREDIT: ETHAN MOLLICK', title: 'The {Human Check} Factory', subtitle: '1 queue owner for 13 AI workers. "A human checks everything" is a queue, not a quality plan.', cta: 'Comment "CHECK" to get the playbook',
      spec: `HUB: Queue Owner | routes each output to sample, review or auto-ship by risk | Antigravity, Gemini, MCP, Sheets, Slack
Output Intake | one worker per workflow feeding the queue | Gmail, Docs, Slides, Sheets, GitHub, Slack, Support, Forms | Email, Memo, Deck, Report, Code, Reply, Ticket, Form
Risk Score | cost of a wrong answer, per output type | Gemini, Sheets | Scorer, Policy
Sample | low risk: review 1 in 20, track the miss rate | Sheets, Looker | Sampler, Tracker
Full Review | high risk: a named human signs off | Docs, Slack, Gmail | Legal, Finance, Exec
Learn | every miss becomes an eval and a prompt fix | GitHub, Sheets, CI | Eval, Prompt, Retro`
    }
  };

  return { draw, parseSpec, PRESETS, TOOLS, FRAMES: 32, DELAY_CS: 10 };
})();
