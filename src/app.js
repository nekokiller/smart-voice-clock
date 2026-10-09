import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { addHours, hourKey, isQuiet, parseLocal, partsFromDate } from './clock.js';
import { normalizeConfig, ValidationError } from './config.js';
import { decide } from './scheduler.js';
import { periodsFor, render } from './phrases.js';
import { spokenTime } from './timeText.js';
import { createRateLimiter } from './util.js';

const MAX_BODY = 16 * 1024;
const MAX_TEXT = 200;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let tooBig = false;
    req.on('data', (c) => {
      if (tooBig) return;
      size += c.length;
      if (size > MAX_BODY) { tooBig = true; chunks.length = 0; reject(new HttpError(413, '請求內容過大')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'JSON 格式錯誤')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'content-type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function cleanText(v) {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, '文字不可為空');
  if (v.length > MAX_TEXT) throw new HttpError(400, `文字不可超過 ${MAX_TEXT} 字`);
  return v.trim();
}

function cleanHour(v) {
  if (!Number.isInteger(v) || v < 0 || v > 23) throw new HttpError(400, 'hour 必須是 0–23 的整數');
  return v;
}

function run(cmd, args, timeout = 6000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (e, out) => (e ? reject(e) : resolve(out)));
  });
}

async function defaultOutputDevice() {
  const out = await run('system_profiler', ['SPAudioDataType']);
  const idx = out.indexOf('Default Output Device: Yes');
  if (idx < 0) return null;
  let name = null;
  for (const m of out.slice(0, idx).matchAll(/^\s{8}(.+):\s*$/gm)) name = m[1].trim();
  return name;
}

