// Usage records the Usage and Now tab tests share: this session today and another session's older replies.
import { emptyUsage, mergeUsage, recordUsage, replyEntry } from '../lib/usage.mjs';

export const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();
export const NOW = at(2026, 10, 13, 16);
const USAGE = { input_tokens: 100, cache_read_input_tokens: 800, cache_creation_input_tokens: 200, output_tokens: 10 };
// Per reply, against Opus 5.5 · xhigh as yours; each adds up: yours + cheaper + stronger + switch = routed.
const KINDS = {
  code: {
    activity: 'code',
    tier: 'medium',
    route: 'claude-sonnet-5-5@high',
    routedUsd: 0.3,
    yoursUsd: 0.5,
    cheaperUsd: -0.22,
    switchUsd: 0.02,
  },
  explore: {
    activity: 'explore',
    tier: 'low',
    route: 'claude-haiku-5-5@high',
    routedUsd: 0.05,
    yoursUsd: 0.4,
    cheaperUsd: -0.36,
    switchUsd: 0.01,
  },
  hard: {
    activity: 'code',
    tier: 'high',
    route: 'claude-opus-5-5@xhigh',
    routedUsd: 0.5,
    yoursUsd: 0.5,
    cheaperUsd: 0,
    switchUsd: 0,
  },
};
export const reply = (when, kind) => {
  const { activity, tier, route, ...prices } = KINDS[kind];
  return replyEntry({
    at: when,
    activity,
    tier,
    route,
    yours: 'claude-opus-5-5',
    reply: { strongerUsd: 0, ...prices },
    replies: {
      'claude-haiku-5-5': { yoursUsd: prices.yoursUsd * 0.2 },
      'claude-sonnet-5-5': { yoursUsd: prices.yoursUsd * 0.6 },
      'claude-opus-5-5': { yoursUsd: prices.yoursUsd },
    },
    usage: USAGE,
  });
};
// This session today: 6 code, 10 explore and 4 hard replies, two per turn, between 9:00 and 13:00, 4 route switches.
function sessionRecord() {
  const kinds = [...Array(6).fill('code'), ...Array(10).fill('explore'), ...Array(4).fill('hard')];
  let record = emptyUsage();
  for (let i = 0; i < kinds.length; i += 2) {
    const when = at(2026, 10, 13, 9 + Math.floor(i / 5));
    record = recordUsage(record, [reply(when, kinds[i]), reply(when, kinds[i + 1])], {
      switched: i < 6 ? 'tier' : i === 6 ? 'activity' : null,
      now: when,
    });
  }
  return record;
}
export const SESSION = sessionRecord();
// Another session: one code reply yesterday, one on October 1.
export const OTHER = [at(2026, 10, 12), at(2026, 10, 1)].reduce(
  (record, when) => recordUsage(record, [reply(when, 'code')], { now: when }),
  emptyUsage(),
);
export const STORE = mergeUsage([SESSION, OTHER]);
