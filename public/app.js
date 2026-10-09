'use strict';
const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');

let state = null;
let secondsLeft = 0;
let formDirty = false;

// ---------- 基礎工具 ----------
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined || method === 'POST' ? { 'content-type': 'application/json' } : {},
    body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON */ }
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

function toast(msg, ms = 2500) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  for (const k of kids) e.append(k);
  return e;
}

/** 讓按鈕在執行期間停用，並顯示錯誤。 */
async function busy(btn, fn) {
  btn.disabled = true;
  try { return await fn(); } catch (e) { toast(`錯誤：${e.message}`, 5000); } finally { btn.disabled = false; }
}

const statusText = {
  played: '✅ 已播報', fallback: '⚠️ 備援播報', error: '❌ 失敗',
  'skip-quiet': '🌙 靜音略過', 'skip-disabled': '⏸ 已停用',
};

function describe(h) {
  return `${new Date(h.time).toLocaleString('zh-TW', { hour12: false })} ${statusText[h.status] || h.status}`;
}

// ---------- 分頁 ----------
document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
  for (const s of ['overview', 'settings', 'tests', 'history']) $(`tab-${s}`).hidden = s !== b.dataset.tab;
}));

// ---------- 狀態 ----------
async function refresh() {
  try {
    state = await api('GET', '/api/state');
  } catch (e) {
    $('pill-cosy').textContent = `無法連線：${e.message}`;
    $('pill-cosy').className = 'pill bad';
    return;
  }
  secondsLeft = state.secondsToNextHour;
  const ok = state.cosyHealth.ok;
  $('pill-cosy').textContent = ok ? 'CosyVoice 正常' : 'CosyVoice 離線（將用 say）';
  $('pill-cosy').className = `pill ${ok ? 'ok' : 'bad'}`;
  const n = state.next;
  $('next-info').textContent = `${n.spoken}${n.quiet ? '（靜音時段，將略過）' : ''}${state.config.enabled ? '' : '（總開關已關閉）'}`;
  const last = state.history[0];
  $('last-entry').textContent = last ? `${describe(last)}｜${last.voice ? `${last.engine}/${last.voice}｜` : ''}${last.text || last.reason || ''}` : '尚無紀錄';
  renderHistory(state.history);
  if (!formDirty) fillSettings();
  fillVoiceSelect();
}

