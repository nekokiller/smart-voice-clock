import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createAnnouncer } from '../src/announcer.js';
import { createApp } from '../src/app.js';
import { createAuth } from '../src/auth.js';
import { DEFAULTS, normalizeConfig } from '../src/config.js';
import { createHistory } from '../src/history.js';
import { createPhraseBank } from '../src/phrases.js';
import { createScheduler } from '../src/scheduler.js';
import { createLogBuffer } from '../src/util.js';

const phrases = JSON.parse(fs.readFileSync(new URL('../data/phrases.json', import.meta.url), 'utf8'));

function fixtures({ cosyFails = false, config = {} } = {}) {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-cache-'));
  let cfg = normalizeConfig(config);
  const calls = { cosy: [], say: [], played: [] };
  const write = (file) => fs.writeFileSync(file, 'x');
  const engines = {
    cosyvoice: {
      name: 'cosyvoice', url: 'http://fake',
      async synthToFile(a) { calls.cosy.push(a); if (cosyFails) throw new Error('boom'); write(a.file); },
      async health() { if (cosyFails) throw new Error('down'); return { mode: 'zero_shot' }; },
    },
    say: { name: 'say', async synthToFile(a) { calls.say.push(a); write(a.file); } },
  };
  const voices = {
    async cosy() { return ['柚子', '柯南', '橘子']; },
    async say() { return [{ name: 'Meijia', locale: 'zh_TW' }, { name: 'Alex', locale: 'en_US' }]; },
  };
  const player = { async play(f) { calls.played.push(f); }, stop() {}, pending: 0 };
  const phraseBank = createPhraseBank(phrases);
  const announcer = createAnnouncer({ getConfig: () => cfg, engines, voices, player, phraseBank, cacheDir });
  return { cacheDir, calls, engines, voices, player, phraseBank, announcer, getConfig: () => cfg, setConfig: (c) => { cfg = c; } };
}

test('announcer：正常走 CosyVoice，且只用啟用清單內的音色', async () => {
  const f = fixtures({ config: { cosyvoice: { voices: ['柚子'] } } });
  const plan = await f.announcer.prepare({ hour: 15, key: 'k1' });
  assert.equal(plan.engine, 'cosyvoice');
  assert.equal(plan.voice, '柚子');
  assert.equal(plan.fallback, false);
  assert.match(plan.text, /下午三點整|三點/);
  assert.ok(fs.existsSync(plan.file));
  await f.announcer.play(plan);
  assert.deepEqual(f.calls.played, [plan.file]);
});

test('announcer：CosyVoice 失敗 → say 備援，且只選 zh_TW 語音', async () => {
  const f = fixtures({ cosyFails: true });
  const plan = await f.announcer.prepare({ hour: 9, key: 'k2' });
  assert.equal(plan.engine, 'say');
  assert.equal(plan.voice, 'Meijia');
  assert.equal(plan.fallback, true);
  assert.match(plan.reason, /boom/);
});

test('announcer：模擬失敗旗標與直接指定 say', async () => {
  const f = fixtures();
  const sim = await f.announcer.prepare({ hour: 9, key: 'k3', simulateCosyFail: true });
  assert.equal(sim.fallback, true);
  assert.equal(f.calls.cosy.length, 0);
  const direct = await f.announcer.prepare({ hour: 9, key: 'k4', engine: 'say' });
  assert.equal(direct.engine, 'say');
  assert.equal(direct.fallback, false);
});

test('announcer：避免連續相同音色', async () => {
  const f = fixtures();
  let prev = null;
  for (let i = 0; i < 20; i++) {
    const p = await f.announcer.prepare({ hour: 10, key: `r${i}` });
    assert.notEqual(p.voice, prev);
    prev = p.voice;
  }
});

