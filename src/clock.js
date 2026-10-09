// 以「牆上時間」(wall clock) 表示時間，避免時區換算錯誤。
const pad = (n, w = 2) => String(n).padStart(w, '0');

export function validTimezone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

export function partsFromDate(date, tz) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const o = {};
  for (const p of f.formatToParts(date)) o[p.type] = p.value;
  return { year: +o.year, month: +o.month, day: +o.day, hour: +o.hour, minute: +o.minute, second: +o.second };
}

/** 回到 n 小時後的整點（分秒歸零）。 */
export function addHours(p, n) {
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour + n, 0, 0));
  return {
    year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
    hour: d.getUTCHours(), minute: 0, second: 0,
  };
}

export function hourKey(p) {
  return `${pad(p.year, 4)}${pad(p.month)}${pad(p.day)}${pad(p.hour)}`;
}

/** 解析 'YYYY-MM-DD HH:mm' 或 'YYYY-MM-DDTHH:mm'。 */
export function parseLocal(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(str).trim());
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1).map((x) => (x === undefined ? 0 : +x));
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  return { year, month, day, hour, minute, second };
}

export function parseHHMM(str) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(str));
  return m ? +m[1] * 60 + +m[2] : null;
}

/** minuteOfDay 是否落在靜音時段（起 ≤ t < 迄，支援跨午夜）。 */
export function isQuiet(minuteOfDay, quiet) {
  if (!quiet || !quiet.enabled) return false;
  const s = parseHHMM(quiet.start);
  const e = parseHHMM(quiet.end);
  if (s === null || e === null || s === e) return false;
  return s < e ? minuteOfDay >= s && minuteOfDay < e : minuteOfDay >= s || minuteOfDay < e;
}
