/* Signal50 Converter v2: from a breakout post to a draft in Afrina's voice.
   - Hook model: technique detector + per-technique lift measured on the live corpus + exemplar retrieval + scorer.
   - Draft: grounded in what the source post actually argues; anything only Afrina can know is left as a [bracket], never invented.
   - Never emits internal terms (outlier, multiplier, HarvestAPI, z-score, rarity) in anything meant for LinkedIn. */
window.Signal50Converter = (() => {
  'use strict';

  // ------------------------------------------------------------------ techniques
  const TECHNIQUES = {
    specific_surprise: { name: 'Specific surprise', what: 'A named company or person plus one concrete number that breaks an expectation.', when: 'The source post has a real number tied to a real name.', needs: ['concrete'] },
    stakes_first: { name: 'Stakes first', what: 'Open on the decision or cost the reader is about to make, then the one fact that changes it.', when: 'The reader is about to spend money, time or headcount on this.', needs: [] },
    insider_access: { name: 'Insider access', what: 'A first-hand moment with a named person, company or room most readers never get into.', when: 'You were actually there. Never borrow someone else\'s access.', needs: ['firsthand'] },
    news_take: { name: 'News plus take', what: 'Something just shipped or broke, then the one thing most people will miss about it.', when: 'The source is under a week old and names what happened.', needs: ['entity'] },
    story_open: { name: 'Story cold open', what: 'A line of dialogue or a scene, then why it matters.', when: 'You have a real moment to tell, in one line.', needs: ['firsthand'] },
    contrarian_reveal: { name: 'Contrarian reveal', what: 'Name the belief most people in the role hold, then what the evidence says instead.', when: 'The source overturns a common assumption.', needs: [] },
    shift_observation: { name: 'Shift observation', what: 'Name a change that happened in the last year, in plain words, then what it means.', when: 'The source is about a trend rather than one event.', needs: [] },
    scale_vs_gap: { name: 'Scale, then the gap', what: 'Line one: a big public number. Line two: the gap nobody has closed. Afrina\'s house pattern.', when: 'Default when the source gives you a scale fact.', needs: ['concrete'] }
  };
  const ORDER = Object.keys(TECHNIQUES);
  const ANNOUNCE = /\b(happy to share|excited to (share|announce)|thrilled to|i['’]m (now )?(joining|working at)|i['’]ve joined|i have joined|new chapter|woo hoo|congrats|congratulations|we['’]re hiring|i['’]m hiring)\b/i;
  const BRANDS = /\b(Google|Gemini|OpenAI|ChatGPT|GPT-?\d?\w*|Anthropic|Claude|Meta|Llama|Microsoft|Copilot|Amazon|AWS|Apple|Nvidia|NVIDIA|DeepSeek|Mistral|Cursor|Perplexity|Notion|Figma|Stripe|Spotify|Walmart|Netflix|Airbnb|Uber|Shopify|HubSpot|Salesforce|Slack|LinkedIn|YouTube|MIT|Stanford|Harvard|Y Combinator|Sam Altman|Jensen Huang|Satya Nadella|Sundar Pichai|Demis Hassabis|Andrej Karpathy|Dario Amodei)\b/g;
  const JARGON = /\b(outliers?|harvest ?api|multiplier|z[- ]?score|rarity|baseline median|weighted score|replicable|subagent|archetype|alchemi[sz]e)\b|\(\s*\d+(?:\.\d+)?x[^)]*\)|\b\d+(?:\.\d+)?x\s+(?:their|its|his|her)\b|\b\d+(?:\.\d+)?x\b(?=[^\n]{0,30}\b(?:baseline|median|usual|engagement)\b)/i;
  const BANNED = ['delve', 'tapestry', 'testament', 'game-changer', 'game changer', 'unlock', 'landscape', 'thrilled to announce', 'leverage', 'seamless', 'cutting-edge', 'revolutionary', 'in today\'s fast-paced', 'navigate the', 'elevate'];
  const NUM_RE = /(?:\$|€|£)?\d[\d,]*(?:\.\d+)?\s?(?:%|percent|x\b|k\b|m\b|bn?\b|million|billion|trillion|hours?|hrs?|days?|weeks?|months?|years?|yrs?|minutes?|mins?|seconds?|secs?|ms\b|engineers?|PMs?|people|users?|customers?|companies|tokens?|lines?|steps?|rows?|requests?|calls?|prompts?|evals?|points?|slides?|words?)?/g;

  // ------------------------------------------------------------------ feature extraction
  function firstLine(text) { return String(text || '').replace(/\r/g, '').split('\n').map(s => s.trim()).find(Boolean) || ''; }
  function sentences(s) { return String(s || '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])|(?<=[\u{1F300}-\u{1FAFF}\u2600-\u27BF]\uFE0F?)\s+(?=[A-Z])/u).map(x => x.trim()).filter(Boolean); }
  function words(s) { return String(s || '').trim().split(/\s+/).filter(Boolean); }
  function cap(s) { s = String(s || '').trim(); return s ? s[0].toUpperCase() + s.slice(1) : s; }
  function stripEnd(s) { return String(s || '').trim().replace(/[\s.:;,–—-]+$/, ''); }
  function clean(s) { return String(s || '').replace(/\s+/g, ' ').replace(/\s([,.;:!?])/g, '$1').trim(); }

  function numberFacts(text) {
    const out = []; const t = String(text || '').replace(/\s+/g, ' ');
    let m; const re = new RegExp(NUM_RE.source, 'g');
    while ((m = re.exec(t))) {
      const raw = m[0].trim().replace(/[,.;:]+$/, ''); if (!raw || /^\d{1,2}$/.test(raw)) continue;
      if (/^(19|20)\d\d$/.test(raw)) continue;
      const start = Math.max(0, m.index - 48), end = Math.min(t.length, m.index + raw.length + 56);
      let ctx = t.slice(start, end).trim();
      ctx = ctx.replace(/^\S*\s/, m.index - 48 > 0 ? '' : '').replace(/\s\S*$/, end < t.length ? '' : '');
      out.push({ value: raw, context: ctx });
      if (out.length >= 6) break;
    }
    return out;
  }
  function entities(text) {
    const found = new Map(); const t = String(text || '');
    let m; const re = new RegExp(BRANDS.source, 'g');
    while ((m = re.exec(t))) found.set(m[0], (found.get(m[0]) || 0) + 2);
    // capitalised words not at a sentence start (names, products)
    const re2 = /(?<=[a-z0-9,;]\s)([A-Z][a-zA-Z0-9+.-]{2,}(?:\s[A-Z][a-zA-Z0-9+.-]{2,})?)/g;
    while ((m = re2.exec(t))) { const w = m[1]; if (!/^(The|And|But|Here|This|That|What|When|Why|How|If|In|On|At|For|With|Most|Every|Your|You|It|We|My|Our|AI|PM|PMs|CEO|CTO|API|LLM|LLMs|OK)$/.test(w)) found.set(w, (found.get(w) || 0) + 1); }
    return [...found.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]).slice(0, 5);
  }
  function hookFeatures(hook, full) {
    const h = String(hook || ''); const f = firstLine(h) || h; const low = f.toLowerCase();
    const ents = entities(h); const nums = numberFacts(h);
    return {
      line: f, lines: h.split('\n').filter(s => s.trim()).length, len: h.length,
      entity: ents.length > 0, entities: ents, number: nums.length > 0, numbers: nums,
      firstPerson: /^(i|i'm|i’m|i've|i’ve|my|we|we've|we’ve|our|had|spent|met|asked|sat|watched|talked|shipped|built)\b/i.test(f),
      firsthandVerb: /\b(had a|met|asked|sat (down|in)|talked (to|with)|spent \d+|i (ran|built|shipped|watched|tested|interviewed)|q&a|at (google|openai|anthropic|meta|microsoft|amazon|apple|nvidia|stripe)\b)/i.test(h),
      stakes: /^(before you|if you('re| are| want| plan)|don't|stop|read this|think twice|warning)/i.test(f) || /\bbefore you\b|\bread this\b/i.test(f),
      news: /\b(just|today|this morning|announced|announces|released|releases|launched|launches|quietly|breaking|dropped|shipped)\b/i.test(f),
      story: /^["“]/.test(f) || /\b(asked|said|told me|whispered|replied)\b/.test(f) || /\b(last (week|month|night|year)|yesterday|this morning|in 20\d\d|years ago|months ago)\b/i.test(f),
      contrarian: /\b(secret|unpopular|myth|wrong|nobody tells you|no one tells you|stop|isn['’]t|aren['’]t|don['’]t need|doesn['’]t|not the|never|overrated|the truth|lie|still (think|believe|treat|assume)|the opposite)\b/i.test(f) && !/^before you/i.test(f),
      absolute: /\b(most|every|everyone|all|always|nobody|no one|the only)\b/i.test(f),
      shift: /\b(changed|changing|shift|shifted|moment|era|is here|no longer|used to|past (year|12 months|few months)|this year|in the last)\b/i.test(f),
      question: /\?/.test(f),
      colon: /:\s*$/.test(f),
      short: f.length <= 60,
      announce: ANNOUNCE.test(f),
      gapWords: /\b(and yet|yet|but|still|only|meanwhile|while most|most teams|nobody|no one)\b/i.test(h.split('\n').slice(1).join(' ') || '')
    };
  }

  function detect(hook) {
    const F = hookFeatures(hook);
    const s = {}; const ev = {}; const add = (id, pts, why) => { s[id] = (s[id] || 0) + pts; (ev[id] = ev[id] || []).push(why); };
    if (F.entity && F.number) add('specific_surprise', 3, `names ${F.entities[0]} and gives a number (${F.numbers[0].value})`);
    else if (F.number && F.absolute) add('specific_surprise', 1.5, `a number (${F.numbers[0].value}) framed against "${F.line.match(/\b(most|every|everyone|all|always|nobody|no one|the only)\b/i)[0]}"`);
    if (F.stakes) add('stakes_first', 3, 'opens on the reader\'s decision or cost');
    if (F.firsthandVerb && (F.entity || F.firstPerson)) add('insider_access', 3, 'first-hand access to a named person or company');
    else if (F.firstPerson && F.entity) add('insider_access', 1.5, 'first person plus a named entity');
    if (F.news && F.entity) add('news_take', 3, 'something a named company just did');
    else if (F.news) add('news_take', 1.5, 'time-sensitive wording');
    if (F.story) add('story_open', F.line.startsWith('"') || F.line.startsWith('“') ? 3 : 2, F.line.startsWith('"') || F.line.startsWith('“') ? 'opens on dialogue' : 'opens inside a moment in time');
    if (F.contrarian) add('contrarian_reveal', F.absolute ? 3 : 2, 'pushes against a common belief');
    if (F.shift) add('shift_observation', 2.5, 'names a change over time');
    if (F.lines >= 2 && F.number && F.gapWords) add('scale_vs_gap', 3, 'scale fact, then a gap line');
    else if (F.number && F.lines >= 2) add('scale_vs_gap', 1, 'two lines with a number first');
    const ranked = ORDER.filter(id => s[id]).map(id => ({ id, name: TECHNIQUES[id].name, score: s[id], evidence: ev[id] })).sort((a, b) => b.score - a.score);
    return { ranked, top: ranked[0] || null, announcement: F.announce, features: F };
  }

  // ------------------------------------------------------------------ corpus stats + exemplars
  let CORPUS = []; let STATS = null;
  function setCorpus(list) {
    CORPUS = (list || []).filter(o => o && (o.text || o.hook)).map(o => {
      const hook = String(o.hook || firstLine(o.text)).slice(0, 210);
      const d = detect(hook);
      return { id: String(o.id || o.url || ''), creator: o.creator || o.creatorName || '', role: o.role || '', url: o.url || o.sourceUrl || '', mult: Number(o.mult || o.multiplier || 0), text: o.text || '', hook, type: o.type || 'playbook', announcement: d.announcement || (o.type === 'announcement'), technique: d.top ? d.top.id : null, postedAt: o.postedAt || '' };
    });
    const pool = CORPUS.filter(o => !o.announcement && o.mult > 0);
    const med = arr => { const a = arr.slice().sort((x, y) => x - y); return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : 0; };
    const base = med(pool.map(o => o.mult));
    STATS = { n: pool.length, baseline: base, techniques: ORDER.map(id => { const S = pool.filter(o => o.technique === id); return { id, name: TECHNIQUES[id].name, n: S.length, median: S.length ? med(S.map(o => o.mult)) : 0, share3: S.length ? S.filter(o => o.mult >= 3).length / S.length : 0 }; }), untagged: pool.filter(o => !o.technique).length };
    return STATS;
  }
  function stats() { return STATS; }
  function exemplars(techId, k = 4, excludeCreator = '') {
    const seen = new Set(); const out = [];
    for (const o of CORPUS.filter(o => !o.announcement && o.technique === techId && o.creator !== excludeCreator).sort((a, b) => b.mult - a.mult)) {
      if (seen.has(o.creator)) continue; seen.add(o.creator); out.push(o); if (out.length >= k) break;
    }
    return out;
  }

  // ------------------------------------------------------------------ what the source post argues
  const THEMES = [
    { id: 'agents', re: /\b(agents?|agentic|tool calls?|mcp|orchestrat|autonom|workflow|automation)/i, audience: 'teams building agents', decision: 'ship your next agent', belief: 'a better model fixes a flaky agent', shift: 'what an agent is trusted to do without a person watching', gap: 'Most agent demos never meet a real workflow.', actions: ['Put the human check at the one irreversible step, not on every step.', 'Log every tool call so a failure can be replayed instead of guessed at.'], couplet: ['An agent that cannot be checked will not be trusted.', 'Trust is the feature.'], question: 'Where does the human check sit in your agent workflow today?' },
    { id: 'cost', re: /\b(tokens?|latency|bill|cost|spend|p95|cheaper|expensive|budget|margin|inference)/i, audience: 'AI product teams', decision: 'pay next month\'s model bill', belief: 'the model is the expensive part', shift: 'how AI teams pay for inference', gap: 'Most teams never look at where the tokens actually go.', actions: ['Trace one real task end to end and count where the tokens go before touching a prompt.', 'Route the reading and filtering to a cheap model; keep the frontier model for judgment.'], couplet: ['The model is rarely the expensive part.', 'The workflow around it is.'], question: 'Where is your AI workflow leaking the most tokens or time right now?' },
    { id: 'evals', re: /\b(evals?|evaluation|benchmark|test set|golden set|accuracy|hallucinat|regression)/i, audience: 'AI teams', decision: 'ship your next prompt change', belief: 'evals are a QA step you add at the end', shift: 'how AI teams decide a change is safe to ship', gap: 'Most teams still ship on vibes.', actions: ['Write five pass or fail checks from real failures before the next prompt change.', 'Run them on every change, in the pull request, not in a quarterly review.'], couplet: ['Evals are not a QA step.', 'They are how you know what you shipped.'], question: 'What does your team check before a prompt or model change goes live?' },
    { id: 'pm', re: /\b(product managers?|PMs?|roadmaps?|strategy|prioriti|stakeholders?|discovery|ratio)\b/i, audience: 'product managers', decision: 'write your next roadmap', belief: 'AI makes the PM less important', shift: 'what a PM is expected to do on an AI team', gap: 'Most roadmaps still assume the model is the hard part.', actions: ['Write the eval before the PRD; it is the clearest spec you will ever ship.', 'Own the failure cases, not just the happy-path demo.'], couplet: ['Product judgment did not get automated.', 'It got more expensive to skip.'], question: 'How has AI changed what you expect from a PM on your team?' },
    { id: 'career', re: /\b(hiring|hired|interviews?|careers?|jobs?|promotion|resume|layoffs?|salary|headcount)\b/i, audience: 'people in tech', decision: 'take the next AI role', belief: 'the old career ladder applies', shift: 'what companies hire for in AI roles', gap: 'Most career advice was written for a job market that no longer exists.', actions: ['Show one shipped thing instead of one more certificate.', 'Learn to read an eval and a cost trace; both are now part of the job.'], couplet: ['The title matters less every year.', 'What you can ship matters more.'], question: 'What has changed about how you are hiring or being hired this year?' },
    { id: 'learning', re: /\b(courses?|tutorials?|resources?|curriculum|bootcamp|certif\w*|docs|documentation|learn(ing)? (ai|directly|from)|free)\b/i, audience: 'people learning AI', decision: 'pay for an AI course', belief: 'you need a paid course to learn AI properly', shift: 'where the best AI learning material comes from', gap: 'Most of the best material is free and written by the teams shipping the models.', actions: ['Start from the official docs of one model provider and build one real thing with it.', 'Keep a running list of what you built, not what you watched.'], couplet: ['The best AI education is not behind a paywall.', 'It is in the docs of the people shipping the models.'], question: 'Which free resource taught you the most this year?' },
    { id: 'launch', re: /\b(released?|releasing|launch(ed|ing)?|announc\w*|new model|open[- ]sourc\w*|open-weight|sota|state of the art|version|v\d)\b/i, audience: 'people watching AI news', decision: 'switch models again', belief: 'every new release is worth switching for', shift: 'how fast model releases turn into product changes', gap: 'Most teams will read the headline and change nothing.', actions: ['Run the new model against your own eval set before you believe any benchmark.', 'Change one workflow, measure it for a week, then decide.'], couplet: ['Every launch moves the frontier.', 'Few of them move your product.'], question: 'Which recent launch actually changed something in your stack?' },
    { id: 'writing', re: /\b(writing|write|communicat\w*|memos?|decks?|slides|presentation|storytell\w*)\b/i, audience: 'builders', decision: 'send that memo', belief: 'AI makes writing skill matter less', shift: 'how much of the thinking happens in the writing', gap: 'Most AI output still reads like nobody owned it.', actions: ['Write the one-line claim first; if it does not hold alone, the memo will not either.', 'Cut every sentence the reader could have predicted.'], couplet: ['Clear writing is a product skill.', 'AI raised the floor and the bar.'], question: 'What is the one writing habit that still saves you the most time?' }
  ];
  const GENERAL = { id: 'general', audience: 'AI product teams', decision: 'ship your next AI feature', belief: 'the hard part is the model', shift: 'what it takes to ship an AI feature people keep using', gap: 'Most teams are still solving the wrong half of the problem.', actions: ['Pick one real workflow and measure it before and after.', 'Make the failure visible to the user instead of hiding it.'], couplet: ['The hard part was never the demo.', 'It is what happens after.'], question: 'Where is this showing up in your work right now?' };
  function themeOf(text) { const t = String(text || ''); let best = null, bestN = 0; for (const th of THEMES) { const n = (t.match(new RegExp(th.re.source, 'gi')) || []).length; if (n > bestN) { best = th; bestN = n; } } return best || GENERAL; }

  function normText(t) { return String(t || '').replace(/\r/g, '').replace(/([a-z][.!?])([A-Z])/g, '$1 $2'); }
  const BULLET = /^(\d+[.)]|[-•→↳✅✔▪●◦*]|[\u{1F300}-\u{1FAFF}])\s*/u;
  function isListLine(l) { return BULLET.test(l); }
  function stripBullet(l) { return l.replace(BULLET, ''); }
  function lower1(s, context) {
    s = String(s || ''); if (!s) return s;
    const first = (s.match(/^[^\s]+/) || [''])[0].replace(/[^A-Za-z0-9'’-]/g, '');
    const second = (s.match(/^\S+\s+(\S+)/) || [])[1] || '';
    if (/^[A-Z][A-Z0-9]/.test(first) || /\d/.test(first) || first === 'I' || /^\d/.test(second)) return s;
    if (context) { const capN = (context.match(new RegExp('\\b' + first + '\\b', 'g')) || []).length; const lowN = (context.match(new RegExp('\\b' + first.toLowerCase() + '\\b', 'g')) || []).length; if (capN >= 2 && lowN === 0) return s; }
    if (new RegExp(BRANDS.source).test(first)) return s;
    if (/^[A-Z]/.test(second) && !/^(I|AI|PM|PMs|LLM|LLMs)$/.test(second)) return s;
    if (context && new RegExp('[a-z,;]\\s' + first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(context)) return s;
    return s[0].toLowerCase() + s.slice(1);
  }
  function endDot(s) { s = stripEnd(s); return /[.!?"”]$/.test(s) ? s : s + '.'; }
  function possessive(n) { return /s$/i.test(n) ? n + '’' : n + '’s'; }

  const CLAIM_RE = /\b(but|instead|actually|really|the real|the truth|don['’]t need|doesn['’]t|isn['’]t|aren['’]t|wasn['’]t|never|most|should|stop|wrong|matters|because|means|turns out|the problem|the point|the lesson|the difference|here['’]s why|not about|no longer)\b/i;
  const NOISE_RE = /https?:\/\/|\b(big thanks|shoutout|shout-out|link in|comments? below|in the comments|repost|follow me|dm me|newsletter|subscribe|save this|bookmark this|share this|sign up|link below|check it out|try it|watch me|let me know|thoughts\?)\b/i;
  const PRONOUN_START = /^(?:\S+\s+){0,5}(it|they|them|this|these|those|he|she|that)\b/i;
  function claimScore(s, idx) {
    const w = words(s).length; if (w < 5 || w > 30) return -1;
    if (/\?$/.test(s) || NOISE_RE.test(s)) return -1;
    if (/^(here|so|also|plus|p\.?s\b|ps\b|follow|comment|repost|like|share|dm|link|👇|👉|if you|when you)\b/i.test(s)) return -1;
    let sc = 0;
    if (CLAIM_RE.test(s)) sc += 2;
    if (/\b(i|we|my|our|me)\b/i.test(s)) sc -= 1.5;
    if (PRONOUN_START.test(s)) sc -= 1.5;
    else if (w < 12 && /\b(it|they|them)\b/i.test(s)) sc -= 1;
    if (/^(probably|maybe|perhaps|i think|i guess|honestly)\b/i.test(s)) sc -= 0.5;
    if (numberFacts(s).length) sc += 1;
    if (entities(s).length) sc += 0.5;
    if (w >= 8 && w <= 22) sc += 1;
    return sc - idx * 0.15;
  }
  function pickClaim({ hookLines, bodySentences, proseLines, structure }) {
    const cands = [];
    hookLines.slice(1).forEach((l, i) => sentences(l).forEach(s => cands.push({ s, idx: i })));
    if (structure === 'list') proseLines.forEach((l, i) => sentences(l).forEach(s => cands.push({ s, idx: i + 1 })));
    else bodySentences.slice(0, 8).forEach((s, i) => cands.push({ s, idx: i + 1 }));
    let bi = -1, bestSc = -Infinity;
    cands.forEach((c, i) => { const sc = claimScore(c.s, c.idx); if (sc > bestSc) { bi = i; bestSc = sc; } });
    let best = bi >= 0 ? cands[bi].s : '';
    // a claim that leans on a pronoun needs the sentence before it
    if (bi > 0 && PRONOUN_START.test(best) && words(cands[bi - 1].s).length + words(best).length <= 32 && claimScore(cands[bi - 1].s, 0) >= 0) best = `${endDot(cands[bi - 1].s)} ${best}`;
    if (!best || bestSc < 1) best = hookLines.slice(0, 2).join(' ');
    return clean(best).replace(/^[\-•→↳]\s*/, '').replace(/^(but honestly|honestly|the truth is|here['’]s the thing)[,:]?\s+/i, m => '');
  }

  function extract(item) {
    const text = normText(item.text);
    const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
    const srcLines = lines.length ? lines : normText(item.hook || item.topic || '').split(/\n|\s\/\s/).map(s => s.trim()).filter(Boolean);
    const hookLines = [srcLines[0] || ''];
    if (srcLines[1] && hookLines[0].length < 90 && !isListLine(srcLines[1]) && srcLines[1].length <= 150 && !NOISE_RE.test(srcLines[1])) hookLines.push(srcLines[1]);
    const hook = hookLines.join('\n');
    const truncated = text.length >= 690;
    const letters = w => words(w).filter(x => /[a-z]{2,}/i.test(x)).length;
    const usable = letters(hook) >= 4 && letters(text) >= 25 && !/\b(this meme|made? a meme)\b/i.test(hook);
    const reason = usable ? '' : (item.media && item.media !== 'text' ? 'This is mostly an image or video post. The text we have is too thin to rebuild from, so read the original instead.' : 'The text we have is too thin to rebuild from. Read the original instead.');
    let rest = lines.length ? lines.slice(hookLines.length) : [];
    if (!rest.length && item.insight) rest = [String(item.insight)];
    const listLines = rest.filter(isListLine); const proseLines = rest.filter(l => !isListLine(l));
    const structure = listLines.length >= 3 ? 'list' : (hookFeatures(hook).story ? 'story' : 'prose');
    const bodySentences = proseLines.flatMap(l => sentences(l));
    let points = structure === 'list'
      ? listLines.map(l => clean(stripBullet(l))).filter(l => words(l).length >= 3)
      : bodySentences.filter(s => words(s).length >= 6 && !/\?$/.test(s) && !NOISE_RE.test(s));
    points = points.filter(p => !/https?:\/\//.test(p));
    if (truncated && points.length && !/[.!?)"”]$/.test(points[points.length - 1])) points.pop();
    points = points.map(p => cap(stripEnd(p.replace(/\s*[\u{1F300}-\u{1FAFF}\u2600-\u27BF]\uFE0F?\s*$/u, '')).replace(/^(and|but|so|also|plus)\s+/i, ''))).filter(Boolean).slice(0, 5);
    // fact lines: whole sentences (hook first, then body) that carry a number; never cut mid-sentence
    const factLines = []; const seenF = new Set();
    for (const s of hookLines.flatMap(l => sentences(l)).concat(bodySentences, structure === 'list' ? points : [])) {
      const nums = numberFacts(s); if (!nums.length) continue; const c = clean(s);
      if (c.length < 18 || c.length > 125 || seenF.has(c) || NOISE_RE.test(c)) continue; seenF.add(c);
      factLines.push({ text: stripEnd(c), number: nums[0].value, entity: entities(c)[0] || null }); if (factLines.length >= 6) break;
    }
    const family = (text.match(/\b(my (son|daughter|kid|kids|wife|husband|mom|dad|mother|father|family|parents)|our (son|daughter|kids|child|children)|empty nest\w*|birthday|wedding|anniversary|funeral|passed away|moved? (him|her|them) in|vacation|holiday)\b/gi) || []).length;
    const work = (text.match(/\b(ai|model|models|agents?|product|prompt|eval\w*|tokens?|code|engineer\w*|startup|team|teams|customer\w*|launch\w*|data|llm\w*)\b/gi) || []).length;
    const personal = family >= 1 && work <= 2;
    const idea = personal ? '' : pickClaim({ hookLines, bodySentences, proseLines, structure });
    const ideaFirstPerson = /\b(I|I'm|I’m|I've|I’ve|I'd|I’d|my|me|we|we're|we’re|we've|we’ve|our|us)\b/.test(idea);
    const prose = rest.join(' ');
    const nums = numberFacts(hook + ' ' + prose); const ents = entities(hook + ' ' + prose);
    const theme = themeOf(hook + ' ' + prose);
    const d = detect(hook);
    const topic = clean(hookLines[0] || '').replace(/^["“]|["”]$/g, '').replace(/[.!?:]+$/, '');
    const age = item.age != null && item.age !== '' ? Number(item.age) : (item.postedAt ? Math.round((Date.now() - new Date(item.postedAt).getTime()) / 864e5) : null);
    const when = age == null || Number.isNaN(age) ? 'recently' : age <= 7 ? 'this week' : age <= 35 ? 'recently' : 'a while back';
    return { hook, hookLines, text, usable, reason, personal, ideaFirstPerson, idea: stripEnd(idea), points: personal ? [] : points, factLines: personal ? [] : factLines, numbers: nums, entities: ents, theme, structure, truncated, detection: d, when, topic: topic.length > 90 ? topic.slice(0, 88).replace(/\s+\S*$/, '') : topic };
  }
  function suggestFormat(ex) { if (ex.personal) return 'story'; if (ex.structure === 'list') return /\b(how to|steps?|checklist|runbook|setup|guide|playbook)\b/i.test(ex.hook + ' ' + ex.points.join(' ')) ? 'runbook' : 'teardown'; if (ex.structure === 'story') return 'story'; return 'thesis'; }
  function applicable(id, ex, angle) {
    if (id === 'specific_surprise' || id === 'scale_vs_gap') return !!bestFact(ex, false);
    if (id === 'news_take') { const F = hookFeatures(ex.hookLines[0] || ''); return F.news && F.entity && (ex.hookLines[0] || '').length <= 120; }
    if (id === 'insider_access') return /\b(I|I'm|I’m|I've|I’ve|my|we|we've|we’ve|our)\b/.test(angle || '');
    if (id === 'story_open') return /["“”]|\b(said|asked|told me|replied|texted|wrote me)\b/i.test(angle || '');
    return true;
  }

  // ------------------------------------------------------------------ hook generation + scoring
  function fit(line, max) {
    line = clean(line); if (line.length <= max) return line;
    const head = line.slice(0, max); const sb = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
    if (sb >= max * 0.4) return head.slice(0, sb + 1);
    return stripEnd(head.replace(/\s+\S*$/, '')) + '.';
  }
  function twoLines(a, b) { a = stripEnd(cap(a)); b = cap(clean(b)); if (!/[.!?:"”]$/.test(a)) a += '.'; if (!/[.!?:"”\]]$/.test(b)) b += '.'; let out = `${a}\n${b}`; if (out.length > 210) { b = fit(b, 210 - a.length - 1); out = `${a}\n${b}`; } if (out.length > 210) { a = fit(a, 120); b = fit(b, 210 - a.length - 1); out = `${a}\n${b}`; } return out; }
  function firstSentence(s, max = 120) { const x = sentences(s)[0] || clean(s); return x ? fit(x, max) : ''; }
  function bestFact(ex, needEntity) { const f = ex.factLines.find(f => (!needEntity || f.entity) && !/^(i|we|my|our|before you|if you|read this)\b/i.test(f.text)); return f ? f.text : ''; }

  function generateHooks({ techniques, ex, angle, proof, creator, max = 3 }) {
    const th = ex.theme; const take = angle ? firstSentence(angle, 118) : ''; const proofLine = proof ? firstSentence(proof, 118) : '';
    const claimFor = (lim) => { if (ex.ideaFirstPerson) return th.gap; const c = clean(ex.idea || th.gap); if (c.length <= lim) return c; const f = sentences(c)[0] || c; return f.length <= lim ? f : th.gap; };
    const claimTail = (lim) => { if (ex.ideaFirstPerson) return th.gap; const ss = sentences(clean(ex.idea || '')); const last = ss[ss.length - 1] || ''; return (!last || PRONOUN_START.test(last) || last.length > lim) ? th.gap : last; };
    const gapLine = th.gap;
    const build = {
      specific_surprise: () => { const f = bestFact(ex, true) || bestFact(ex, false); return f ? twoLines(f, take || gapLine) : null; },
      scale_vs_gap: () => { const f = bestFact(ex, false); if (!f) return null; const g = /^(and yet|yet|but|still|most|nobody|no one)\b/i.test(take) ? take : gapLine; return twoLines(f, /^(and yet|yet|but|still)\b/i.test(g) ? g : 'And yet ' + lower1(g)); },
      stakes_first: () => twoLines(`Before you ${th.decision}, read this`, proofLine || claimFor(150)),
      contrarian_reveal: () => twoLines(`Most ${th.audience} still think ${th.belief}`, take || `${creator ? creator + ' makes the opposite case' : 'The evidence points the other way'}: ${lower1(claimTail(110))}`),
      shift_observation: () => twoLines(`Something changed in ${th.shift} this year`, take || claimFor(140)),
      news_take: () => { if (!applicable('news_take', ex, angle)) return null; return twoLines(ex.hookLines[0], take || `What most people will miss: ${lower1(claimFor(120))}`); },
      insider_access: () => twoLines(take || '[Your first-hand moment: where you saw this while building AI products]', claimFor(120)),
      story_open: () => { const q = (angle || '').match(/["“]([^"”]{8,140})["”]/); return twoLines(q ? `"${stripEnd(q[1])}"` : (take ? take : '"[One line someone actually said to you about this]"'), claimFor(120)); }
    };
    const out = []; const seen = new Set();
    for (const id of techniques) { if (!build[id] || out.length >= max) continue; const text = build[id](); if (!text || seen.has(text)) continue; seen.add(text); out.push({ technique: id, text, score: scoreHook(text, id) }); }
    return out;
  }

  function findJargon(text) { const m = String(text || '').match(JARGON); return m ? m[0] : null; }
  function findBanned(text) { const low = String(text || '').toLowerCase(); return BANNED.find(w => low.includes(w)) || null; }
  function scoreHook(text, techId) {
    const t = String(text || ''); const lines = t.split('\n').filter(s => s.trim()); const d = detect(t); const F = d.features;
    const need = (TECHNIQUES[techId] || {}).needs || [];
    const techOk = !techId || d.ranked.slice(0, 2).some(r => r.id === techId) || (techId === 'scale_vs_gap' && F.number && lines.length >= 2) || (techId === 'insider_access' && /\[/.test(t)) || (techId === 'story_open' && /^["“]/.test(t));
    const checks = [
      { ok: t.length >= 40 && t.length <= 210, label: `Fits above the fold (${t.length}/210)` },
      { ok: lines.length === 2 && lines.every(l => l.length <= 150), label: 'Two lines' },
      { ok: techOk, label: techId ? `Follows "${TECHNIQUES[techId].name}"` : 'Follows a technique' },
      { ok: !need.includes('concrete') || F.number || F.entity, label: 'Has a concrete number or name' },
      { ok: !findJargon(t), label: 'No internal terms' },
      { ok: !findBanned(t), label: 'No filler words' },
      { ok: !/\[[^\]]+\]/.test(t), label: /\[[^\]]+\]/.test(t) ? 'Fill the [bracket] with your own moment' : 'Nothing left to fill' }
    ];
    return { ok: checks.every(c => c.ok), checks, score: Math.round(checks.filter(c => c.ok).length / checks.length * 100) };
  }

  // ------------------------------------------------------------------ body + comment
  function buildBody({ format, ex, angle, proof, creator }) {
    const th = ex.theme; const name = creator || 'the author';
    const claim = endDot(ex.idea || th.gap); const ctx = ex.text || (ex.hook + ' ' + ex.points.join(' '));
    const angleText = angle ? endDot(clean(angle)) : '[Your first-hand take: what you have seen building AI products that confirms or complicates this. One or two sentences.]';
    const proofText = proof ? endDot(clean(proof)) : '';
    const pts = (ex.points.length ? ex.points : [ex.idea]).map(p => endDot(p));
    const fresh = pts.filter(p => !claim.toLowerCase().includes(stripEnd(p).slice(0, 40).toLowerCase()));
    const bullets = (fresh.length ? fresh : pts);
    const credit = `Credit to ${name} for the original post. Link in the first comment.`;
    const closer = `${th.couplet[0]}\n${th.couplet[1]}`;
    const claimText = ex.ideaFirstPerson ? `“${claim}”` : lower1(claim, ctx);
    const opener = format === 'thesis' ? `${name} wrote something ${ex.when} that I have not stopped thinking about: ${claimText}` : `${name} made a point ${ex.when} that most ${th.audience} will scroll past: ${claimText}`;
    let parts;
    if (format === 'thesis') {
      parts = [opener, angleText, `${possessive(name)} argument, in ${Math.min(3, bullets.length) === 1 ? 'one line' : Math.min(3, bullets.length) + ' lines'}:\n${bullets.slice(0, 3).map(p => `• ${p}`).join('\n')}`, proofText, `What changes if you take it seriously:\n• ${th.actions[0]}\n• ${th.actions[1]}\n• [One concrete change you would make in your own team this quarter]`, closer, credit, th.question];
    } else if (format === 'runbook') {
      const steps = pts.slice(0, 5).map((p, i) => `${i + 1}. ${cap(p.replace(/^(you should|you need to|make sure to)\s+/i, ''))}\n↳ [How you would do this in practice, with a number if you have one]`);
      parts = [`${name} laid out something most ${th.audience} learn the expensive way: ${claimText}`, angleText, `The runbook, as the post argues it, with what I would add from building AI products:\n\n${steps.join('\n\n')}`, proofText, closer, credit, th.question];
    } else if (format === 'story') {
      parts = [angle ? endDot(clean(angle)) : '[Open with the moment: where you were, who said what, in two or three sentences.]', ex.personal ? `${name} used the same move ${ex.when}: open on one real line someone said, then say what it changed. The story was personal; the move is the lesson.` : `It is the same thing ${name} wrote about ${ex.when}: ${claimText}`, ex.personal ? '' : bullets.slice(0, 3).map(p => `• ${p}`).join('\n'), proofText, `What I took from it:\n${closer}`, credit, th.question];
    } else {
      const items = pts.slice(0, 5).map((p, i) => `${i + 1}. ${p}\n↳ [Why this matters in your experience, or delete the line]`);
      parts = [opener, angleText, `What the post actually argues, and what I would add from building AI products:\n\n${items.join('\n\n')}`, proofText, closer, credit, th.question];
    }
    return scrub(parts.filter(Boolean).join('\n\n'));
  }
  function buildComment({ creator, url }) { return `Credit to ${creator || 'the original author'} for the post that sparked this one${url ? `: ${url}` : ''}.\n\nEvery Saturday I write about how AI products actually get built: https://www.linkedin.com/in/afrina-m/`; }
  function scrub(text) {
    return String(text || '')
      .replace(/\s*\(\s*\d+(?:\.\d+)?x[^)]*\)/gi, '')
      .replace(/\b\d+(?:\.\d+)?x\s+(?:their|its|his|her)\s+(?:baseline|median|usual)(?:\s+engagement)?/gi, 'well above their usual reach')
      .replace(/\s*[—–-]?\s*verified via HarvestAPI/gi, '')
      .replace(/\bHarvestAPI\b[^.\n]*/gi, '')
      .replace(/\boutlier post\b/gi, 'post').replace(/\boutliers\b/gi, 'breakout posts').replace(/\boutlier\b/gi, 'breakout post')
      .replace(/\b(MAD z[- ]?score|z[- ]?score|rarity|multiplier)\b[^.\n]*/gi, '')
      .replace(/[ \t]{2,}/g, ' ').replace(/ \./g, '.').replace(/\n{3,}/g, '\n\n').trim();
  }
  function qaPost(post) {
    const all = `${(post.hooks || [])[post.selectedHook || 0] || ''}\n${post.body || ''}\n${post.comment || ''}`;
    const j = findJargon(all); const b = findBanned(all);
    return [{ ok: !j, label: j ? `Internal term in the post: "${j}"` : 'No internal terms' }, { ok: !b, label: b ? `Filler word: "${b}"` : 'No filler words' }];
  }

  // ------------------------------------------------------------------ Gemini (optional, BYO key)
  function geminiPrompt({ ex, creator, url, format, techIds, angle, proof, exemplarMap }) {
    const techBlock = techIds.map(id => { const t = TECHNIQUES[id]; const exs = (exemplarMap[id] || []).map(e => `   - "${e.hook.replace(/\s+/g, ' ').slice(0, 170)}" (${e.creator})`).join('\n'); return `- ${t.name}: ${t.what}\n  Hooks that used it well (study the move, do not copy the words):\n${exs || '   - (no examples in corpus)'}`; }).join('\n');
    return `You are co-writing a LinkedIn post for Afrina M, Senior PM at Google working on Gemini and AI agents, 15+ years building product. Plain English, specific, no hype. She credits the creator whose post sparked hers.

SOURCE POST (by ${creator}${url ? ', ' + url : ''}). Use its argument, not its sentences:
"""
${String(ex.hook)}
${ex.points.map(p => '- ' + p).join('\n')}
"""
What it argues in one line: ${ex.idea}
Numbers it uses (only these may appear as facts about the source): ${ex.numbers.map(n => n.value + ' (' + n.context + ')').join('; ') || 'none'}

AFRINA'S ANGLE (first-hand, use it): ${angle || 'not provided. Do NOT invent first-hand experience; leave [bracketed prompts] where only she can fill it.'}
A NUMBER OR EXAMPLE SHE CAN STAND BEHIND: ${proof || 'not provided. Do NOT invent one.'}

HOOK TECHNIQUES TO USE, one per hook, in this order:
${techBlock}

FORMAT: ${format === 'runbook' ? 'Builder runbook: 1 framing sentence, 3-5 numbered steps each with a "↳" line of how-to, a two-line closer, a credit line, one question.' : format === 'thesis' ? 'Sharp thesis: no numbered list. Two short paragraphs (the claim, why it matters now), 3 bullets on what changes, a two-line closer, a credit line, one question.' : format === 'story' ? 'Story: open inside the moment from her angle, connect to the source\'s point, 3 bullets, a two-line closer, a credit line, one question.' : 'Teardown: 1 framing sentence naming the source\'s point, 3-5 numbered points of what it argues each with a "↳" line adding her perspective, a two-line closer, a credit line, one question.'}

HARD RULES:
1. Each hook: exactly 2 lines, total <= 200 characters, follows its technique, contains a concrete name or number when the technique calls for one.
2. Never use these words: outlier, multiplier, baseline, HarvestAPI, z-score, rarity, delve, tapestry, testament, game-changer, unlock, leverage, seamless, cutting-edge, thrilled to announce. Never mention engagement multiples or how the post was found.
3. Never invent Afrina's experiences, customers, metrics or quotes. Anything only she can supply goes in [square brackets] as a prompt.
4. No revenue, ARR, usage metrics, quotas, CSAT or internal Google information. Public facts only.
5. Credit line in the body: "Credit to ${creator} for the original post. Link in the first comment." No numbers in it.
6. End with one specific question. No emoji footer, no hashtags wall.

Return JSON only: {"hooks":[{"technique":"<technique id>","text":"line 1\\nline 2"}],"body":"...","comment":"first comment: credit + link + one-line newsletter invite"}`;
  }
  async function draftWithGemini(ctx, key, model) {
    const prompt = geminiPrompt(ctx);
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.5, responseMimeType: 'application/json' } }) });
    if (!r.ok) throw new Error(`Gemini HTTP ${r.status}: ${(await r.text()).slice(0, 140)}`);
    const j = await r.json(); const raw = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    const parsed = JSON.parse(raw.replace(/^```json\s*|```\s*$/g, '').trim());
    const hooks = Array.isArray(parsed.hooks) ? parsed.hooks.map(h => ({ technique: ORDER.includes(h.technique) ? h.technique : null, text: String(h.text || '').trim().slice(0, 210) })).filter(h => h.text) : [];
    return { hooks, body: typeof parsed.body === 'string' ? scrub(parsed.body) : '', comment: typeof parsed.comment === 'string' ? scrub(parsed.comment) : '' };
  }

  // ------------------------------------------------------------------ UI
  let cfg = { esc: s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]), toast: () => {}, getKey: () => '', resolveModel: null, onDraft: null, dayNames: ['Monday', 'Tuesday', 'Wednesday'] };
  let selected = null, extracted = null, lastDraft = null, allItems = [];
  const $ = id => document.getElementById(id);
  function init(options) { cfg = Object.assign(cfg, options || {}); const f = $('cv-form'); if (f) { f.addEventListener('submit', e => { e.preventDefault(); runDraft(); }); } const s = $('cv-search'); if (s) s.addEventListener('input', () => renderCards(allItems)); const re = $('cv-regen'); if (re) re.onclick = () => { if (lastDraft) { lastDraft.hooks = regenHooks(); renderDraft(lastDraft); } }; }
  function humanX(m) { m = Number(m || 0); if (!(m > 0)) return 'pasted by you'; return m >= 10 ? `${Math.round(m)}x their usual reach` : `${m.toFixed(1)}x their usual reach`; }
  function renderCards(items) {
    allItems = items || []; const box = $('outlier-cards'); if (!box) return; const esc = cfg.esc;
    const q = ($('cv-search') ? $('cv-search').value : '').trim().toLowerCase();
    const list = allItems.filter(o => { if (!q) return true; const d = detect(o.topic || o.hook || ''); return `${o.creator} ${o.role} ${o.topic} ${o.insight} ${d.top ? d.top.name : ''}`.toLowerCase().includes(q); });
    box.innerHTML = list.length ? list.map(o => { const d = detect(o.topic || o.hook || ''); const tech = d.announcement ? null : d.top; const thin = words(String(o.topic || '')).filter(x => /[a-z]{2,}/i.test(x)).length < 4; return `
      <article class="p-3 rounded-xl border ${selected && selected.id === o.id ? 'border-[var(--primary)] bg-[var(--secondary)]' : 'border-[var(--border)]'} space-y-1.5 text-xs">
        <div class="flex flex-wrap justify-between gap-2">
          <span class="font-bold">${esc(o.creator)} <span class="text-[var(--muted-foreground)] font-normal">${esc((o.role || '').split('(')[0].trim())}</span></span>
          <span class="flex items-center gap-1.5">
            ${o.type === 'announcement' || d.announcement ? '<span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[var(--secondary)] text-[var(--muted-foreground)]">Personal news, not reusable</span>' : thin ? '<span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[var(--secondary)] text-[var(--muted-foreground)]">Image post, no text hook</span>' : tech ? `<span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[var(--primary)] text-[var(--primary-foreground)]">${esc(tech.name)}</span>` : '<span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[var(--secondary)]">Technique unclear</span>'}
            <span class="px-2 py-0.5 rounded bg-[var(--secondary)] font-semibold">${esc(humanX(o.mult))}</span>
          </span>
        </div>
        <div class="font-semibold text-sm leading-snug">${esc(String(o.topic || '').split(/\s\/\s|\n/)[0])}</div>
        <div class="text-[var(--muted-foreground)]">${Number(o.likes || 0).toLocaleString('en-US')} reactions, ${Number(o.comments || 0).toLocaleString('en-US')} comments, ${Number(o.reposts || 0).toLocaleString('en-US')} reposts. ${o.age != null ? o.age + ' days ago' : esc(o.date || '')}</div>
        <div class="flex flex-wrap gap-2 pt-0.5">
          <button type="button" data-cv-id="${esc(o.id)}" class="px-2.5 py-1 rounded bg-[var(--primary)] text-[var(--primary-foreground)] font-semibold">${selected && selected.id === o.id ? 'Selected' : 'Use this post'}</button>
          ${o.url ? `<a href="${esc(o.url)}" target="_blank" rel="noopener" class="px-2.5 py-1 rounded border border-[var(--border)] font-semibold">Read the original</a>` : ''}
        </div>
      </article>`; }).join('') : `<div class="p-3 rounded-xl border border-dashed border-[var(--border)] text-xs text-[var(--muted-foreground)]">No posts match. Clear the search or run a new scan.</div>`;
    box.querySelectorAll('[data-cv-id]').forEach(b => { b.onclick = () => { const o = allItems.find(v => v.id === b.dataset.cvId); if (o) select(o); }; });
  }
  function select(item) {
    selected = item; extracted = extract(item); lastDraft = null;
    renderCards(allItems); renderWhy(); const form = $('cv-step3'); if (form) form.classList.toggle('hidden', !extracted.usable); const d = $('cv-draft'); if (d) { d.innerHTML = ''; d.classList.add('hidden'); }
    const fmt = $('cv-format'); if (fmt) fmt.value = 'auto'; const techSel = $('cv-technique'); if (techSel) techSel.value = 'source';
    const why = $('cv-why'); if (why) why.scrollIntoView({ behavior: 'smooth', block: 'start' });
    cfg.toast(extracted.usable ? `Loaded ${item.creator}'s post. Add your angle in step 3, then write the draft.` : `${item.creator}'s post has too little text to rebuild from.`);
  }
  function statLine(id) { const s = STATS && STATS.techniques.find(t => t.id === id); return s && s.n >= 5 ? `${s.n} posts in your corpus use it; median ${s.median.toFixed(1)}x their usual, ${Math.round(s.share3 * 100)}% beat 3x` : 'too few posts in your corpus to measure'; }
  function renderWhy() {
    const box = $('cv-why'); if (!box || !extracted) return; const esc = cfg.esc; const ex = extracted; const d = ex.detection; const top = d.top;
    const exs = top ? exemplars(top.id, 3, selected.creator) : [];
    box.innerHTML = `
      <div class="flex flex-wrap items-baseline justify-between gap-2"><h3 class="text-base font-bold">2. Why it worked</h3><span class="text-xs text-[var(--muted-foreground)]">${esc(selected.creator)}, ${esc(humanX(selected.mult))}</span></div>
      <blockquote class="border-l-2 border-[var(--primary)] pl-3 text-sm whitespace-pre-wrap">${esc(ex.hook)}</blockquote>
      ${ex.usable ? '' : `<div class="p-3 rounded-lg bg-[var(--secondary)] text-xs">${esc(ex.reason)}</div>`}
      ${ex.personal ? '<div class="p-3 rounded-lg bg-[var(--secondary)] text-xs">A personal story. Borrow the move (how it opens, how it lands), not the content. Your draft will lean on your own angle.</div>' : ''}
      <div class="grid md:grid-cols-2 gap-3 text-xs">
        <div class="space-y-1">
          <div class="font-semibold">Hook technique: ${d.announcement ? 'personal news (a spike you cannot reuse)' : top ? esc(top.name) : 'no clear technique'}</div>
          ${top ? `<div class="text-[var(--muted-foreground)]">${esc(TECHNIQUES[top.id].what)}</div><ul class="list-disc pl-4 text-[var(--muted-foreground)]">${top.evidence.map(e => `<li>${esc(cap(e))}</li>`).join('')}</ul><div class="text-[var(--muted-foreground)]">${esc(statLine(top.id))}.</div>` : ''}
          ${d.ranked.length > 1 ? `<div class="text-[var(--muted-foreground)]">Also present: ${d.ranked.slice(1, 3).map(r => esc(r.name)).join(', ')}.</div>` : ''}
          <div class="text-[var(--muted-foreground)]">First line ${ex.hook.split('\n')[0].length} characters, ${ex.hook.length <= 210 ? 'fits' : 'does not fit'} above the fold.</div>
        </div>
        <div class="space-y-1">
          <div class="font-semibold">What the post argues</div>
          <div>${esc(ex.idea)}</div>
          ${ex.points.length ? `<ol class="list-decimal pl-4 text-[var(--muted-foreground)]">${ex.points.map(p => `<li>${esc(p)}</li>`).join('')}</ol>` : ''}
          ${ex.factLines.length ? `<div class="text-[var(--muted-foreground)]">Facts it leans on: ${ex.factLines.slice(0, 3).map(f => `<strong>${esc(f.text)}</strong>`).join(' ')}</div>` : '<div class="text-[var(--muted-foreground)]">No concrete numbers in the text we have, so the number-led hooks are skipped.</div>'}
          ${ex.truncated ? '<div class="text-[var(--muted-foreground)]">We only hold the first 700 characters. Read the original before you publish.</div>' : ''}
        </div>
      </div>
      ${exs.length ? `<div class="text-xs"><div class="font-semibold mb-1">Other hooks that used the same technique</div><ul class="space-y-1">${exs.map(e => `<li class="flex gap-2"><span class="shrink-0 px-1.5 rounded bg-[var(--secondary)] font-semibold">${esc(humanX(e.mult))}</span><span>${esc(e.hook.split('\n')[0].slice(0, 150))} <span class="text-[var(--muted-foreground)]">(${esc(e.creator)})</span></span></li>`).join('')}</ul></div>` : ''}`;
    // technique select
    const sel = $('cv-technique'); if (sel) { sel.innerHTML = `<option value="source">Same as the source${top ? ` (${esc(top.name)})` : ''}</option>` + ORDER.map(id => `<option value="${id}">${esc(TECHNIQUES[id].name)}</option>`).join(''); }
    const fmtHint = $('cv-format-hint'); if (fmtHint) fmtHint.textContent = `Auto picks ${({ teardown: 'a teardown', runbook: 'a runbook', thesis: 'a thesis', story: 'a story' })[suggestFormat(ex)]} because the source reads as ${ex.structure === 'list' ? 'a list' : ex.structure === 'story' ? 'a story' : 'prose'}.`;
  }
  function chosenTechniques() {
    const d = extracted.detection; const pick = ($('cv-technique') || {}).value || 'source'; const angle = ($('cv-angle') || {}).value || '';
    const first = pick === 'source' ? (d.top && !d.announcement ? d.top.id : 'scale_vs_gap') : pick;
    const byStat = (STATS ? STATS.techniques.filter(t => t.n >= 8).sort((a, b) => b.median - a.median).map(t => t.id) : ORDER);
    const list = [first];
    for (const id of ['scale_vs_gap'].concat(byStat, ['stakes_first', 'contrarian_reveal', 'shift_observation', 'specific_surprise', 'news_take', 'insider_access', 'story_open'])) if (!list.includes(id) && applicable(id, extracted, angle)) list.push(id);
    return list;
  }
  function regenHooks() { const techs = chosenTechniques(); return generateHooks({ techniques: techs, ex: extracted, angle: ($('cv-angle') || {}).value || '', proof: ($('cv-proof') || {}).value || '', creator: selected.creator }); }
  async function runDraft() {
    if (!extracted) { cfg.toast('Pick a post first.'); return; }
    const btn = $('cv-write'); const status = $('cv-status');
    const angle = ($('cv-angle') || {}).value.trim(); const proof = ($('cv-proof') || {}).value.trim();
    const fmtPick = ($('cv-format') || {}).value || 'auto'; const format = fmtPick === 'auto' ? suggestFormat(extracted) : fmtPick;
    const dayIdx = Number(($('cv-day') || {}).value || 0);
    let hooks = generateHooks({ techniques: chosenTechniques(), ex: extracted, angle, proof, creator: selected.creator });
    const techs = hooks.map(h => h.technique);
    let body = buildBody({ format, ex: extracted, angle, proof, creator: selected.creator });
    let comment = buildComment({ creator: selected.creator, url: selected.url });
    let mode = 'local';
    const key = cfg.getKey ? cfg.getKey() : '';
    if (key && cfg.resolveModel) {
      try {
        if (btn) { btn.disabled = true; btn.textContent = 'Writing with Gemini…'; } if (status) status.textContent = 'Gemini is drafting with the technique brief and your angle…';
        const model = await cfg.resolveModel(key);
        const exemplarMap = {}; techs.forEach(id => { exemplarMap[id] = exemplars(id, 4, selected.creator); });
        const g = await draftWithGemini({ ex: extracted, creator: selected.creator, url: selected.url, format, techIds: techs, angle, proof, exemplarMap }, key, model);
        const good = g.hooks.map((h, i) => ({ technique: h.technique || techs[i] || techs[0], text: h.text })).map(h => ({ ...h, score: scoreHook(h.text, h.technique) })).filter(h => h.score.score >= 70);
        if (good.length) hooks = good.concat(hooks.filter(h => !good.some(g2 => g2.technique === h.technique))).slice(0, 3);
        if (g.body) body = g.body; if (g.comment) comment = g.comment; mode = model;
      } catch (e) { if (status) status.textContent = `Gemini failed (${e.message.slice(0, 80)}). Showing the local draft.`; }
      finally { if (btn) { btn.disabled = false; btn.textContent = 'Write the draft'; } }
    }
    lastDraft = { hooks, body, comment, format, dayIdx, mode, technique: techs[0] };
    renderDraft(lastDraft); if (status && mode !== 'local') status.textContent = `Drafted with ${mode}. Every hook was checked against its technique.`; else if (status) status.textContent = 'Drafted locally from the source post and your angle. Add a free Gemini key in the Calendar tab for a fuller rewrite.';
  }
  function renderDraft(d) {
    const box = $('cv-draft'); if (!box) return; const esc = cfg.esc; box.classList.remove('hidden');
    const post = toPost(d, 0);
    const qa = qaPost(post);
    box.innerHTML = `
      <div class="flex flex-wrap items-baseline justify-between gap-2"><h3 class="text-base font-bold">4. Your draft</h3><span class="text-xs text-[var(--muted-foreground)]">${esc(({ teardown: 'Teardown', runbook: 'Runbook', thesis: 'Thesis', story: 'Story' })[d.format])}, for ${esc(cfg.dayNames[d.dayIdx])}</span></div>
      <div class="space-y-2">${d.hooks.map((h, i) => `
        <label class="block p-2.5 rounded-lg border ${i === 0 ? 'border-[var(--primary)] bg-[var(--secondary)]' : 'border-[var(--border)]'} text-xs cursor-pointer">
          <div class="flex flex-wrap justify-between gap-2 text-[var(--muted-foreground)] mb-1"><span><input type="radio" name="cv-hook" value="${i}" ${i === 0 ? 'checked' : ''} class="mr-1.5 accent-[var(--primary)]" />Hook ${i + 1}: ${esc(TECHNIQUES[h.technique] ? TECHNIQUES[h.technique].name : 'Technique')}</span><span>${h.score.score}% · ${h.text.length}/210</span></div>
          <div class="whitespace-pre-wrap text-sm">${esc(h.text)}</div>
          <div class="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-[var(--muted-foreground)]">${h.score.checks.map(c => `<span>${c.ok ? '✓' : '!'} ${esc(c.label)}</span>`).join('')}</div>
        </label>`).join('')}</div>
      <div class="text-xs"><div class="font-semibold mb-1">Body</div><pre class="whitespace-pre-wrap font-sans text-sm p-3 rounded-lg border border-[var(--border)] bg-[var(--background)] max-h-96 overflow-auto">${esc(d.body)}</pre></div>
      <div class="text-xs"><div class="font-semibold mb-1">First comment</div><pre class="whitespace-pre-wrap font-sans text-sm p-3 rounded-lg border border-[var(--border)] bg-[var(--background)]">${esc(d.comment)}</pre></div>
      <div class="flex flex-wrap gap-2 text-xs">${qa.map(c => `<span class="px-2 py-1 rounded border border-[var(--border)] ${c.ok ? 'bg-[var(--secondary)]' : ''}">${c.ok ? '✓' : '!'} ${esc(c.label)}</span>`).join('')}<span class="px-2 py-1 rounded border border-[var(--border)] ${/\[[^\]]+\]/.test(d.body) ? '' : 'bg-[var(--secondary)]'}">${/\[[^\]]+\]/.test(d.body) ? '! Brackets to fill: only you can write those lines' : '✓ Nothing left to fill'}</span></div>
      <div class="flex flex-wrap gap-2">
        <button type="button" id="cv-load" class="px-3.5 py-2 rounded-lg bg-[var(--primary)] text-[var(--primary-foreground)] text-xs font-bold">Open in the ${esc(cfg.dayNames[d.dayIdx])} editor</button>
        <button type="button" id="cv-regen" class="px-3.5 py-2 rounded-lg border border-[var(--border)] text-xs font-semibold">New hooks</button>
        <button type="button" id="cv-copy" class="px-3.5 py-2 rounded-lg border border-[var(--border)] text-xs font-semibold">Copy the post</button>
      </div>`;
    box.querySelectorAll('input[name="cv-hook"]').forEach(r => r.onchange = () => { d.selectedHook = Number(r.value); });
    $('cv-load').onclick = () => { const p = toPost(d, d.selectedHook || 0); if (cfg.onDraft) cfg.onDraft(p, d.dayIdx); };
    $('cv-regen').onclick = () => { d.hooks = regenHooks(); d.selectedHook = 0; renderDraft(d); };
    $('cv-copy').onclick = async () => { const p = toPost(d, d.selectedHook || 0); try { await navigator.clipboard.writeText(`${p.hooks[p.selectedHook]}\n\n${p.body}`); cfg.toast('Copied the post.'); } catch { cfg.toast('Copy failed. Select the text and copy it.'); } };
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function toPost(d, selectedHook) {
    const label = ({ teardown: 'Teardown', runbook: 'Runbook', thesis: 'Thesis', story: 'Story' })[d.format] || 'Post';
    return { day: cfg.dayNames[d.dayIdx], archetype: d.format === 'story' ? 'thesis' : d.format, track: `${label}, inspired by ${selected.creator}`, isGrowth: true, credit: selected.creator, creditUrl: selected.url || '', title: `${extracted.topic} (inspired by ${selected.creator})`, selectedHook: selectedHook || 0, hooks: d.hooks.map(h => h.text), hookTechniques: d.hooks.map(h => h.technique), technique: d.hooks[selectedHook || 0] ? d.hooks[selectedHook || 0].technique : d.technique, body: d.body, comment: d.comment, sourceId: selected.id };
  }

  return { TECHNIQUES, detect, setCorpus, stats, exemplars, extract, suggestFormat, applicable, generateHooks, scoreHook, buildBody, buildComment, scrub, findJargon, findBanned, qaPost, geminiPrompt, init, renderCards, select, humanX };
})();
