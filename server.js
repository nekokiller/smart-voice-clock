import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './src/app.js';
import { createAnnouncer } from './src/announcer.js';
import { createAuth } from './src/auth.js';
import { loadConfig, saveConfig } from './src/config.js';
import { createCosyEngine, createSayEngine } from './src/engines.js';
import { createHistory } from './src/history.js';
import { createPhraseBank } from './src/phrases.js';
import { createPlayer } from './src/player.js';
import { createScheduler } from './src/scheduler.js';
import { createVoiceCatalog } from './src/voices.js';
import { createLogBuffer, loadEnv, readJson, writeJsonAtomic } from './src/util.js';

const root = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(root, '.env'));

const password = process.env.PANEL_PASSWORD;
if (!password || !password.trim()) {
  console.error('錯誤：尚未設定 PANEL_PASSWORD。請編輯專案根目錄的 .env 填入密碼後再啟動。');
  process.exit(1);
}

const port = Number(process.env.PORT) || 8780;
const host = process.env.HOST || '0.0.0.0';
const cosyUrl = (process.env.COSYVOICE_URL || 'http://127.0.0.1:8765').replace(/\/$/, '');
const cosyDir = process.env.COSYVOICE_VOICES_DIR || '/Volumes/AcasisRaid2TB/CosyVoice3/audios_pt';

const dataDir = path.join(root, 'data');
const cacheDir = path.join(root, 'cache');
const configFile = path.join(dataDir, 'config.json');
const stateFile = path.join(dataDir, 'state.json');

const testLog = createLogBuffer();
const log = (level, msg) => console[level === 'error' ? 'error' : 'log'](`${new Date().toISOString()} [${level}] ${msg}`);

let config = loadConfig(configFile, (m) => log('warn', m));
const getConfig = () => config;
const setConfig = (c) => { config = c; saveConfig(configFile, c); log('info', '設定已更新'); };

const state = readJson(stateFile, { lastAnnounced: '', lastPrerender: '' });
const saveState = () => writeJsonAtomic(stateFile, state);

const phraseBank = createPhraseBank(readJson(path.join(dataDir, 'phrases.json'), {}));
const voices = createVoiceCatalog({ cosyDir });
const engines = { cosyvoice: createCosyEngine({ url: cosyUrl }), say: createSayEngine() };
const player = createPlayer();
const history = createHistory(path.join(dataDir, 'history.json'));
const announcer = createAnnouncer({ getConfig, engines, voices, player, phraseBank, cacheDir, log });
const scheduler = createScheduler({ getConfig, announcer, history, state, saveState, log });

const app = createApp({
  getConfig, setConfig, announcer, scheduler, history, voices, engines, state, phraseBank,
  auth: createAuth(password), log, testLog, cosyDir, cacheDir,
  publicDir: path.join(root, 'public'),
});

const server = http.createServer(app);
server.listen(port, host, () => {
  log('info', `控制面板：http://${host === '0.0.0.0' ? '<本機IP>' : host}:${port}  （時區 ${config.timezone}）`);
  scheduler.start();
  announcer.cleanup();
  setInterval(() => announcer.cleanup(), 3600 * 1000).unref();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('info', `收到 ${sig}，關閉中`);
    scheduler.stop();
    announcer.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
