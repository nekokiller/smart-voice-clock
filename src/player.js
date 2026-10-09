import { spawn } from 'node:child_process';
import { createQueue } from './util.js';

/** 以 afplay 播放音檔；所有播放序列化，避免重疊。 */
export function createPlayer({ bin = '/usr/bin/afplay', timeoutMs = 90000 } = {}) {
  const queue = createQueue();
  let current = null;
  let aborted = false;

  function playOnce(file) {
    return new Promise((resolve, reject) => {
      const cp = spawn(bin, [file], { stdio: 'ignore' });
      current = cp;
      const timer = setTimeout(() => { cp.kill('SIGKILL'); reject(new Error('afplay 逾時')); }, timeoutMs);
      cp.on('error', (e) => { clearTimeout(timer); current = null; reject(e); });
      cp.on('close', (code, signal) => {
        clearTimeout(timer);
        current = null;
        if (signal === 'SIGTERM' && aborted) resolve();
        else code === 0 ? resolve() : reject(new Error(`afplay 結束碼 ${code ?? signal}`));
      });
    });
  }

  return {
    play(file) { aborted = false; return queue.run(() => playOnce(file)); },
    stop() { aborted = true; current?.kill('SIGTERM'); },
    get pending() { return queue.pending; },
  };
}
