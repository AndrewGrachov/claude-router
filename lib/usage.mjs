// Routed usage kept across sessions by local calendar day, so the Usage tab can show any period: each routed main
// reply's prices against your model (compareModels), its tokens, and the activity, tier and route it ran on. Counts and
// dollars only, never text. Pure: the hook adds each finished turn to the session's own record in $.store under
// USAGE_PREFIX, as it did the savings record (SAVINGS_PREFIX), which is now kept only as undated history.

import { afterResetOf, earlierSince, isRecord } from './records.mjs';
import { readSavingsStore } from './savings.mjs';

export const USAGE_PREFIX = 'usage:v1:';
// The period the Usage tab shows, kept across sessions.
export const PERIOD_KEY = 'usage:period';
export const PERIODS = ['session', 'today', '7d', '30d', 'month', 'all'];
// $.store holds 4 MiB of JSON for all keys together. A session-day takes about 1–2 KB, so days older than this leave a
// session's record when it is written, and other sessions' records with no newer day are deleted; past MAX_RECORDS
// sessions, the ones whose last day is oldest go too, so many short sessions cannot fill the store. Upgrade trigger:
// All needs more than a year of days, or the cap drops days a period shows: roll old days into monthly totals.
export const RETAIN_DAYS = 400;
export const MAX_RECORDS = 1000;
// Insights need this many replies in the period: fewer, and one switch or one long reply decides them.
export const INSIGHT_REPLIES = 20;

// A cell's sums, in this order; an array keeps a record small. The USD sums are compareReply's parts.
export const CELL_SUMS = [
  'replies',
  'routedUsd',
  'yoursUsd',
  'cheaperUsd',
  'strongerUsd',
  'switchUsd',
  'inputTokens',
  'cacheReadTokens',
  'outputTokens',
];
const USD = new Set(['routedUsd', 'yoursUsd', 'cheaperUsd', 'strongerUsd', 'switchUsd']);
const IS_USD = CELL_SUMS.map((sum) => USD.has(sum));
const DAY = /^\d{4}-\d{2}-\d{2}$/;
// `activity|tier|id@effort`: activity and tier never hold a `|`, and an effort never an `@`, so a model id may hold
// either.
const CELL_KEY = /^[^|]+\|[^|]+\|.+@[^@]+$/;
const HOUR = /^(1?\d|2[0-3])$/;
// Sums are kept to a millionth of a dollar: enough for a cent-exact readout over many replies, and short in JSON.
const microUsd = (usd) => Math.round(usd * 1e6) / 1e6;

// A key read from router.json, such as a model id `toString` or `__proto__`, must neither answer from the prototype
// nor set it.
const own = (object, key) => (Object.hasOwn(object, key) ? object[key] : undefined);
const put = (object, key, value) =>
  Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });

const pad2 = (n) => String(n).padStart(2, '0');
// The local calendar day of `ms`, `2026-10-13`.
export function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
// The day `days` before `ms`'s, counted on the calendar, so a daylight saving change never skips or repeats one.
export function daysBefore(ms, days) {
  const d = new Date(ms);
  return dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - days).getTime());
}

export function emptyUsage() {
  return { version: 1, since: null, days: {} };
}

const emptyDay = () => ({ cells: {}, whatIf: {}, yours: {}, hours: {}, turns: 0, switches: { tier: 0, activity: 0 } });

// One routed main reply as its turn collects it. `at` is when it arrived (ms); `activity` the turn's activity and
// `tier` the tier that served it (null: none); `route` the model id that served it and the request's effort,
// `id@effort` (`session` for no effort); `yours` your model's id; `reply` its prices against your model, and `replies`
// against each model as yours keyed by model id, from compareModels; `usage` the API usage, whose counts compareReply
// already checked. Model ids, not models keys: a models key can name another model later.
export function replyEntry({ at, activity, tier, route, yours, reply, replies, usage }) {
  const input = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
  return {
    at,
    cell: `${activity ?? 'none'}|${tier ?? 'none'}|${route}`,
    sums: [
      1,
      reply.routedUsd,
      reply.yoursUsd,
      reply.cheaperUsd,
      reply.strongerUsd,
      reply.switchUsd,
      input,
      usage.cache_read_input_tokens,
      usage.output_tokens,
    ],
    whatIf: Object.fromEntries(Object.entries(replies).map(([model, r]) => [model, r.yoursUsd])),
    yours,
  };
}

const addSums = (a, b) => a.map((value, i) => (IS_USD[i] ? microUsd(value + b[i]) : value + b[i]));

