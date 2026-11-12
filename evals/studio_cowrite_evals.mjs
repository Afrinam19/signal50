#!/usr/bin/env node
/**
 * Signal50 Studio — End-to-End Co-Writer & Breakout Flow Evals
 *
 * Runs headless Chromium against the local Signal50 studio with mocked Google AI Studio
 * endpoints (including realistic 2026 /v1beta/models catalogs with -image/-tts/-audio models
 * and Gemini 2.5 thinking-part responses) as well as no-key local rewrites.
 *
 * Usage:
 *   node evals/studio_cowrite_evals.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8781;
const CDP = 9351;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const twPath = '/tmp/srv/tailwind.js';
const twB64 = existsSync(twPath) ? readFileSync(twPath).toString('base64') : '';

// Realistic Google AI Studio /v1beta/models response (includes non-text generateContent models
// in the exact order that exposed the tie-breaker bug, plus standard text models).
const REALISTIC_MODELS_RESPONSE = {
  models: [
    { name: 'models/gemini-2.5-flash-image', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.5-flash-preview-tts', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.5-flash-native-audio-dialog', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.0-flash-exp-image-generation', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
    { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent', 'countTokens'] },
    { name: 'models/gemini-2.0-flash', supportedGenerationMethods: ['generateContent', 'countTokens'] }
  ]
};

const results = [];
function record(id, name, ok, detail = '') {
  results.push({ id, name, ok: Boolean(ok), detail: String(detail || '') });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${id}] ${name}${detail ? `  —  ${detail}` : ''}`);
}

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '--directory', ROOT], { stdio: 'ignore' });
const chrome = spawn('chromium', [
  '--headless=new', '--no-sandbox', '--disable-gpu',
  `--remote-debugging-port=${CDP}`, '--window-size=1366,1600', 'about:blank'
], { stdio: 'ignore' });
const cleanup = () => { try { chrome.kill(); } catch {} try { server.kill(); } catch {} };

let geminiCalls = [];
let mockMode = 'thinking_25'; // 'thinking_25' | 'rate_limit_first'

try {
  let targets = null;
  for (let i = 0; i < 40 && !targets; i++) {
    await sleep(250);
    try { targets = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json(); } catch {}
  }
  if (!targets) throw new Error('Chromium CDP did not start');

  const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let msgId = 0;
  const pending = new Map();
  const pageErrors = [];

  const send = (method, params = {}) => new Promise(res => {
    const id = ++msgId;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });

  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      pageErrors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || 'error');
    }
    if (m.method === 'Fetch.requestPaused') {
      const p = m.params;
      const url = p.request.url;
      if (/tailwindcss\.min\.js/.test(url) && twB64) {
        send('Fetch.fulfillRequest', {
          requestId: p.requestId, responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'application/javascript' }], body: twB64
        });
        return;
      }
      if (url.includes('generativelanguage.googleapis.com') && p.request.method === 'OPTIONS') {
        send('Fetch.fulfillRequest', {
          requestId: p.requestId, responseCode: 204,
          responseHeaders: [
            { name: 'Access-Control-Allow-Origin', value: '*' },
            { name: 'Access-Control-Allow-Methods', value: 'GET, POST, OPTIONS' },
            { name: 'Access-Control-Allow-Headers', value: 'Content-Type, x-goog-api-key' }
          ],
          body: ''
        });
        return;
      }
      if (url.includes('generativelanguage.googleapis.com/v1beta/models?')) {
        geminiCalls.push({ kind: 'listModels', url });
        send('Fetch.fulfillRequest', {
          requestId: p.requestId, responseCode: 200,
          responseHeaders: [
            { name: 'Content-Type', value: 'application/json' },
            { name: 'Access-Control-Allow-Origin', value: '*' }
          ],
          body: Buffer.from(JSON.stringify(REALISTIC_MODELS_RESPONSE)).toString('base64')
        });
        return;
      }
      if (url.includes('generativelanguage.googleapis.com/v1beta/models/') && url.includes(':generateContent')) {
        const modelMatch = url.match(/models\/([^:?]+):generateContent/);
        const model = modelMatch ? modelMatch[1] : 'unknown';
        const postBody = p.request.postData || '';
        geminiCalls.push({ kind: 'generateContent', model, url, postBody });

        // Image / TTS / Audio models reject JSON text generation in real Google AI Studio (HTTP 400).
        if (/image|tts|audio|live|embedding|imagen|veo/i.test(model)) {
          const errJson = { error: { code: 400, message: `Model ${model} does not support text JSON responseMimeType application/json.` } };
          send('Fetch.fulfillRequest', {
            requestId: p.requestId, responseCode: 400,
            responseHeaders: [
              { name: 'Content-Type', value: 'application/json' },
              { name: 'Access-Control-Allow-Origin', value: '*' }
            ],
            body: Buffer.from(JSON.stringify(errJson)).toString('base64')
          });
          return;
        }

        if (mockMode === 'rate_limit_first' && model === 'gemini-2.5-flash') {
          const errJson = { error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).' } };
          send('Fetch.fulfillRequest', {
            requestId: p.requestId, responseCode: 429,
            responseHeaders: [
              { name: 'Content-Type', value: 'application/json' },
              { name: 'Access-Control-Allow-Origin', value: '*' }
            ],
            body: Buffer.from(JSON.stringify(errJson)).toString('base64')
          });
          return;
        }

        // Realistic Gemini 2.5 Flash response: includes a `thought: true` part BEFORE the JSON part!
        let parsedReq = {};
        try { parsedReq = JSON.parse(postBody); } catch {}
        const promptText = parsedReq?.contents?.[0]?.parts?.[0]?.text || '';
        const wantsConverterSchema = promptText.includes('"technique"');
        const userWordsMatch = promptText.match(/MY OWN WORDS[^\n]*:\n([\s\S]*?)\n\n/i);
        const echoedWords = userWordsMatch ? userWordsMatch[1].trim() : 'We cut agent read cost by tracing every file read before touching prompts.';

        const payload = wantsConverterSchema
          ? {
              hooks: [
                { technique: 'specific_surprise', text: 'Spotify cut agent token spend by 90%.\nThe fix was a pre-read gate, not a clever prompt.' },
                { technique: 'contrarian_reveal', text: 'Most AI agent bills are not reasoning costs.\nThey are unguarded file reads.' },
                { technique: 'stakes_first', text: 'Before you ship another agent loop, trace one week of reads.\n90% of the bill sits there.' }
              ],
              body: `${echoedWords}\n\n1. Split reading from reasoning\n↳ Route large file reads to a smaller model first.\n\n2. Gate oversized reads in code\n↳ Block raw file dumps before they hit the main context.\n\nCredit to Aakash Gupta for the original post. Link in the first comment.\n\nHave you traced how much of your agent spend is reading vs reasoning?`,
              comment: 'Original post by Aakash Gupta: https://www.linkedin.com/posts/aakashg — More AI product breakdowns every Saturday.'
            }
          : {
              hooks: [
                'Spotify cut agent token spend by 90%.\nThe fix was a pre-read gate, not a clever prompt.',
                'Most AI agent bills are not reasoning costs.\nThey are unguarded file reads.',
                'Before you ship another agent loop, trace one week of reads.\n90% of the bill sits there.'
              ],
              body: `${echoedWords}\n\n1. Split reading from reasoning\n↳ Route large file reads to a smaller model before your main agent runs.\n\n2. Gate oversized reads in code\n↳ Enforce a hard ceiling in hooks, not a polite note in the system prompt.\n\nCredit to Aakash Gupta for the original post. Link in the first comment.\n\nWhere are unguarded reads hiding in your agent stack right now?`
            };

        const geminiResp = {
          candidates: [{
            content: {
              role: 'model',
              parts: [
                { thought: true, text: 'Let me craft 3 two-line hooks under 200 chars using Specific surprise and weave in Afrina\'s own words...' },
                { text: '```json\n' + JSON.stringify(payload, null, 2) + '\n```' }
              ]
            }
          }]
        };
        send('Fetch.fulfillRequest', {
          requestId: p.requestId, responseCode: 200,
          responseHeaders: [
            { name: 'Content-Type', value: 'application/json' },
            { name: 'Access-Control-Allow-Origin', value: '*' }
          ],
          body: Buffer.from(JSON.stringify(geminiResp)).toString('base64')
        });
        return;
      }
      send('Fetch.continueRequest', { requestId: p.requestId });
    }
  };

  const ev = async expression => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) {
      return { __err: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text };
    }
    return r.result?.result?.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Fetch.enable', {
    patterns: [
      { urlPattern: '*tailwindcss.min.js*' },
      { urlPattern: '*generativelanguage.googleapis.com*' }
    ]
  });

  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
  await sleep(2500);
  await ev('localStorage.clear()');
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
  await sleep(2500);

  // Wait for breakout cards to load
  for (let i = 0; i < 30; i++) {
    const c = await ev("document.querySelectorAll('#outlier-cards [data-cv-id]').length");
    if (c > 0) break;
    await sleep(250);
  }

  // =========================================================================
  // GROUP A: Breakout post -> Draft editability & "Add my own words"
  // =========================================================================
  await ev("document.querySelector('[data-tab=\"outliers\"]').click()");
  await sleep(250);
  await ev(`(() => {
    const card = [...document.querySelectorAll('#outlier-cards article')].find(a => /Spotify/i.test(a.textContent));
    (card ? card.querySelector('[data-cv-id]') : document.querySelector('#outlier-cards [data-cv-id]')).click();
  })()`);
  await sleep(300);
  await ev("document.getElementById('cv-form').requestSubmit()");
  await sleep(400);

  const step4Editable = await ev(`(() => {
    const draft = document.getElementById('cv-draft');
    if (!draft || draft.classList.contains('hidden')) return { ok: false, why: 'cv-draft hidden' };
    const bodyField = draft.querySelector('textarea[id*="body"], textarea[data-cv-body], [contenteditable="true"]');
    const hookField = draft.querySelector('textarea[id*="hook"], textarea[data-cv-hook-edit]');
    return { ok: Boolean(bodyField && hookField), hasBodyTextarea: Boolean(bodyField), hasHookTextarea: Boolean(hookField) };
  })()`);
  record('E1', 'Tab 3 Step 4 draft Hook & Body are directly editable (not static <pre>)', step4Editable.ok, JSON.stringify(step4Editable));

  const tab3HasKeyControl = await ev(`(() => {
    const p = document.getElementById('panel-outliers');
    return Boolean(p && p.querySelector('[id*="gemini-key"], [data-open-gemini-key], #cv-key-input, #cv-key-toggle'));
  })()`);
  record('E2', 'Tab 3 has a Gemini key control right where you draft', tab3HasKeyControl);

  // Load into Monday editor
  await ev("document.getElementById('cv-load').click()");
  await sleep(350);

  const myWordsField = await ev(`(() => {
    const el = document.getElementById('ai-my-words');
    return { exists: Boolean(el), visible: Boolean(el && el.offsetParent !== null) };
  })()`);
  record('E3', 'Tab 1 Co-Writer has a dedicated "My own words / my take" field (#ai-my-words)', myWordsField.exists && myWordsField.visible, JSON.stringify(myWordsField));

  const bracketHelper = await ev(`(() => {
    const body = document.getElementById('body-editor').value;
    const hasBrackets = /\\[[^\\]]+\\]/.test(body);
    const slotUi = document.getElementById('bracket-slots') || document.querySelector('[data-bracket-slot]');
    return { hasBrackets, hasSlotUi: Boolean(slotUi && slotUi.offsetParent !== null) };
  })()`);
  record('E4', 'Unfilled [brackets] surface inline fill-in inputs so user can type her own words', bracketHelper.hasBrackets && bracketHelper.hasSlotUi, JSON.stringify(bracketHelper));

  // =========================================================================
  // GROUP B: Selectable Voice / Signal Mix & interactive QA chips
  // =========================================================================
  const signalMixControl = await ev(`(() => {
    const buttons = document.querySelectorAll('[data-voice-mode], input[name="ai-voice-mode"], #ai-voice-mode');
    return { count: buttons.length };
  })()`);
  record('E5', 'Co-Writer lets user pick Voice / Signal mode (My words vs Blend vs Source signal)', signalMixControl.count >= 2, `controls=${signalMixControl.count}`);

  const qaInteractive = await ev(`(() => {
    const items = [...document.querySelectorAll('#qa-checks > *')];
    const actionable = items.filter(el => el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || typeof el.onclick === 'function' || el.dataset.qaTarget);
    return { total: items.length, actionable: actionable.length };
  })()`);
  record('E6', 'Quality Gate checks are interactive (clicking a ! check jumps to fix it)', qaInteractive.total > 0 && qaInteractive.actionable === qaInteractive.total, JSON.stringify(qaInteractive));

  // =========================================================================
  // GROUP C: Local Rewrite (NO API key) must actually change the draft!
  // =========================================================================
  const beforeLocal = await ev(`({
    hook: document.getElementById('hook-editor').value,
    body: document.getElementById('body-editor').value
  })`);

  // Try clicking "Tighten & Cut Clichés" with NO key
  await ev(`(() => {
    const b = document.querySelector('[data-ai-preset="tighten"]');
    if (b) b.click();
  })()`);
  await sleep(250);
  const afterTighten = await ev(`({
    hook: document.getElementById('hook-editor').value,
    body: document.getElementById('body-editor').value
  })`);
  const tightenChanged = afterTighten.body !== beforeLocal.body || afterTighten.hook !== beforeLocal.hook;
  record('E7', 'No-key "Tighten" preset visibly changes a Converter v2 draft (not a 0-diff no-op)', tightenChanged, `len ${beforeLocal.body.length} -> ${afterTighten.body.length}`);

  // Switch format to Thesis + click Rewrite like the best posts (no key)
  await ev(`(() => {
    const sel = document.getElementById('ai-archetype');
    sel.value = 'thesis';
    sel.dispatchEvent(new Event('change'));
    document.querySelector('[data-ai-preset="outlier"]').click();
  })()`);
  await sleep(250);
  const afterThesis = await ev(`document.getElementById('body-editor').value`);
  const thesisHasNoNumberedSteps = !/^\s*1\.\s+/m.test(afterThesis) && afterThesis !== afterTighten.body;
  record('E8', 'Switching Format to Thesis + clicking Rewrite restructures the draft without API key', thesisHasNoNumberedSteps, `changed=${afterThesis !== afterTighten.body}, numbered=${/^\s*1\.\s+/m.test(afterThesis)}`);

  // Type own words + custom instruction and click Rewrite Draft (no key)
  await ev(`(() => {
    const mw = document.getElementById('ai-my-words');
    if (mw) { mw.value = 'On our Gemini agent evals, one unguarded repo read burned 4x more tokens than the planner.'; mw.dispatchEvent(new Event('input')); }
    document.getElementById('ai-custom-prompt').value = 'Put my own observation right after the hook and make it shorter';
    document.getElementById('btn-run-ai').click();
  })()`);
  await sleep(250);
  const afterCustomLocal = await ev(`document.getElementById('body-editor').value`);
  record('E9', 'No-key "Rewrite Draft" weaves in user\'s own words instead of doing nothing',
    afterCustomLocal.includes('unguarded repo read burned 4x more tokens'),
    `containsMyWords=${afterCustomLocal.includes('unguarded repo read burned 4x more tokens')}`);

  // =========================================================================
  // GROUP D: Real Gemini API Key Flow (unsaved input, model picker, 2.5 thinking JSON, 429 fallback)
  // =========================================================================
  geminiCalls = [];
  // Crucial user bug: open key bar, paste key into #ai-gemini-key, DO NOT click "Save Key", click "Rewrite Draft"!
  await ev(`(() => {
    document.getElementById('btn-ai-key-toggle').click();
    const inp = document.getElementById('ai-gemini-key');
    inp.value = '  "AIzaSyFakeTestKeyForEval1234567890"  ';
    inp.dispatchEvent(new Event('input'));
    document.getElementById('btn-run-ai').click();
  })()`);
  await sleep(900);

  const calledGeminiWithoutSaveClick = geminiCalls.some(c => c.kind === 'generateContent');
  record('E10', 'Pasting API key + clicking Rewrite works immediately even without clicking "Save Key"',
    calledGeminiWithoutSaveClick, `calls=${geminiCalls.map(c => `${c.kind}:${c.model || ''}`).join(',') || 'NONE'}`);

  // Now explicitly click Save Key too, so we also test saved-key flow even if E10 failed
  if (!calledGeminiWithoutSaveClick) {
    geminiCalls = [];
    await ev(`(() => {
      const inp = document.getElementById('ai-gemini-key');
      inp.value = 'AIzaSyFakeTestKeyForEval1234567890';
      document.getElementById('btn-save-gemini-key').click();
      document.getElementById('btn-run-ai').click();
    })()`);
    await sleep(900);
  }

  const genCall = geminiCalls.find(c => c.kind === 'generateContent');
  const pickedTextModel = Boolean(genCall && !/image|tts|audio|live|embedding/i.test(genCall.model));
  record('E11', 'resolveGeminiModel picks a text model (never gemini-2.5-flash-image / -tts / -audio)',
    pickedTextModel, `picked=${genCall ? genCall.model : 'none'}`);

  const afterGemini = await ev(`({
    hook: document.getElementById('hook-editor').value,
    body: document.getElementById('body-editor').value,
    status: document.getElementById('ai-status').textContent
  })`);
  const geminiApplied = afterGemini.hook.includes('Spotify cut agent token spend by 90%') && !/✕|SyntaxError|HTTP 400/i.test(afterGemini.status);
  record('E12', 'Gemini 2.5 thinking-part + fenced JSON response parses cleanly and updates Hook & Body',
    geminiApplied, `status="${afterGemini.status.slice(0, 110)}"`);

  // Test 429 rate-limit automatic fallback to next text model
  mockMode = 'rate_limit_first';
  geminiCalls = [];
  await ev(`(() => {
    document.querySelector('[data-ai-preset="exec"]').click();
  })()`);
  await sleep(1100);
  const afterFallback = await ev(`document.getElementById('ai-status').textContent`);
  const modelsTried = geminiCalls.filter(c => c.kind === 'generateContent').map(c => c.model);
  record('E13', 'When primary Gemini model returns HTTP 429, Co-Writer automatically retries a fallback model',
    modelsTried.length >= 2 && !/^✕/.test(afterFallback.trim()),
    `modelsTried=${modelsTried.join('->')} | status="${afterFallback.slice(0, 90)}"`);

  // Also test Gemini drafting inside Tab 3 Converter with thinking-part response
  mockMode = 'thinking_25';
  geminiCalls = [];
  await ev("document.querySelector('[data-tab=\"outliers\"]').click()");
  await sleep(200);
  await ev("document.getElementById('cv-angle').value = 'We cut agent read cost by tracing every file read before touching prompts.'");
  await ev("document.getElementById('cv-form').requestSubmit()");
  await sleep(900);
  const cvStatus = await ev("document.getElementById('cv-status').textContent");
  record('E14', 'Tab 3 Converter Gemini draft succeeds on Gemini 2.5 thinking responses',
    /Drafted with gemini/i.test(cvStatus) && !/failed/i.test(cvStatus),
    `cvStatus="${cvStatus.slice(0, 100)}"`);

  // Safety & Undo
  await ev("document.querySelector('[data-tab=\"calendar\"]').click()");
  await sleep(200);
  const safetyClean = await ev(`(() => {
    const txt = document.getElementById('hook-editor').value + '\\n' + document.getElementById('body-editor').value;
    return !window.Signal50Converter.findJargon(txt) && document.getElementById('hook-editor').value.length <= 210;
  })()`);
  record('E15', 'Rewritten post has zero internal jargon and fits the 210-char mobile fold', safetyClean);

  record('E16', 'Zero uncaught runtime exceptions during full flow', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

  ws.close();
} catch (err) {
  console.error('Harness error:', err);
  record('HARNESS', 'Harness execution', false, err.message);
} finally {
  cleanup();
}

const passed = results.filter(r => r.ok).length;
console.log(`\n========================================`);
console.log(`EVAL SUMMARY: ${passed}/${results.length} passed (${results.length - passed} failed)`);
console.log(`========================================`);
process.exit(passed === results.length ? 0 : 1);
