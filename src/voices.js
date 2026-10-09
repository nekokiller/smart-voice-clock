import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';

/** 解析 `say -v ?` 輸出：每行「名稱   語系   # 範例」。 */
export function parseSayVoices(output) {
  const voices = [];
  for (const line of output.split('\n')) {
    const m = /^(.+?)\s{2,}([a-z]{2,3}_[A-Z]{2})\s+#/.exec(line);
    if (m) voices.push({ name: m[1].trim(), locale: m[2] });
  }
  return voices;
}

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

export function createVoiceCatalog({ cosyDir, ttlMs = 60000 }) {
  const cache = { say: null, cosy: null };
  const fresh = (c) => c && Date.now() - c.at < ttlMs;

  return {
    /** macOS say 的所有語音（含語系）。 */
    async say() {
      if (fresh(cache.say)) return cache.say.value;
      const value = parseSayVoices(await run('say', ['-v', '?']));
      cache.say = { at: Date.now(), value };
      return value;
    },
    /** CosyVoice 音色（音色檔名去掉 .pt）；外接碟未掛載時回傳空陣列。 */
    async cosy() {
      if (fresh(cache.cosy)) return cache.cosy.value;
      let value = [];
      try {
        value = (await fs.readdir(cosyDir)).filter((f) => f.endsWith('.pt')).map((f) => f.slice(0, -3)).sort();
      } catch { /* 外接碟未掛載或目錄不存在 */ }
      cache.cosy = { at: Date.now(), value };
      return value;
    },
    cosyDir,
  };
}
