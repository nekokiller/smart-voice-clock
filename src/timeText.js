const NUM = ['十二', '一', '兩', '三', '四', '五', '六', '七', '八', '九', '十', '十一'];

/** 0–23 → 口語鐘點，例如 15 → 下午三點整。 */
export function spokenHour(hour) {
  return NUM[hour % 12];
}

export function spokenTime(hour) {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new RangeError('hour 必須是 0–23');
  if (hour === 0) return '午夜十二點整';
  if (hour === 12) return '中午十二點整';
  let prefix;
  if (hour <= 5) prefix = '凌晨';
  else if (hour <= 11) prefix = '上午';
  else if (hour <= 17) prefix = '下午';
  else prefix = '晚上';
  return `${prefix}${spokenHour(hour)}點整`;
}
