import { readJson, writeJsonAtomic } from './util.js';

export function createHistory(file, max = 100) {
  let items = file ? readJson(file, []) : [];
  if (!Array.isArray(items)) items = [];
  return {
    add(entry) {
      items.unshift({ time: new Date().toISOString(), ...entry });
      if (items.length > max) items.length = max;
      if (file) { try { writeJsonAtomic(file, items); } catch { /* 寫入失敗不影響報時 */ } }
    },
    list() { return items; },
  };
}
