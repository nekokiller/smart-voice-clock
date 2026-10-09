import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spokenTime } from '../src/timeText.js';
import { addHours, hourKey, isQuiet, parseLocal, partsFromDate } from '../src/clock.js';
import { createPhraseBank, periodsFor, render } from '../src/phrases.js';
import { DEFAULTS, normalizeConfig, ValidationError } from '../src/config.js';
import { decide } from '../src/scheduler.js';
import { loadEnv } from '../src/util.js';
import { parseSayVoices } from '../src/voices.js';

const phrases = JSON.parse(fs.readFileSync(new URL('../data/phrases.json', import.meta.url), 'utf8'));

test('spokenTime 涵蓋 0–23 點', () => {
  const expect = {
    0: '午夜十二點整', 1: '凌晨一點整', 2: '凌晨兩點整', 5: '凌晨五點整', 6: '上午六點整', 11: '上午十一點整',
    12: '中午十二點整', 13: '下午一點整', 15: '下午三點整', 17: '下午五點整', 18: '晚上六點整', 23: '晚上十一點整',
  };
  for (const [h, t] of Object.entries(expect)) assert.equal(spokenTime(+h), t);
  for (let h = 0; h < 24; h++) assert.match(spokenTime(h), /點整$/);
  assert.throws(() => spokenTime(24));
});

test('靜音時段 01:00–05:00（起含迄不含）', () => {
  const q = { enabled: true, start: '01:00', end: '05:00' };
  const quietHours = [];
  for (let h = 0; h < 24; h++) if (isQuiet(h * 60, q)) quietHours.push(h);
  assert.deepEqual(quietHours, [1, 2, 3, 4]);
  assert.equal(isQuiet(4 * 60 + 59, q), true);
  assert.equal(isQuiet(5 * 60, q), false);
  assert.equal(isQuiet(180, { ...q, enabled: false }), false);
});

test('靜音時段支援跨午夜', () => {
  const q = { enabled: true, start: '23:00', end: '07:00' };
  assert.equal(isQuiet(23 * 60, q), true);
  assert.equal(isQuiet(0, q), true);
  assert.equal(isQuiet(6 * 60 + 59, q), true);
  assert.equal(isQuiet(7 * 60, q), false);
  assert.equal(isQuiet(12 * 60, q), false);
});

test('時間工具：跨日、hourKey、時區', () => {
  const p = { year: 2026, month: 12, day: 31, hour: 23, minute: 56, second: 0 };
  const n = addHours(p, 1);
  assert.deepEqual([n.year, n.month, n.day, n.hour, n.minute], [2027, 1, 1, 0, 0]);
  assert.equal(hourKey(n), '2027010100');
  assert.deepEqual(parseLocal('2026-10-09T14:55'), { year: 2026, month: 10, day: 9, hour: 14, minute: 55, second: 0 });
  assert.equal(parseLocal('bad'), null);
  // 2026-01-01T16:30Z = 台北 2026-01-02 00:30
  const t = partsFromDate(new Date('2026-01-01T16:30:00Z'), 'Asia/Taipei');
  assert.deepEqual([t.day, t.hour, t.minute], [2, 0, 30]);
});

test('文案庫：每句都含 {time}、數量足夠、渲染後無殘留變數', () => {
  for (const [k, list] of Object.entries(phrases)) {
    for (const tpl of list) assert.ok(tpl.includes('{time}'), `${k}: ${tpl}`);
    assert.equal(new Set(list).size, list.length, `${k} 有重複句`);
  }
  assert.ok(phrases.general.length >= 20);
  for (const k of ['dawn', 'morning', 'noon', 'afternoon', 'evening', 'night']) assert.ok(phrases[k].length >= 8, k);
  const bank = createPhraseBank(phrases);
  for (let h = 0; h < 24; h++) {
    for (const tpl of bank.pool(h)) {
      const text = render(tpl, h);
      assert.ok(!/[{}]/.test(text), text);
      assert.ok(text.length <= 60, `太長：${text}`);
    }
  }
});

test('時段對應與避免連續重複', () => {
  assert.deepEqual(periodsFor(0), ['midnight', 'night']);
  assert.deepEqual(periodsFor(12), ['noon']);
  assert.deepEqual(periodsFor(15), ['afternoon']);
  assert.deepEqual(periodsFor(23), ['night']);
  const bank = createPhraseBank({ general: ['a{time}', 'b{time}'] }, () => 0);
  const seen = [bank.pick(9).template, bank.pick(9).template, bank.pick(9).template];
  assert.deepEqual(seen, ['a{time}', 'b{time}', 'a{time}']);
});

