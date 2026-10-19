export const MINUS = '−';

export const PERIOD_NAMES = { today: 'Today', week: 'This week', month: 'This month' };

export function formatSigned(value) {
  if (value > 0) return '+' + value;
  if (value < 0) return MINUS + Math.abs(value);
  return '0';
}

// higherIsBetter decides whether a rise is shown as positive or negative.
export function deltaClass(value, higherIsBetter) {
  if (value === 0) return 'delta-neutral';
  return (value > 0) === higherIsBetter ? 'delta-positive' : 'delta-negative';
}

export function formatPoints(deduction) {
  return MINUS + deduction;
}

export function initialsOf(name) {
  // "Site manager 1" becomes "S1", "Tom Noble" becomes "TN".
  const parts = name.split(/\s+/);
  const last = parts[parts.length - 1];
  return (parts[0][0] + (/^\d+$/.test(last) ? last : parts.length > 1 ? last[0] : '')).slice(0, 2).toUpperCase();
}

export function mean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