// A finished turn's replies added to the session's record at `now`: each on the day and hour it arrived, the turn and
// the route switch that started it (`switched`: 'tier', 'activity' or null) on the day it ended. Days past
// RETAIN_DAYS leave the record. A turn without replies returns `record` itself.
export function recordUsage(record, entries, { switched = null, now }) {
  if (!entries.length) return record;
  const days = structuredClone(record.days);
  for (const entry of entries) {
    const key = dayKey(entry.at);
    const day = days[key] ?? emptyDay();
    day.cells[entry.cell] = day.cells[entry.cell] ? addSums(day.cells[entry.cell], entry.sums) : [...entry.sums];
    for (const [model, usd] of Object.entries(entry.whatIf)) {
      const [n, sum] = own(day.whatIf, model) ?? [0, 0];
      put(day.whatIf, model, [n + 1, microUsd(sum + usd)]);
    }
    if (entry.yours) addInto(day.yours, entry.yours, 1);
    const hour = String(new Date(entry.at).getHours());
    day.hours[hour] = microUsd((day.hours[hour] ?? 0) + entry.sums[1]);
    days[key] = day;
  }
  const ended = days[dayKey(now)] ?? emptyDay();
  ended.turns += 1;
  if (switched === 'tier' || switched === 'activity') ended.switches[switched] += 1;
  days[dayKey(now)] = ended;
  const cutoff = daysBefore(now, RETAIN_DAYS);
  for (const key of Object.keys(days)) if (key < cutoff) delete days[key];
  return { version: 1, since: record.since ?? now, days };
}

const isCount = (n) => Number.isSafeInteger(n) && n >= 0;
const isUsd = (n) => Number.isFinite(n) && n >= 0;
const isPair = (v) => Array.isArray(v) && v.length === 2 && isCount(v[0]) && isUsd(v[1]);
// Every sum is a count or a cost of at least 0, except the cheaper part, which is at most 0.
const CHEAPER = CELL_SUMS.indexOf('cheaperUsd');
const isSums = (v) =>
  Array.isArray(v) &&
  v.length === CELL_SUMS.length &&
  v.every((n, i) => Number.isFinite(n) && (i === CHEAPER ? n <= 0 : n >= 0));

function readDay(day) {
  const ok =
    isRecord(day) &&
    isRecord(day.cells) &&
    Object.entries(day.cells).every(([key, sums]) => CELL_KEY.test(key) && isSums(sums)) &&
    isRecord(day.whatIf) &&
    Object.values(day.whatIf).every(isPair) &&
    isRecord(day.yours) &&
    Object.values(day.yours).every(isCount) &&
    isRecord(day.hours) &&
    Object.entries(day.hours).every(([hour, usd]) => HOUR.test(hour) && isUsd(usd)) &&
    isCount(day.turns) &&
    isRecord(day.switches) &&
    Object.keys(day.switches).length === 2 &&
    isCount(day.switches.tier) &&
    isCount(day.switches.activity);
  return ok ? day : null;
}

// The stored value read day by day: a missing or unknown record is empty, and a day that does not read is dropped
// while the others stay, so a hand edit never breaks a turn or the pane.
export function readUsage(value) {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.days)) return emptyUsage();
  if (!(value.since === null || Number.isFinite(value.since))) return emptyUsage();
  const days = {};
  for (const [key, day] of Object.entries(value.days)) {
    const read = DAY.test(key) ? readDay(day) : null;
    if (read) days[key] = read;
  }
  return { version: 1, since: value.since, days };
}

// A record whose first reply came before the last reset at `resetAt` (ms) reads as empty.
export const usageAfterReset = (record, resetAt) => afterResetOf(record, resetAt, emptyUsage);

// The last day of a stored value that reads whole, or null for one that does not, such as one a later release wrote:
// it may hold days this one skips, so it is never deleted.
function lastDay(value) {
  const record = readUsage(value);
  if (record.since === null) return null;
  const keys = Object.keys(value.days);
  if (keys.length !== Object.keys(record.days).length) return null;
  return keys.sort().at(-1) ?? '';
}

