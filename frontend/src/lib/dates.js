/* Date keys are 'YYYY-MM-DD' strings handled in UTC; times are 'HH:MM'. */

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function parseDate(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

export function toDateKey(date) {
  return date.toISOString().slice(0, 10);
}

export function addDays(dateKey, days) {
  const date = parseDate(dateKey);
  date.setUTCDate(date.getUTCDate() + days);
  return toDateKey(date);
}

export function datesBetween(firstDate, lastDate) {
  const dates = [];
  for (let dateKey = firstDate; dateKey <= lastDate; dateKey = addDays(dateKey, 1)) dates.push(dateKey);
  return dates;
}

export function daysInMonthOf(dateKey) {
  const date = parseDate(dateKey);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
}

export function firstOfPreviousMonth(dateKey) {
  const date = parseDate(dateKey);
  return toDateKey(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1)));
}

export function mondayOf(dateKey) {
  return addDays(dateKey, -((parseDate(dateKey).getUTCDay() + 6) % 7));
}

export function formatDay(dateKey, options) {
  const settings = { weekday: true, month: true, year: false, ...options };
  const date = parseDate(dateKey);
  const parts = [];
  if (settings.weekday) parts.push(WEEKDAY_NAMES[date.getUTCDay()]);
  parts.push(String(date.getUTCDate()));
  if (settings.month) parts.push(MONTH_NAMES[date.getUTCMonth()]);
  if (settings.year) parts.push(String(date.getUTCFullYear()));
  return parts.join(' ');
}

export function toMinutes(time) {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

export function formatMinutes(totalMinutes) {
  return String(Math.floor(totalMinutes / 60)).padStart(2, '0') + ':' + String(totalMinutes % 60).padStart(2, '0');
}

// Local date and time of an instant in a site's timezone.
export function localParts(instant, timeZone) {
  const parts = {};
  new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant).forEach((part) => { parts[part.type] = part.value; });
  return { date: parts.year + '-' + parts.month + '-' + parts.day, time: parts.hour + ':' + parts.minute };
}

export function byTime(a, b) {
  return a.time < b.time ? -1 : a.time > b.time ? 1 : 0;
}

export function newestFirst(a, b) {
  const stampA = a.date + 'T' + a.time;
  const stampB = b.date + 'T' + b.time;
  return stampA < stampB ? 1 : stampA > stampB ? -1 : 0;
}
