import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';

/** macOS say：以 stdin 傳入文字（避免參數注入），輸出成 AIFF 檔再由 afplay 播放。 */
export function createSayEngine() {
  return {
    name: 'say',
    async synthToFile({ text, voice, file, timeoutMs = 30000 }) {
      await new Promise((resolve, reject) => {
        const args = ['-o', file];
        if (voice) args.unshift('-v', voice);
        const cp = spawn('say', args, { stdio: ['pipe', 'ignore', 'pipe'] });
        let err = '';
        cp.stderr.on('data', (d) => { err += d; });
        const timer = setTimeout(() => { cp.kill('SIGKILL'); reject(new Error('say 逾時')); }, timeoutMs);
        cp.on('error', (e) => { clearTimeout(timer); reject(e); });
        cp.on('close', (code) => {
          clearTimeout(timer);
          code === 0 ? resolve() : reject(new Error(`say 結束碼 ${code}：${err.trim()}`));
        });
        cp.stdin.on('error', () => {});
        cp.stdin.end(text);
      });
    },
  };
}

/** 本機 CosyVoice3 HTTP 服務（POST /tts?voice=名稱，body 為文字，回傳 WAV）。 */
export function createCosyEngine({ url }) {
  return {
    name: 'cosyvoice',
    url,
    async synthToFile({ text, voice, file, timeoutMs = 45000 }) {
      const res = await fetch(`${url}/tts?voice=${encodeURIComponent(voice)}`, {
        method: 'POST',
        body: text,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`CosyVoice HTTP ${res.status}：${(await res.text()).slice(0, 120)}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1000 || buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('CosyVoice 回傳的不是有效 WAV');
      await fs.writeFile(`${file}.tmp`, buf);
      await fs.rename(`${file}.tmp`, file);
    },
    async health(timeoutMs = 2500) {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  };
}
