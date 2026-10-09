import fs from 'node:fs';
import path from 'node:path';

/** 序列化佇列：一次只執行一個任務，前一個失敗不影響後一個。 */
export function createQueue() {
  let tail = Promise.resolve();
  let pending = 0;
  return {
    run(fn) {
      pending++;
      const p = tail.then(() => fn());
      tail = p.then(() => {}, () => {}).then(() => { pending--; });
      return p;
    },
    get pending() { return pending; },
  };
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 先寫暫存檔再 rename，避免寫到一半損毀。 */
export function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

/** 極簡 .env 解析；不覆蓋已存在的環境變數。 */
export function loadEnv(file, target = process.env) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in target)) target[key] = val;
  }
}

export function createLogBuffer(max = 400) {
  const items = [];
  let seq = 0;
  return {
    add(level, msg) {
      items.push({ id: ++seq, t: new Date().toISOString(), level, msg });
      if (items.length > max) items.shift();
    },
    list(sinceId = 0) { return items.filter((i) => i.id > sinceId); },
  };
}

export function createRateLimiter({ limit, windowMs }) {
  const hits = new Map();
  return {
    /** 回傳 true 表示允許。 */
    take(key, now = Date.now()) {
      const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
      if (arr.length >= limit) { hits.set(key, arr); return false; }
      arr.push(now);
      hits.set(key, arr);
      return true;
    },
  };
}