export function createApp(ctx) {
  const { getConfig, setConfig, announcer, scheduler, history, voices, engines, state, auth, log, testLog, publicDir, cacheDir, now = () => new Date(), cosyDir } = ctx;
  const failLimiter = createRateLimiter({ limit: 10, windowMs: 60000 });
  const actionLimiter = createRateLimiter({ limit: 40, windowMs: 60000 });
  const sweep = { running: false, abort: false, done: 0, total: 0 };
  let healthCache = { at: 0, value: null };

  async function cosyHealth() {
    if (Date.now() - healthCache.at < 8000) return healthCache.value;
    let value;
    try { value = { ok: true, info: await engines.cosyvoice.health() }; } catch (e) { value = { ok: false, error: e.message }; }
    healthCache = { at: Date.now(), value };
    return value;
  }

  const wall = () => partsFromDate(now(), getConfig().timezone);
  const testKey = () => `test-${Date.now()}`;
  const tlog = (level, msg) => { testLog.add(level, msg); log(level, `[test] ${msg}`); };

  async function listVoices() {
    return { cosyvoice: await voices.cosy(), say: await voices.say() };
  }

  const routes = {
    'GET /api/state': async () => {
      const cfg = getConfig();
      const p = wall();
      const next = addHours(p, 1);
      return {
        now: p, timezone: cfg.timezone,
        secondsToNextHour: 3600 - (p.minute * 60 + p.second),
        next: { hour: next.hour, spoken: spokenTime(next.hour), quiet: isQuiet(next.hour * 60, cfg.quietHours) },
        config: cfg,
        voices: await listVoices(),
        cosyHealth: await cosyHealth(),
        scheduler: scheduler.status(),
        history: history.list().slice(0, 20),
        busy: announcer.busy,
      };
    },

    'POST /api/config': async (body) => {
      try {
        const cfg = normalizeConfig(body, getConfig());
        setConfig(cfg);
        return { ok: true, config: cfg };
      } catch (e) {
        if (e instanceof ValidationError) throw new HttpError(400, e.message);
        throw e;
      }
    },

    'GET /api/history': async () => ({ history: history.list() }),

    'POST /api/announce': async () => {
      const p = wall();
      const plan = await announcer.prepare({ hour: p.hour, key: `manual-${Date.now()}` });
      await announcer.play(plan);
      history.add({ kind: 'manual', hour: p.hour, status: plan.fallback ? 'fallback' : 'played', engine: plan.engine, voice: plan.voice, text: plan.text, reason: plan.reason });
      return { plan: { ...plan, file: undefined } };
    },

    // ---- 測試中心 ----
    'GET /api/test/selfcheck': async () => {
      const cfg = getConfig();
      const checks = [];
      const add = (name, ok, detail) => checks.push({ name, ok, detail });
      const h = await cosyHealth();
      add('CosyVoice 服務', h.ok, h.ok ? `${engines.cosyvoice.url}（mode=${h.info.mode}）` : h.error);
      add('外接碟 / 音色目錄', fs.existsSync(cosyDir), cosyDir);
      const cv = await voices.cosy();
      add('CosyVoice 音色數量', cv.length > 0, `${cv.length} 個`);
      try {
        const sv = (await voices.say()).filter((v) => cfg.say.locales.includes(v.locale));
        add('say 語音', sv.length > 0, `${sv.length} 個（${cfg.say.locales.join(',')}）`);
      } catch (e) { add('say 語音', false, e.message); }
      add('afplay', fs.existsSync('/usr/bin/afplay'), '/usr/bin/afplay');
      try {
        const dev = await defaultOutputDevice();
        add('預設音訊輸出', !!dev, dev || '找不到預設輸出裝置');
      } catch (e) { add('預設音訊輸出', false, e.message); }
      try {
        await fsp.mkdir(cacheDir, { recursive: true });
        await fsp.access(cacheDir, fs.constants.W_OK);
        add('快取目錄可寫', true, cacheDir);
      } catch (e) { add('快取目錄可寫', false, e.message); }
      const p = wall();
      add('時區與目前時間', true, `${cfg.timezone} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`);
      add('面板密碼', true, '已設定');
      const n = ctx.phraseBank.pool(p.hour, cfg.customPhrases).length;
      add('文案庫', n > 0, `目前時段共 ${n} 句可抽選`);
      tlog('info', `系統自檢：${checks.filter((c) => c.ok).length}/${checks.length} 項通過`);
      return { checks };
    },

    'POST /api/test/speak': async (body) => {
      const engine = body.engine;
      if (!['cosyvoice', 'say'].includes(engine)) throw new HttpError(400, 'engine 必須是 cosyvoice 或 say');
      const text = cleanText(body.text);
      const voice = String(body.voice || '');
      const list = engine === 'cosyvoice' ? await voices.cosy() : (await voices.say()).map((v) => v.name);
      if (!list.includes(voice)) throw new HttpError(400, `找不到音色：${voice}`);
      tlog('info', `試聽 [${engine}/${voice}] ${text}`);
      const r = await announcer.synthText({ engine, voice, text, key: testKey() });
      let playMs = null;
      if (body.play !== false) {
        const t = Date.now();
        await announcer.play({ file: r.file, timings: {} });
        playMs = Date.now() - t;
      }
      tlog('info', `完成：合成 ${r.synthMs}ms${playMs !== null ? `，播放 ${playMs}ms` : ''}`);
      return { synthMs: r.synthMs, playMs };
    },

    'POST /api/test/sweep': async (body) => {
      if (sweep.running) throw new HttpError(409, '巡聽進行中');
      const engine = body.engine;
      if (!['cosyvoice', 'say'].includes(engine)) throw new HttpError(400, 'engine 必須是 cosyvoice 或 say');
      const text = cleanText(body.text || '這是音色測試，現在的時間是整點報時。');
      const cfg = getConfig();
      let list = engine === 'cosyvoice' ? await voices.cosy() : (await voices.say()).filter((v) => cfg.say.locales.includes(v.locale)).map((v) => v.name);
      list = list.slice(0, 40);
      Object.assign(sweep, { running: true, abort: false, done: 0, total: list.length });
      tlog('info', `開始巡聽 ${engine}，共 ${list.length} 個音色`);
      (async () => {
        for (const voice of list) {
          if (sweep.abort) break;
          try {
            const r = await announcer.synthText({ engine, voice, text, key: testKey() });
            if (sweep.abort) break;
            if (body.play !== false) await announcer.play({ file: r.file, timings: {} });
            tlog('info', `✅ ${voice}（合成 ${r.synthMs}ms）`);
          } catch (e) {
            tlog('error', `❌ ${voice}：${e.message}`);
          }
          sweep.done++;
        }
        tlog('info', sweep.abort ? '巡聽已中止' : '巡聽完成');
        sweep.running = false;
      })();
      return { started: true, total: list.length };
    },

    'DELETE /api/test/sweep': async () => {
      sweep.abort = true;
      announcer.stop();
      return { aborted: true };
    },

    'GET /api/test/sweep': async () => ({ ...sweep }),

    'POST /api/test/random': async (body) => {
      const hour = body.hour === undefined ? wall().hour : cleanHour(body.hour);
      const mode = ['pick', 'synth', 'play'].includes(body.mode) ? body.mode : 'pick';
      if (mode === 'pick') {
        const c = await announcer.choose({ hour, engine: body.engine });
        tlog('info', `抽選 [${c.engine}/${c.voice}] ${c.text}`);
        return { hour, ...c };
      }
      const plan = await announcer.prepare({ hour, key: testKey(), engine: body.engine });
      if (mode === 'play') await announcer.play(plan);
      tlog('info', `${mode === 'play' ? '播放' : '合成'} [${plan.engine}/${plan.voice}] ${plan.text}`);
      return { hour, ...plan, file: undefined };
    },

    'POST /api/test/dryrun': async (body) => {
      const hour = cleanHour(body.hour);
      const simulateCosyFail = body.simulateCosyFail === true;
      tlog('info', `完整流程演練：模擬 ${hour} 點${simulateCosyFail ? '（模擬 CosyVoice 失敗）' : ''}`);
      const plan = await announcer.prepare({ hour, key: testKey(), simulateCosyFail });
      tlog('info', `選取 ${plan.timings.choose}ms；合成 ${plan.timings.synth}ms → [${plan.engine}/${plan.voice}]${plan.fallback ? ' 備援' : ''}`);
      if (body.play !== false) {
        await announcer.play(plan);
        tlog('info', `播放 ${plan.timings.play}ms`);
      }
      return { ...plan, file: undefined };
    },

    'POST /api/test/quiet': async (body) => {
      const t = parseLocal(body.time) || parseLocal(`2000-01-01 ${body.time}`);
      if (!t) throw new HttpError(400, 'time 格式應為 YYYY-MM-DD HH:mm 或 HH:mm');
      const cfg = getConfig();
      const quiet = isQuiet(t.hour * 60 + t.minute, cfg.quietHours);
      const onTheHour = isQuiet(t.hour * 60, cfg.quietHours);
      return {
        quietHours: cfg.quietHours, quiet, announceAtThisHour: !onTheHour && cfg.enabled,
        reason: !cfg.enabled ? '總開關已關閉' : onTheHour ? '該小時整點落在靜音時段，將略過' : '該小時整點不在靜音時段，會報時',
      };
    },

    'POST /api/test/schedule': async (body) => {
      const t = parseLocal(body.time);
      if (!t) throw new HttpError(400, 'time 格式應為 YYYY-MM-DD HH:mm');
      const cfg = getConfig();
      const st = {
        lastAnnounced: body.alreadyAnnounced ? hourKey(t) : '',
        lastPrerender: body.alreadyPrerendered ? hourKey(addHours(t, 1)) : '',
      };
      const d = decide(t, st, cfg);
      const next = addHours(t, 1);
      return { time: body.time, decision: d, nextTopOfHour: hourKey(next), prerenderMinute: cfg.prerenderMinute };
    },

    'GET /api/test/phrases': async (_b, url) => {
      const hour = Number(url.searchParams.get('hour'));
      cleanHour(hour);
      const cfg = getConfig();
      const bank = ctx.phraseBank;
      const items = bank.pool(hour, cfg.customPhrases).map((tpl) => {
        const text = render(tpl, hour);
        const warnings = [];
        if (/\{[a-z]+\}/i.test(text)) warnings.push('有未代換的變數');
        if (!tpl.includes('{time}')) warnings.push('未包含 {time}');
        if (text.length > 60) warnings.push('偏長');
        return { template: tpl, text, warnings };
      });
      return { hour, periods: periodsFor(hour), spoken: spokenTime(hour), count: items.length, items };
    },

    'GET /api/test/log': async (_b, url) => ({ items: testLog.list(Number(url.searchParams.get('since')) || 0) }),
  };

  const heavy = new Set(['POST /api/announce']);

  return async function handler(req, res) {
    try {
      const ip = req.socket.remoteAddress || '?';
      const url = new URL(req.url, 'http://localhost');
      if (!auth.check(req.headers.authorization)) {
        if (req.headers.authorization && !failLimiter.take(ip)) return send(res, 429, '嘗試次數過多，請稍後再試');
        return send(res, 401, '需要登入', { 'www-authenticate': 'Basic realm="voice-clock", charset="UTF-8"' });
      }

      const method = req.method;
      if (method !== 'GET' && method !== 'HEAD') {
        const origin = req.headers.origin;
        if (origin) {
          let ok = false;
          try { ok = new URL(origin).host === req.headers.host; } catch { /* ignore */ }
          if (!ok) return send(res, 403, { error: '不允許的來源' });
        }
        if (!String(req.headers['content-type'] || '').startsWith('application/json') && method === 'POST') {
          return send(res, 415, { error: '請使用 application/json' });
        }
      }

      if (url.pathname.startsWith('/api/')) {
        const key = `${method} ${url.pathname}`;
        const fn = routes[key];
        if (!fn) return send(res, 404, { error: '找不到此 API' });
        if ((method === 'POST' || heavy.has(key)) && key !== 'POST /api/config' && !actionLimiter.take(ip)) {
          return send(res, 429, { error: '操作太頻繁，請稍後再試' });
        }
        const body = method === 'POST' ? await readBody(req) : {};
        return send(res, 200, await fn(body, url));
      }

      if (method !== 'GET' && method !== 'HEAD') return send(res, 405, '不支援的方法');
      let rel = decodeURIComponent(url.pathname);
      if (rel === '/') rel = '/index.html';
      const file = path.join(publicDir, path.normalize(rel));
      if (!file.startsWith(publicDir + path.sep)) return send(res, 403, '禁止存取');
      try {
        const data = await fsp.readFile(file);
        return send(res, 200, data, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'" });
      } catch {
        return send(res, 404, '找不到檔案');
      }
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) log('error', `請求失敗：${e.stack || e.message}`);
      if (status === 413) {
        send(res, status, { error: e.message }, { connection: 'close' });
        res.on('finish', () => req.destroy());
        return;
      }
      send(res, status, { error: e.message });
    }
  };
}