function tickClock() {
  if (!state) return;
  secondsLeft = Math.max(0, secondsLeft - 1);
  $('countdown').textContent = `${pad(Math.floor(secondsLeft / 60))}:${pad(secondsLeft % 60)}`;
  const p = state.now;
  const total = (p.hour * 3600 + p.minute * 60 + p.second + Math.round((Date.now() - tickClock.t0) / 1000)) % 86400;
  $('pill-clock').textContent = `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
  if (secondsLeft === 0) setTimeout(refresh, 3000);
}
tickClock.t0 = Date.now();

function renderHistory(list) {
  const body = $('history-body');
  body.replaceChildren(...list.map((h) => el('tr', {},
    el('td', { textContent: new Date(h.time).toLocaleString('zh-TW', { hour12: false }) }),
    el('td', { textContent: h.kind === 'manual' ? '手動' : '整點' }),
    el('td', { textContent: statusText[h.status] || h.status }),
    el('td', { textContent: h.voice ? `${h.engine}/${h.voice}` : '-' }),
    el('td', { textContent: h.text || h.reason || '' }),
  )));
}

// ---------- 設定 ----------
function chips(container, names, selected, group) {
  container.replaceChildren(...names.map((n) => {
    const cb = el('input', { type: 'checkbox', value: n, checked: selected.includes(n) });
    cb.dataset.group = group;
    cb.addEventListener('change', () => { formDirty = true; });
    return el('label', {}, cb, n);
  }));
}

function fillSettings() {
  const c = state.config;
  $('cfg-enabled').checked = c.enabled;
  $('cfg-engine').value = c.engine;
  $('cfg-avoid').checked = c.avoidRepeat;
  $('cfg-prerender').value = c.prerenderMinute;
  $('cfg-timeout').value = c.cosyvoice.timeoutSec;
  $('cfg-quiet-on').checked = c.quietHours.enabled;
  $('cfg-quiet-start').value = c.quietHours.start;
  $('cfg-quiet-end').value = c.quietHours.end;
  $('cfg-custom').value = c.customPhrases.join('\n');
  chips($('voices-cosy'), state.voices.cosyvoice, c.cosyvoice.voices, 'cosy');
  const sayNames = state.voices.say.filter((v) => c.say.locales.includes(v.locale)).map((v) => v.name);
  chips($('voices-say'), sayNames, c.say.voices, 'say');
}

const checked = (group) => [...document.querySelectorAll(`input[data-group="${group}"]:checked`)].map((x) => x.value);

document.querySelectorAll('#tab-settings input, #tab-settings select, #tab-settings textarea').forEach((x) =>
  x.addEventListener('input', () => { formDirty = true; }));

document.querySelectorAll('[data-sel]').forEach((b) => b.addEventListener('click', () => {
  const [group, mode] = b.dataset.sel.split('-');
  document.querySelectorAll(`input[data-group="${group}"]`).forEach((x) => { x.checked = mode === 'all'; });
  formDirty = true;
}));

$('btn-save').addEventListener('click', (ev) => busy(ev.target, async () => {
  const cfg = {
    enabled: $('cfg-enabled').checked,
    engine: $('cfg-engine').value,
    avoidRepeat: $('cfg-avoid').checked,
    prerenderMinute: Number($('cfg-prerender').value),
    cosyvoice: { voices: checked('cosy'), timeoutSec: Number($('cfg-timeout').value) },
    say: { voices: checked('say') },
    quietHours: { enabled: $('cfg-quiet-on').checked, start: $('cfg-quiet-start').value, end: $('cfg-quiet-end').value },
    customPhrases: $('cfg-custom').value.split('\n').map((s) => s.trim()).filter(Boolean),
  };
  await api('POST', '/api/config', cfg);
  formDirty = false;
  $('save-msg').textContent = `已儲存 ${new Date().toLocaleTimeString('zh-TW', { hour12: false })}`;
  toast('設定已儲存');
  await refresh();
}));

$('btn-announce').addEventListener('click', (ev) => busy(ev.target, async () => {
  toast('報時中…（合成可能需 10 秒）', 12000);
  const r = await api('POST', '/api/announce');
  toast(`已報時：${r.plan.text}`, 5000);
  await refresh();
}));

// ---------- 測試中心 ----------
function fillHourSelects() {
  for (const id of ['t4-hour', 't5-hour', 't9-hour']) {
    const s = $(id);
    for (let h = 0; h < 24; h++) s.append(el('option', { value: h, textContent: `${pad(h)}:00` }));
    s.value = new Date().getHours();
  }
}

function fillVoiceSelect() {
  if (!state) return;
  const engine = $('t2-engine').value;
  const names = engine === 'cosyvoice' ? state.voices.cosyvoice : state.voices.say.map((v) => v.name);
  const cur = $('t2-voice').value;
  $('t2-voice').replaceChildren(...names.map((n) => el('option', { value: n, textContent: n })));
  if (names.includes(cur)) $('t2-voice').value = cur;
}
$('t2-engine').addEventListener('change', fillVoiceSelect);

const ms = (v) => (v === undefined || v === null ? '-' : `${v}ms`);
const planText = (p) =>
  `音色：${p.engine}/${p.voice}${p.fallback ? '（備援' + (p.reason ? `：${p.reason}` : '') + '）' : ''}\n文字：${p.text}\n耗時：選取 ${ms(p.timings?.choose)}、合成 ${ms(p.timings?.synth)}、播放 ${ms(p.timings?.play)}`;

$('t1-run').addEventListener('click', (ev) => busy(ev.target, async () => {
  const { checks } = await api('GET', '/api/test/selfcheck');
  $('t1-out').replaceChildren(...checks.map((c) =>
    el('li', { className: c.ok ? 'ok' : 'bad', textContent: `${c.ok ? '✅' : '❌'} ${c.name}：${c.detail || ''}` })));
}));

for (const [id, play] of [['t2-play', true], ['t2-synth', false]]) {
  $(id).addEventListener('click', (ev) => busy(ev.target, async () => {
    $('t2-out').textContent = '處理中…';
    const r = await api('POST', '/api/test/speak', { engine: $('t2-engine').value, voice: $('t2-voice').value, text: $('t2-text').value, play });
    $('t2-out').textContent = `合成 ${ms(r.synthMs)}${r.playMs !== null ? `、播放 ${ms(r.playMs)}` : ''}`;
  }));
}

$('t3-run').addEventListener('click', (ev) => busy(ev.target, async () => {
  await api('POST', '/api/test/sweep', { engine: $('t3-engine').value, play: $('t3-play').checked });
  toast('巡聽開始，進度見下方日誌');
}));
$('t3-stop').addEventListener('click', () => api('DELETE', '/api/test/sweep').then(() => toast('已要求中止')).catch((e) => toast(e.message)));

$('t4-run').addEventListener('click', (ev) => busy(ev.target, async () => {
  $('t4-out').textContent = '處理中…';
  const r = await api('POST', '/api/test/random', { hour: Number($('t4-hour').value), mode: $('t4-mode').value });
  $('t4-out').textContent = r.timings ? planText(r) : `音色：${r.engine}/${r.voice}\n文字：${r.text}`;
}));

$('t5-run').addEventListener('click', (ev) => busy(ev.target, async () => {
  $('t5-out').textContent = '處理中…（CosyVoice 合成約需 10 秒）';
  const r = await api('POST', '/api/test/dryrun', { hour: Number($('t5-hour').value), simulateCosyFail: $('t5-fail').checked, play: $('t5-play').checked });
  $('t5-out').textContent = planText(r);
}));

$('t7-run').addEventListener('click', (ev) => busy(ev.target, async () => {
  const r = await api('POST', '/api/test/quiet', { time: $('t7-time').value });
  $('t7-out').textContent = `${r.quiet ? '🌙 該時刻在靜音時段內' : '🔔 該時刻不在靜音時段'}\n${r.reason}`;
}));

const actionName = { run: '執行', 'skip-quiet': '略過（靜音）', 'skip-disabled': '略過（已停用）' };
$('t8-run').addEventListener('click', (ev) => busy(ev.target, async () => {
  if (!$('t8-time').value) throw new Error('請先選擇模擬時間');
  const r = await api('POST', '/api/test/schedule', { time: $('t8-time').value, alreadyAnnounced: $('t8-a').checked, alreadyPrerendered: $('t8-p').checked });
  const d = r.decision;
  $('t8-out').textContent =
    `整點報時：${d.announce ? `${d.announce.hour} 點 → ${actionName[d.announce.action]}` : '此刻不觸發'}\n` +
    `預先合成：${d.prerender ? `${d.prerender.hour} 點 → ${actionName[d.prerender.action]}` : '此刻不觸發'}\n` +
    `（預合成時間為每小時第 ${r.prerenderMinute} 分）`;
}));

$('t9-run').addEventListener('click', (ev) => busy(ev.target, async () => {
  const r = await api('GET', `/api/test/phrases?hour=${$('t9-hour').value}`);
  const warns = r.items.filter((i) => i.warnings.length).length;
  $('t9-out').replaceChildren(
    el('div', { textContent: `${r.spoken}｜時段：${r.periods.join('、')}｜共 ${r.count} 句，${warns ? `⚠️ ${warns} 句有警告` : '✅ 無警告'}` }),
    ...r.items.map((i) => el('div', { textContent: `• ${i.text}${i.warnings.length ? `  ⚠️ ${i.warnings.join('、')}` : ''}` })));
}));

// 日誌輪詢
let logSince = 0;
async function pollLog() {
  try {
    const { items } = await api('GET', `/api/test/log?since=${logSince}`);
    if (items.length) {
      const box = $('log');
      for (const i of items) {
        logSince = i.id;
        box.append(`${new Date(i.t).toLocaleTimeString('zh-TW', { hour12: false })} ${i.level === 'error' ? '✗' : '·'} ${i.msg}\n`);
      }
      box.scrollTop = box.scrollHeight;
    }
  } catch { /* 暫時失敗略過 */ }
}
$('log-clear').addEventListener('click', () => { $('log').textContent = ''; });

// ---------- 啟動 ----------
fillHourSelects();
const d = new Date();
$('t8-time').value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:55`;
refresh();
setInterval(tickClock, 1000);
setInterval(refresh, 30000);
setInterval(pollLog, 1500);
