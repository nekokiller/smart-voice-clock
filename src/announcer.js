import path from 'node:path';
import fs from 'node:fs/promises';
import { createQueue } from './util.js';

const pick = (arr, rng) => arr[Math.floor(rng() * arr.length)];

/**
 * 報時核心：挑文案、挑音色、合成成音檔（含備援）、播放。
 * 引擎、播放器、亂數都可注入，方便測試。
 */
export function createAnnouncer({ getConfig, engines, voices, player, phraseBank, cacheDir, rng = Math.random, log = () => {} }) {
  const synthQueue = createQueue(); // CosyVoice 服務是單執行緒，合成需序列化
  const lastVoice = {};

  async function candidates(engine, cfg) {
    if (engine === 'cosyvoice') {
      const avail = await voices.cosy();
      const chosen = cfg.cosyvoice.voices;
      return chosen.length ? avail.filter((v) => chosen.includes(v)) : avail;
    }
    const avail = (await voices.say()).filter((v) => cfg.say.locales.includes(v.locale)).map((v) => v.name);
    const chosen = cfg.say.voices;
    return chosen.length ? avail.filter((v) => chosen.includes(v)) : avail;
  }

  async function chooseVoice(engine, cfg) {
    let list = await candidates(engine, cfg);
    if (!list.length) throw new Error(`${engine} 沒有可用音色`);
    if (cfg.avoidRepeat && list.length > 1) list = list.filter((v) => v !== lastVoice[engine]);
    const v = pick(list, rng);
    lastVoice[engine] = v;
    return v;
  }

  async function synth(engine, { text, voice, file, cfg }) {
    const timeoutMs = engine === 'cosyvoice' ? cfg.cosyvoice.timeoutSec * 1000 : 30000;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await synthQueue.run(() => engines[engine].synthToFile({ text, voice, file, timeoutMs }));
  }

  const ext = (engine) => (engine === 'cosyvoice' ? 'wav' : 'aiff');

  /** 只抽選，不合成。 */
  async function choose({ hour, minute = 0, engine, text }) {
    const cfg = getConfig();
    const eng = engine && engine !== 'auto' ? engine : cfg.engine;
    const picked = text ? { template: null, text } : phraseBank.pick(hour, { custom: cfg.customPhrases, avoidRepeat: cfg.avoidRepeat, minute });
    return { engine: eng, voice: await chooseVoice(eng, cfg), text: picked.text, template: picked.template };
  }

  /**
   * 抽選並合成。優先用設定的引擎；失敗（或模擬失敗）自動改用 say 備援。
   * engine='say' 表示直接用 say（例如整點時沒有預先合成）。
   */
  async function prepare({ hour, minute = 0, key, engine, text, simulateCosyFail = false, reason }) {
    const cfg = getConfig();
    const timings = {};
    const t0 = Date.now();
    const want = engine && engine !== 'auto' ? engine : cfg.engine;
    const picked = text ? { text } : phraseBank.pick(hour, { custom: cfg.customPhrases, avoidRepeat: cfg.avoidRepeat, minute });
    timings.choose = Date.now() - t0;

    const plan = { key, hour, minute, text: picked.text, fallback: false, reason: reason || null, timings };
    if (want === 'cosyvoice') {
      try {
        if (simulateCosyFail) throw new Error('模擬 CosyVoice 失敗');
        const voice = await chooseVoice('cosyvoice', cfg);
        const file = path.join(cacheDir, `${key}-cosyvoice.${ext('cosyvoice')}`);
        const t1 = Date.now();
        await synth('cosyvoice', { text: plan.text, voice, file, cfg });
        timings.synth = Date.now() - t1;
        return Object.assign(plan, { engine: 'cosyvoice', voice, file });
      } catch (e) {
        log('warn', `CosyVoice 失敗，改用 say 備援：${e.message}`);
        plan.fallback = true;
        plan.reason = e.message;
      }
    }
    const voice = await chooseVoice('say', cfg);
    const file = path.join(cacheDir, `${key}-say.${ext('say')}`);
    const t2 = Date.now();
    await synth('say', { text: plan.text, voice, file, cfg });
    timings.synth = Date.now() - t2;
    // 直接指定 say（非因失敗）不算 fallback，但「未預合成」仍標示為備援路徑
    if (want === 'say' && !plan.fallback && reason) plan.fallback = true;
    return Object.assign(plan, { engine: 'say', voice, file });
  }

  /** 合成任意文字（試聽用）。 */
  async function synthText({ engine, voice, text, key }) {
    const cfg = getConfig();
    const file = path.join(cacheDir, `${key}-${engine}.${ext(engine)}`);
    const t = Date.now();
    await synth(engine, { text, voice, file, cfg });
    return { file, synthMs: Date.now() - t };
  }

  async function play(plan) {
    const t = Date.now();
    await player.play(plan.file);
    plan.timings.play = Date.now() - t;
    return plan;
  }

  async function cleanup(maxAgeMs = 24 * 3600 * 1000) {
    try {
      for (const f of await fs.readdir(cacheDir)) {
        const p = path.join(cacheDir, f);
        const st = await fs.stat(p);
        if (st.isFile() && Date.now() - st.mtimeMs > maxAgeMs) await fs.unlink(p);
      }
    } catch { /* 目錄不存在就算了 */ }
  }

  return { choose, prepare, synthText, play, cleanup, stop: () => player.stop(), get busy() { return synthQueue.pending + player.pending; } };
}
