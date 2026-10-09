import { addHours, hourKey, isQuiet, partsFromDate } from './clock.js';

export const ANNOUNCE_WINDOW_MIN = 2; // 整點後 2 分鐘內仍視為該小時的報時

function actionFor(hour, cfg) {
  if (!cfg.enabled) return 'skip-disabled';
  if (isQuiet(hour * 60, cfg.quietHours)) return 'skip-quiet';
  return 'run';
}

/**
 * 純函式：給定牆上時間與狀態，決定這一刻該做什麼。
 * 面板的 T8 與單元測試共用它。
 */
export function decide(parts, state, cfg) {
  const out = { announce: null, prerender: null };
  const key = hourKey(parts);
  if (parts.minute < ANNOUNCE_WINDOW_MIN && state.lastAnnounced !== key) {
    out.announce = { key, hour: parts.hour, action: actionFor(parts.hour, cfg) };
  }
  if (parts.minute >= cfg.prerenderMinute) {
    const next = addHours(parts, 1);
    const nk = hourKey(next);
    if (state.lastPrerender !== nk) {
      out.prerender = { key: nk, hour: next.hour, action: actionFor(next.hour, cfg) };
    }
  }
  return out;
}

export function createScheduler({ getConfig, announcer, history, state, saveState, now = () => new Date(), log = () => {}, intervalMs = 15000 }) {
  const plans = new Map(); // hourKey -> 預先合成好的計畫
  let timer = null;

  async function doPrerender(pre) {
    state.lastPrerender = pre.key;
    saveState();
    if (pre.action !== 'run') { log('info', `略過預合成 ${pre.key}（${pre.action}）`); return; }
    try {
      log('info', `開始預合成 ${pre.key}`);
      plans.set(pre.key, await announcer.prepare({ hour: pre.hour, key: pre.key }));
      log('info', `預合成完成 ${pre.key}`);
    } catch (e) {
      log('error', `預合成失敗 ${pre.key}：${e.message}`);
    }
  }

  async function doAnnounce(a) {
    state.lastAnnounced = a.key;
    saveState();
    const base = { kind: 'scheduled', key: a.key, hour: a.hour };
    if (a.action !== 'run') {
      history.add({ ...base, status: a.action });
      log('info', `整點 ${a.key} 略過（${a.action}）`);
      return;
    }
    let plan = plans.get(a.key);
    plans.delete(a.key);
    try {
      if (!plan) plan = await announcer.prepare({ hour: a.hour, key: a.key, engine: 'say', reason: '未預合成' });
      await announcer.play(plan);
      history.add({ ...base, status: plan.fallback ? 'fallback' : 'played', engine: plan.engine, voice: plan.voice, text: plan.text, reason: plan.reason });
      log('info', `已報時 ${a.key}：[${plan.engine}/${plan.voice}] ${plan.text}`);
    } catch (e) {
      history.add({ ...base, status: 'error', text: plan?.text, reason: e.message });
      log('error', `報時失敗 ${a.key}：${e.message}`);
    }
  }

  async function tick() {
    const cfg = getConfig();
    const parts = partsFromDate(now(), cfg.timezone);
    const cur = hourKey(parts);
    for (const k of plans.keys()) if (k < cur) plans.delete(k);
    const d = decide(parts, state, cfg);
    const jobs = [];
    if (d.announce) jobs.push(doAnnounce(d.announce));
    if (d.prerender) jobs.push(doPrerender(d.prerender));
    await Promise.all(jobs);
  }

  return {
    tick,
    plans,
    start() {
      if (timer) return;
      timer = setInterval(() => tick().catch((e) => log('error', `tick 失敗：${e.message}`)), intervalMs);
      tick().catch((e) => log('error', `tick 失敗：${e.message}`));
    },
    stop() { clearInterval(timer); timer = null; },
    status() { return { lastAnnounced: state.lastAnnounced, lastPrerender: state.lastPrerender, plans: [...plans.keys()] }; },
  };
}
