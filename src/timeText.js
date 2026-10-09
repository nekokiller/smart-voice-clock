const NUM = ['十二', '一', '兩', '三', '四', '五', '六', '七', '八', '九', '十', '十一'];

/** 0–23 → 口語鐘點，例如 15 → 下午三點整。 */
export function spokenHour(hour) {
  return NUM[hour % 12];
}

const DIGIT = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

/** 1–59 → 口語分鐘：5 → 零五、10 → 十、15 → 十五、23 → 二十三、30 → 三十。 */
export function spokenMinute(minute) {
  if (minute < 10) return `零${DIGIT[minute]}`;
  const tens = Math.floor(minute / 10);
  const ones = minute % 10;
  return `${tens === 1 ? '' : DIGIT[tens]}十${ones ? DIGIT[ones] : ''}`;
}

/** 0–23 點、0–59 分 → 口語時間；整點為「下午三點整」，其餘為「下午三點十五分」。 */
export function spokenClock(hour, minute = 0) {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new RangeError('hour 必須是 0–23');
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) throw new RangeError('minute 必須是 0–59');
  let prefix;
  if (hour === 0) prefix = '午夜';
  else if (hour === 12) prefix = '中午';
  else if (hour <= 5) prefix = '凌晨';
  else if (hour <= 11) prefix = '上午';
  else if (hour <= 17) prefix = '下午';
  else prefix = '晚上';
  return `${prefix}${spokenHour(hour)}點${minute === 0 ? '整' : `${spokenMinute(minute)}分`}`;
}

export function spokenTime(hour) {
  return spokenClock(hour, 0);
}
