import { spokenClock, spokenHour } from './timeText.js';

/** 一天分成幾個時段；午夜 0 點額外多一個 midnight 池。 */
export function periodsFor(hour) {
  if (hour === 0) return ['midnight', 'night'];
  if (hour <= 4) return ['night'];
  if (hour <= 6) return ['dawn'];
  if (hour <= 11) return ['morning'];
  if (hour === 12) return ['noon'];
  if (hour <= 17) return ['afternoon'];
  if (hour <= 21) return ['evening'];
  return ['night'];
}

export function render(template, hour, minute = 0) {
  return template
    .replaceAll('{time}', spokenClock(hour, minute))
    .replaceAll('{hour}', spokenHour(hour));
}

export function createPhraseBank(data, rng = Math.random) {
  let lastTemplate = null;

  function pool(hour, custom = []) {
    const list = [...(data.general || [])];
    for (const p of periodsFor(hour)) list.push(...(data[p] || []));
    list.push(...custom);
    return list;
  }

  return {
    pool,
    data,
    /** 隨機選一句；盡量不與上一句相同。 */
    pick(hour, { custom = [], avoidRepeat = true, minute = 0 } = {}) {
      let list = pool(hour, custom);
      // 非整點時不使用「整點」字樣的文案
      if (minute !== 0) {
        const filtered = list.filter((t) => !t.includes('整點'));
        if (filtered.length) list = filtered;
      }
      if (!list.length) throw new Error('文案庫是空的');
      if (avoidRepeat && list.length > 1) list = list.filter((t) => t !== lastTemplate);
      const template = list[Math.floor(rng() * list.length)];
      lastTemplate = template;
      return { template, text: render(template, hour, minute) };
    },
  };
}