test('設定驗證：接受合法值、拒絕非法值、保留未提供欄位', () => {
  const c = normalizeConfig({ quietHours: { start: '02:00' }, prerenderMinute: 50 });
  assert.equal(c.quietHours.start, '02:00');
  assert.equal(c.quietHours.end, '05:00');
  assert.equal(c.prerenderMinute, 50);
  assert.equal(DEFAULTS.quietHours.start, '01:00');
  for (const bad of [{ prerenderMinute: 10 }, { engine: 'x' }, { timezone: 'Mars/Base' }, { quietHours: { start: '25:00' } }, { customPhrases: [1] }]) {
    assert.throws(() => normalizeConfig(bad), ValidationError);
  }
  assert.equal(normalizeConfig({ evil: 1 }).evil, undefined);
});

test('排程 decide：每小時只觸發一次、窗口、預合成、靜音', () => {
  const cfg = structuredClone(DEFAULTS);
  const at = (h, m) => ({ year: 2026, month: 10, day: 9, hour: h, minute: m, second: 0 });
  const st = () => ({ lastAnnounced: '', lastPrerender: '' });

  assert.equal(decide(at(14, 30), st(), cfg).announce, null);
  assert.equal(decide(at(14, 30), st(), cfg).prerender, null);
  assert.deepEqual(decide(at(14, 0), st(), cfg).announce, { key: '2026100914', hour: 14, action: 'run' });
  assert.ok(decide(at(14, 1), st(), cfg).announce);
  assert.equal(decide(at(14, 2), st(), cfg).announce, null, '超過 2 分鐘窗口不補播');
  assert.equal(decide(at(14, 0), { lastAnnounced: '2026100914', lastPrerender: '' }, cfg).announce, null, '已報過不重複');

  const pre = decide(at(14, 55), st(), cfg).prerender;
  assert.deepEqual(pre, { key: '2026100915', hour: 15, action: 'run' });
  assert.equal(decide(at(14, 56), { lastAnnounced: '', lastPrerender: '2026100915' }, cfg).prerender, null);

  assert.equal(decide(at(1, 0), st(), cfg).announce.action, 'skip-quiet');
  assert.equal(decide(at(0, 55), st(), cfg).prerender.action, 'skip-quiet', '1 點在靜音內，不預合成');
  assert.equal(decide(at(4, 55), st(), cfg).prerender.action, 'run', '5 點要播');
  assert.equal(decide(at(5, 0), st(), cfg).announce.action, 'run');
  assert.equal(decide(at(23, 55), st(), cfg).prerender.key, '2026101000', '跨日');
  assert.equal(decide(at(14, 0), st(), { ...cfg, enabled: false }).announce.action, 'skip-disabled');
});

test('.env 解析：註解、引號、不覆蓋既有值', () => {
  const f = `/tmp/voice-clock-env-${process.pid}`;
  fs.writeFileSync(f, '# c\nA=1\nB="hello world"\nC=\nexisting=new\n');
  const target = { existing: 'old' };
  loadEnv(f, target);
  fs.unlinkSync(f);
  assert.deepEqual(target, { existing: 'old', A: '1', B: 'hello world', C: '' });
});

test('解析 say -v ? 輸出', () => {
  const out = 'Meijia              zh_TW    # 你好，我叫美佳。\nEddy (中文（台灣）)       zh_TW    # 你好，我叫Eddy。\nAlex                en_US    # Hello\n';
  assert.deepEqual(parseSayVoices(out), [
    { name: 'Meijia', locale: 'zh_TW' }, { name: 'Eddy (中文（台灣）)', locale: 'zh_TW' }, { name: 'Alex', locale: 'en_US' },
  ]);
});

test('spokenClock：幾點幾分口語化', async () => {
  const { spokenClock, spokenMinute } = await import('../src/timeText.js');
  const expect = [
    [15, 0, '下午三點整'], [15, 5, '下午三點零五分'], [15, 10, '下午三點十分'], [15, 15, '下午三點十五分'],
    [15, 23, '下午三點二十三分'], [15, 30, '下午三點三十分'], [9, 59, '上午九點五十九分'],
    [0, 7, '午夜十二點零七分'], [12, 45, '中午十二點四十五分'], [2, 20, '凌晨兩點二十分'], [23, 41, '晚上十一點四十一分'],
  ];
  for (const [h, m, t] of expect) assert.equal(spokenClock(h, m), t);
  assert.equal(spokenMinute(40), '四十');
  assert.throws(() => spokenClock(10, 60));
  assert.throws(() => spokenClock(24, 0));
});

test('非整點不會抽到含「整點」字樣的文案，且渲染出分鐘', () => {
  const bank = createPhraseBank(phrases, () => 0.5);
  for (let h = 0; h < 24; h++) {
    for (let i = 0; i < 60; i++) {
      const r = bank.pick(h, { minute: 17 });
      assert.ok(!r.template.includes('整點'), r.template);
      assert.match(r.text, /十七分/);
    }
  }
});