// Which of the stored `[key, value]` records the store can let go at `now`: those with no day inside RETAIN_DAYS,
// then, past `max` records, those whose last day is oldest.
export function prunedUsage(entries, now, max = MAX_RECORDS) {
  const cutoff = daysBefore(now, RETAIN_DAYS);
  const dated = entries.map(([key, value]) => [key, lastDay(value)]).filter(([, day]) => day !== null);
  const gone = new Set(dated.filter(([, day]) => day < cutoff).map(([key]) => key));
  const over = entries.length - gone.size - max;
  if (over > 0)
    for (const [key] of dated
      .filter(([key]) => !gone.has(key))
      .sort(([, a], [, b]) => (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, over))
      gone.add(key);
  return gone;
}

function addInto(into, key, value) {
  put(into, key, (own(into, key) ?? 0) + value);
}

function mergeDay(a, b) {
  const day = structuredClone(a);
  for (const [key, sums] of Object.entries(b.cells))
    day.cells[key] = day.cells[key] ? addSums(day.cells[key], sums) : [...sums];
  for (const [model, [n, usd]] of Object.entries(b.whatIf)) {
    const [m, sum] = own(day.whatIf, model) ?? [0, 0];
    put(day.whatIf, model, [m + n, microUsd(sum + usd)]);
  }
  for (const [model, n] of Object.entries(b.yours)) addInto(day.yours, model, n);
  for (const [hour, usd] of Object.entries(b.hours)) day.hours[hour] = microUsd((day.hours[hour] ?? 0) + usd);
  day.turns += b.turns;
  day.switches = { tier: day.switches.tier + b.switches.tier, activity: day.switches.activity + b.switches.activity };
  return day;
}

// The records kept across sessions added up day by day, each since the last reset, since the earliest.
export function mergeUsage(values, resetAt = null) {
  const merged = emptyUsage();
  for (const one of values.map((value) => usageAfterReset(readUsage(value), resetAt))) {
    merged.since = earlierSince(merged.since, one.since);
    for (const [key, day] of Object.entries(one.days))
      merged.days[key] = merged.days[key] ? mergeDay(merged.days[key], day) : structuredClone(day);
  }
  return merged;
}

// The days a period covers at `now`, as day keys, both ends included; null ends for the whole record (`session`,
// which is the session's own record, and `all`). 7d is today and the six days before it.
export function periodRange(period, now) {
  const to = dayKey(now);
  if (period === 'today') return { from: to, to };
  if (period === '7d') return { from: daysBefore(now, 6), to };
  if (period === '30d') return { from: daysBefore(now, 29), to };
  if (period === 'month') return { from: `${to.slice(0, 7)}-01`, to };
  return { from: null, to: null };
}

// A record's days inside `range`, added up: the readout sums (as `readout` in lib/savings.mjs takes them), tokens,
// turns and switches, what the same tokens cost on each model as yours, your model's replies by model id, the cells,
// and the days themselves, oldest first.
export function summarize(record, { from, to }) {
  const days = Object.keys(record.days)
    .filter((key) => (from === null || key >= from) && (to === null || key <= to))
    .sort()
    .map((key) => [key, record.days[key]]);
  const total = emptyDay();
  for (const [, day] of days) Object.assign(total, mergeDay(total, day));
  const [replies, routedUsd, yoursUsd, cheaperUsd, strongerUsd, switchUsd, inputTokens, cacheReadTokens, outputTokens] =
    Object.values(total.cells).reduce(
      addSums,
      CELL_SUMS.map(() => 0),
    );
  return {
    replies,
    routedUsd,
    yoursUsd,
    cheaperUsd,
    strongerUsd,
    switchUsd,
    inputTokens,
    cacheReadTokens,
    outputTokens,
    turns: total.turns,
    switches: total.switches,
    whatIf: total.whatIf,
    yours: total.yours,
    cells: total.cells,
    days,
  };
}

const READOUT_SUMS = ['replies', 'routedUsd', 'yoursUsd', 'cheaperUsd', 'strongerUsd', 'switchUsd'];

// Every routed reply kept: the usage records' days and the undated savings totals from before them, as `readout`
// takes them, and since when (ms; null without any).
export function allTime(usageStore, savingsStore) {
  const record = readUsage(usageStore);
  const summary = summarize(record, { from: null, to: null });
  const legacy = readSavingsStore(savingsStore);
  return {
    totals: Object.fromEntries(READOUT_SUMS.map((key) => [key, summary[key] + legacy[key]])),
    since: earlierSince(record.since, legacy.since),
    legacy,
  };
}

// A cell key's parts, split at its first two `|` and its route's last `@` (CELL_KEY).
function cellParts(key) {
  const [activity, tier] = key.split('|', 2);
  const route = key.slice(activity.length + tier.length + 2);
  return { activity, tier, route, model: route.slice(0, route.lastIndexOf('@')) };
}
// The part of a cell key a breakdown groups by, and the part it lists under each group.
const keyPart = (key, by) => cellParts(key)[by];
const CHILD = { activity: 'route', model: 'activity', tier: 'activity' };

// The cells grouped `by` activity, model or tier: each group's sums and its cells grouped again (routes under an
// activity, activities under a model or a tier), the groups by routed cost, most first; ties keep name order.
export function breakdown(cells, by) {
  const groups = new Map();
  for (const [key, sums] of Object.entries(cells)) {
    const name = keyPart(key, by);
    const group = groups.get(name) ?? { name, sums: CELL_SUMS.map(() => 0), children: new Map() };
    group.sums = addSums(group.sums, sums);
    const child = keyPart(key, CHILD[by]);
    group.children.set(child, addSums(group.children.get(child) ?? CELL_SUMS.map(() => 0), sums));
    groups.set(name, group);
  }
  const byCost = (a, b) => b.sums[1] - a.sums[1] || (a.name < b.name ? -1 : 1);
  return [...groups.values()]
    .map((group) => ({
      name: group.name,
      sums: group.sums,
      children: [...group.children].map(([name, sums]) => ({ name, sums })).sort(byCost),
    }))
    .sort(byCost);
}

// The cells whose `by` part (activity, model or tier) is `name`.
export const cellsWhere = (cells, by, name) =>
  Object.fromEntries(Object.entries(cells).filter(([key]) => keyPart(key, by) === name));

// The route most of these cells' replies ran on, `id@effort`; ties go to the first in name order. Null without any.
export function mostlyOn(cells) {
  const routes = new Map();
  for (const [key, sums] of Object.entries(cells))
    routes.set(keyPart(key, 'route'), (routes.get(keyPart(key, 'route')) ?? 0) + sums[0]);
  const [top] = [...routes].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return top?.[0] ?? null;
}

// Routed cost per bucket of the period: per hour of `today` for the session and today, per week once a period spans
// more than WEEKLY_AFTER days, else per day, with zero for a bucket without replies. `unit` names the bucket.
const WEEKLY_AFTER = 45;
export function trend(summary, period, now) {
  if (period === 'session' || period === 'today') {
    const day = summary.days.find(([key]) => key === dayKey(now))?.[1];
    const hours = Object.keys(day?.hours ?? {}).map(Number);
    if (!hours.length) return { unit: 'hour', values: [] };
    const values = [];
    for (let h = Math.min(...hours); h <= Math.max(...hours); h += 1) values.push(day.hours[String(h)] ?? 0);
    return { unit: 'hour', values, from: Math.min(...hours) };
  }
  if (!summary.days.length) return { unit: 'day', values: [] };
  const first = summary.days[0][0];
  const start = periodRange(period, now).from ?? first;
  const routed = new Map(
    summary.days.map(([key, day]) => [key, Object.values(day.cells).reduce((s, c) => s + c[1], 0)]),
  );
  const values = [];
  const [y, m, d] = start.split('-').map(Number);
  for (let i = 0; ; i += 1) {
    const key = dayKey(new Date(y, m - 1, d + i).getTime());
    if (key > dayKey(now)) break;
    values.push(routed.get(key) ?? 0);
  }
  if (values.length <= WEEKLY_AFTER) return { unit: 'day', values, from: start };
  const weeks = [];
  for (let i = 0; i < values.length; i += 7) weeks.push(values.slice(i, i + 7).reduce((s, v) => s + v, 0));
  return { unit: 'week', values: weeks, from: start };
}

// What the period's numbers point at, evidence only: answer quality is not measured, so no line says which model to
// use. The (activity, tier) cell that carried a quarter or more of the cost, the switch writes that ate 15% or more of
// the cheaper-model saving, and the cell that ran most above your model. None below INSIGHT_REPLIES replies.
export function insights(summary) {
  if (summary.replies < INSIGHT_REPLIES || !(summary.routedUsd > 0)) return [];
  const cells = new Map();
  for (const [key, sums] of Object.entries(summary.cells)) {
    const { activity, tier } = cellParts(key);
    const id = `${activity}|${tier}`;
    const cell = cells.get(id) ?? { activity, tier, sums: CELL_SUMS.map(() => 0), cells: {} };
    cell.sums = addSums(cell.sums, sums);
    cell.cells[key] = sums;
    cells.set(id, cell);
  }
  const out = [];
  const costliest = [...cells.values()].sort((a, b) => b.sums[1] - a.sums[1])[0];
  const share = costliest.sums[1] / summary.routedUsd;
  if (share >= 0.25 && cells.size > 1)
    out.push({
      kind: 'cost',
      activity: costliest.activity,
      tier: costliest.tier,
      share,
      route: mostlyOn(costliest.cells),
    });
  const saving = -summary.cheaperUsd;
  if (saving > 0 && summary.switchUsd / saving >= 0.15)
    out.push({ kind: 'switch', share: summary.switchUsd / saving, usd: summary.switchUsd });
  const stronger = [...cells.values()].sort((a, b) => b.sums[4] - a.sums[4])[0];
  if (stronger.sums[4] >= 0.005)
    out.push({
      kind: 'stronger',
      activity: stronger.activity,
      tier: stronger.tier,
      usd: stronger.sums[4],
      route: mostlyOn(stronger.cells),
    });
  return out;
}