test('scheduler：假時鐘跑一整天，每小時恰好一次，靜音時段不播，預合成被使用', async () => {
  const f = fixtures();
  const history = createHistory(null);
  const state = { lastAnnounced: '', lastPrerender: '' };
  let nowMs = Date.parse('2026-10-09T00:00:00+08:00');
  const sch = createScheduler({
    getConfig: f.getConfig, announcer: f.announcer, history, state, saveState() {},
    now: () => new Date(nowMs),
  });
  // 每 15 秒一個 tick，跑 24 小時
  for (let t = 0; t < 24 * 3600; t += 15) {
    await sch.tick();
    nowMs += 15000;
  }
  const entries = history.list().filter((h) => h.kind === 'scheduled');
  assert.equal(entries.length, 24, '每小時一筆');
  const hours = entries.map((h) => h.hour).sort((a, b) => a - b);
  assert.deepEqual(hours, [...Array(24).keys()]);
  const status = Object.fromEntries(entries.map((h) => [h.hour, h.status]));
  for (let h = 0; h < 24; h++) {
    const want = h >= 1 && h < 5 ? 'skip-quiet' : h === 0 ? 'fallback' : 'played';
    assert.equal(status[h], want, `${h} 點`);
  }
  assert.equal(f.calls.played.length, 24 - 4);
  assert.equal(f.calls.say.length, 1, '只有第 0 點（啟動時尚無預合成）用到 say');
  assert.equal(f.calls.cosy.length, 24 - 4 - 1 + 1, '5–23 點共 19 次預合成，加上 23:55 為隔天 0 點預先合成的 1 次');
});

test('scheduler：重啟（沿用 state）不重複報時', async () => {
  const f = fixtures();
  const history = createHistory(null);
  const state = { lastAnnounced: '2026100914', lastPrerender: '' };
  const sch = createScheduler({
    getConfig: f.getConfig, announcer: f.announcer, history, state, saveState() {},
    now: () => new Date('2026-10-09T14:00:30+08:00'),
  });
  await sch.tick();
  assert.equal(history.list().length, 0);
  assert.equal(f.calls.played.length, 0);
});

