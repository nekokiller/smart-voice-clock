import { parseHHMM, validTimezone } from './clock.js';
import { readJson, writeJsonAtomic } from './util.js';

export const DEFAULTS = Object.freeze({
  enabled: true,
  timezone: 'Asia/Taipei',
  engine: 'cosyvoice', // cosyvoice | say
  cosyvoice: { voices: [], timeoutSec: 45 }, // voices 空陣列 = 全部可用音色
  say: { voices: [], locales: ['zh_TW'] },
  prerenderMinute: 55,
  quietHours: { enabled: true, start: '01:00', end: '05:00' },
  avoidRepeat: true,
  customPhrases: [],
});

export class ValidationError extends Error {
  constructor(errors) {
    super(errors.join('；'));
    this.errors = errors;
  }
}

const isStr = (v) => typeof v === 'string';
const strList = (v, max, maxLen) =>
  Array.isArray(v) && v.length <= max && v.every((s) => isStr(s) && s.length > 0 && s.length <= maxLen);

/** 以 base 為底合併 input 並驗證；只接受已知欄位。 */
export function normalizeConfig(input = {}, base = DEFAULTS) {
  const errors = [];
  const out = structuredClone(base);
  const i = input && typeof input === 'object' ? input : {};

  if ('enabled' in i) typeof i.enabled === 'boolean' ? (out.enabled = i.enabled) : errors.push('enabled 必須是布林');
  if ('avoidRepeat' in i) typeof i.avoidRepeat === 'boolean' ? (out.avoidRepeat = i.avoidRepeat) : errors.push('avoidRepeat 必須是布林');
  if ('timezone' in i) isStr(i.timezone) && validTimezone(i.timezone) ? (out.timezone = i.timezone) : errors.push('timezone 無效');
  if ('engine' in i) ['cosyvoice', 'say'].includes(i.engine) ? (out.engine = i.engine) : errors.push('engine 必須是 cosyvoice 或 say');
  if ('prerenderMinute' in i) {
    Number.isInteger(i.prerenderMinute) && i.prerenderMinute >= 30 && i.prerenderMinute <= 58
      ? (out.prerenderMinute = i.prerenderMinute) : errors.push('prerenderMinute 必須是 30–58 的整數');
  }
  if (i.cosyvoice && typeof i.cosyvoice === 'object') {
    if ('voices' in i.cosyvoice) strList(i.cosyvoice.voices, 100, 60) ? (out.cosyvoice.voices = i.cosyvoice.voices) : errors.push('cosyvoice.voices 格式錯誤');
    if ('timeoutSec' in i.cosyvoice) {
      const t = i.cosyvoice.timeoutSec;
      Number.isInteger(t) && t >= 5 && t <= 120 ? (out.cosyvoice.timeoutSec = t) : errors.push('cosyvoice.timeoutSec 必須是 5–120 的整數');
    }
  }
  if (i.say && typeof i.say === 'object') {
    if ('voices' in i.say) strList(i.say.voices, 100, 80) ? (out.say.voices = i.say.voices) : errors.push('say.voices 格式錯誤');
    if ('locales' in i.say) strList(i.say.locales, 10, 10) ? (out.say.locales = i.say.locales) : errors.push('say.locales 格式錯誤');
  }
  if (i.quietHours && typeof i.quietHours === 'object') {
    const q = i.quietHours;
    if ('enabled' in q) typeof q.enabled === 'boolean' ? (out.quietHours.enabled = q.enabled) : errors.push('quietHours.enabled 必須是布林');
    for (const k of ['start', 'end']) {
      if (k in q) parseHHMM(q[k]) !== null ? (out.quietHours[k] = q[k]) : errors.push(`quietHours.${k} 必須是 HH:mm`);
    }
  }
  if ('customPhrases' in i) {
    strList(i.customPhrases, 200, 100) ? (out.customPhrases = i.customPhrases.map((s) => s.trim()).filter(Boolean))
      : errors.push('customPhrases 必須是最多 200 句、每句 ≤100 字的字串陣列');
  }
  if (errors.length) throw new ValidationError(errors);
  return out;
}

export function loadConfig(file, warn = () => {}) {
  const raw = readJson(file, null);
  if (!raw) return structuredClone(DEFAULTS);
  try {
    return normalizeConfig(raw);
  } catch (e) {
    warn(`設定檔有誤，改用預設值：${e.message}`);
    return structuredClone(DEFAULTS);
  }
}

export function saveConfig(file, cfg) {
  writeJsonAtomic(file, cfg);
}
