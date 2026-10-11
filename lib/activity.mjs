// Activity routing (docs/plans/2026-10-09-activity-routing-plan.md §5): which activity a turn applies, how two routes
// compare, and when a route change inside one tier is worth it. Pure.
import { ACTIVITIES, EFFORTS, resolveRoute, routeSpec } from './config.mjs';
import { routeEffort } from './cost.mjs';
import { cashGate, sameTaskOf } from './policy.mjs';

// The classifier's activity when it names one with at least `policy.activityMass`, else null: uncertain, a weak
// label, or no answer resolve to the tier's base route.
export function acceptActivity(config, advice) {
  const answer = advice?.activity;
  if (!answer || !ACTIVITIES.includes(answer.choice)) return null;
  return answer.probabilities?.[answer.choice] >= config.policy.activityMass ? answer.choice : null;
}

// 1 when route `a` is stronger than `b`, -1 when cheaper, 0 when equal in strength, null when they cannot be ordered.
// Models order by configured output price, then effort. A null effort is `sentEffort`, the one Claude Code sends, as
// the request would carry it; without a named effort on both sides (none sent, or a numeric budget) two different
// efforts do not order. A missing output price orders only against the same model.
export function compareRoutes(config, a, b, sentEffort) {
  if (a.model !== b.model) {
    const [pa, pb] = [routeSpec(config, a).output, routeSpec(config, b).output];
    if (!Number.isFinite(pa) || !Number.isFinite(pb)) return null;
    if (pa !== pb) return Math.sign(pa - pb);
  }
  const [ea, eb] = [routeEffort(config, a, sentEffort), routeEffort(config, b, sentEffort)];
  if (ea === eb) return 0;
  if (!EFFORTS.includes(ea) || !EFFORTS.includes(eb)) return null;
  return Math.sign(EFFORTS.indexOf(ea) - EFFORTS.indexOf(eb));
}

// Whether two routes send the same request: the same model at the same effort once a session effort is resolved.
export const sameRequest = (config, a, b, sentEffort) =>
  a.model === b.model && routeEffort(config, a, sentEffort) === routeEffort(config, b, sentEffort);

// The activity a turn runs with, given the incumbent cell `{ tier, activity }` and its resolved `route`. Without
// advice, or without an activity answer (a skipped, failed or malformed activity step), the incumbent's activity
// stays: a flaky step must not move the route every turn. On the same task (sameTaskOf: a review inside a turn, or a
// continuation prompt) a stronger label is taken at once (explore, then code), and a weaker one only with at least
// `downgradeMass` probability once facts.downAllowed holds: the dwell has passed and a verification passed since the
// last model change. An unclear label keeps the running activity.
export function chooseActivity(config, advice, incumbent, sentEffort, facts = {}) {
  if (!advice?.activity) return incumbent.activity;
  if (!sameTaskOf(config, advice, facts)) return acceptActivity(config, advice);
  const label = advice.activity.choice;
  if (!ACTIVITIES.includes(label)) return incumbent.activity;
  const order = compareRoutes(config, resolveRoute(config, incumbent.tier, label), incumbent.route, sentEffort);
  if (order > 0) return label;
  const mass = advice.activity.probabilities?.[label] ?? 0;
  if (order < 0 && facts.downAllowed && mass >= config.policy.downgradeMass) return label;
  return incumbent.activity;
}

// A route change inside the incumbent's tier, `from` → `to`. Up on evidence: `mass`, the label's probability (1 for
// the base route), must clear the tier upgrade bar for this switching tax. Down on economics: the move must pay back
// its cache write within the downgrade horizon. A pair that does not order (an unpriced model, a numeric effort, two
// models at one price) counts as up: it needs evidence, and the base route is always reachable. Labels alone never
// switch, so one vote is enough. During an escalation hold only a stronger route may be taken. Returns
// { move, reason, estimate }.
export function lateralMove({ config, from, to, mass, hold, facts, now, costs }) {
  const order = compareRoutes(config, to, from, facts.effort);
  if (hold && !(order > 0)) return { move: false, reason: 'hold', estimate: null };
  const p = config.policy;
  let estimate;
  if (order === -1) {
    estimate = { taxUsd: costs.downgradeTaxUsd(config, to, from, facts, now, p.downgradeHorizonTurns) };
    // Before the first measured reply no cache of this history exists, though the tax prices an unknown one as warm:
    // staying protects nothing.
    const fresh = facts.historyMeasured === false;
    if (estimate.taxUsd > 0 && !fresh) return { move: false, reason: 'activity-pending', estimate };
  } else {
    const tax = Math.max(0, costs.switchingTaxUsd(config, to, from, facts, now));
    const threshold = p.upgradeBase + p.upgradeSlope * (tax / (tax + p.upgradePivotUsd));
    estimate = { taxUsd: tax, threshold, upgradeMass: mass };
    if (mass < threshold) return { move: false, reason: 'activity-pending', estimate };
  }
  const gated = cashGate(config, to, facts, now, costs);
  if (gated.blocked) return { move: false, reason: 'cash-gate', estimate: gated.estimate };
  return { move: true, reason: order === -1 ? 'activity-down' : 'activity-up', estimate };
}