// ---------- HTTP API ----------
const servers = [];
after(() => { for (const s of servers) { s.closeAllConnections(); s.close(); } });
async function startApp(opts = {}) {
  const f = fixtures(opts);
  const testLog = createLogBuffer();
  const publicDir = path.resolve(new URL('../public', import.meta.url).pathname);
  const scheduler = { status: () => ({ lastAnnounced: '', lastPrerender: '', plans: [] }) };
  const app = createApp({
    ...f, scheduler, history: createHistory(null), state: {}, auth: createAuth('secret'),
    log() {}, testLog, publicDir, cosyDir: os.tmpdir(), now: () => new Date('2026-10-09T14:30:00+08:00'),
  });
  const server = http.createServer(app);
  servers.push(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { authorization: `Basic ${Buffer.from('u:secret').toString('base64')}` };
  const call = (method, p, body, headers = {}) =>
    fetch(base + p, { method, headers: { ...auth, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { f, base, call, auth, close: () => { server.closeAllConnections(); server.close(); } };
}

test('API：未登入或密碼錯誤一律 401', async () => {
  const s = await startApp();
  assert.equal((await fetch(`${s.base}/api/state`)).status, 401);
  assert.equal((await fetch(`${s.base}/`)).status, 401);
  const bad = { authorization: `Basic ${Buffer.from('u:wrong').toString('base64')}` };
  assert.equal((await fetch(`${s.base}/api/state`, { headers: bad })).status, 401);
  s.close();
});

test('API：state、靜態頁、設定更新與驗證', async () => {
  const s = await startApp();
  const st = await (await s.call('GET', '/api/state')).json();
  assert.equal(st.now.hour, 14);
  assert.equal(st.secondsToNextHour, 1800);
  assert.equal(st.next.spoken, '下午三點整');
  assert.equal(st.cosyHealth.ok, true);
  assert.equal((await s.call('GET', '/')).status, 200);
  assert.notEqual((await s.call('GET', '/..%2fserver.js')).status, 200, '不可讀到 public 以外的檔案');
  assert.notEqual((await s.call('GET', '/%2e%2e/server.js')).status, 200);
  const ok = await s.call('POST', '/api/config', { quietHours: { start: '00:30' } });
  assert.equal(ok.status, 200);
  assert.equal(s.f.getConfig().quietHours.start, '00:30');
  const bad = await s.call('POST', '/api/config', { prerenderMinute: 5 });
  assert.equal(bad.status, 400);
  s.close();
});

test('API：安全防護（跨來源、錯誤 Content-Type、過大內容、文字長度）', async () => {
  const s = await startApp();
  assert.equal((await s.call('POST', '/api/test/quiet', { time: '03:00' }, { origin: 'http://evil.example' })).status, 403);
  const noJson = await fetch(`${s.base}/api/test/quiet`, { method: 'POST', headers: { ...s.auth, 'content-type': 'text/plain' }, body: 'x' });
  assert.equal(noJson.status, 415);
  const big = await s.call('POST', '/api/config', { customPhrases: ['a'.repeat(40000)] });
  assert.ok([413, 400].includes(big.status));
  const long = await s.call('POST', '/api/test/speak', { engine: 'say', voice: 'Meijia', text: 'a'.repeat(201) });
  assert.equal(long.status, 400);
  const unknown = await s.call('POST', '/api/test/speak', { engine: 'say', voice: '不存在', text: 'hi' });
  assert.equal(unknown.status, 400);
  s.close();
});

test('API 測試中心：T2/T4/T5/T6/T7/T8/T9', async () => {
  const s = await startApp();
  const j = async (p, b) => (await s.call(b === undefined ? 'GET' : 'POST', p, b)).json();

  const speak = await j('/api/test/speak', { engine: 'cosyvoice', voice: '柚子', text: '測試', play: true });
  assert.equal(typeof speak.synthMs, 'number');
  assert.equal(s.f.calls.played.length, 1);

  const pick = await j('/api/test/random', { hour: 12, mode: 'pick' });
  assert.match(pick.text, /中午十二點整/);
  assert.equal(s.f.calls.cosy.length, 1, 'pick 模式不合成');

  const dry = await j('/api/test/dryrun', { hour: 20, play: false });
  assert.equal(dry.engine, 'cosyvoice');
  const fail = await j('/api/test/dryrun', { hour: 20, simulateCosyFail: true, play: false });
  assert.equal(fail.engine, 'say');
  assert.equal(fail.fallback, true);

  const q = await j('/api/test/quiet', { time: '03:00' });
  assert.equal(q.quiet, true);
  assert.equal(q.announceAtThisHour, false);
  assert.equal((await j('/api/test/quiet', { time: '05:00' })).announceAtThisHour, true);

  const sched = await j('/api/test/schedule', { time: '2026-10-09 04:55' });
  assert.equal(sched.decision.prerender.action, 'run');
  const sched2 = await j('/api/test/schedule', { time: '2026-10-09 00:55' });
  assert.equal(sched2.decision.prerender.action, 'skip-quiet');

  const ph = await j('/api/test/phrases?hour=0');
  assert.deepEqual(ph.periods, ['midnight', 'night']);
  assert.ok(ph.items.every((i) => i.warnings.length === 0));

  const log = await j('/api/test/log?since=0');
  assert.ok(log.items.length > 0);
  s.close();
});

test('API：CosyVoice 離線時自檢回報失敗，立即報時走備援', async () => {
  const s = await startApp({ cosyFails: true });
  const { checks } = await (await s.call('GET', '/api/test/selfcheck')).json();
  assert.equal(checks.find((c) => c.name === 'CosyVoice 服務').ok, false);
  const r = await (await s.call('POST', '/api/announce', {})).json();
  assert.equal(r.plan.engine, 'say');
  assert.equal(r.plan.fallback, true);
  s.close();
});
