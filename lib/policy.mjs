// Switching policy v0 (docs/architecture.md): stickiness, escalation floor, cost-gated votes.
import { rank, resolveRoute, routeSpec, TIERS } from './config.mjs';
import * as nativeCosts from './cost.mjs';

// Whether an answer is about the task already running: a review inside a turn (facts.midTurn), or a new prompt the
// classifier scores as a continuation. On the same task either way is open, but a cheaper route waits for
// facts.downAllowed: the dwell since the last model change and a passed verification.
export function sameTaskOf(config, advice, facts) {
  return Boolean(facts.midTurn) || (advice?.continuation ?? 0) >= config.policy.continuationMass;
}

export function initialState() {
  return { turn: 0, votes: [], holdUntilTurn: 0, escalatedSignature: null };
}

// Returns { tier, reason, state, estimate }. `baseline` is the tier used when nothing argues otherwise. Tiers rank the
// choice; prices come from routes: each candidate tier at `routeFor(tier)`, the incumbent at the route it runs on.
// `escalateTo(incumbent)` names the tier repeated failures move to, or null when no tier helps: then the failure
// signature is not consumed.
export function decide({
  config,
  facts,
  advice,
  state,
  baseline,
  now,
  costs = nativeCosts,
  routeFor = (tier) => resolveRoute(config, tier),
  incumbentRoute = null,
  escalateTo = (tier) => TIERS[rank(tier) + 1] ?? null,
}) {
  const next = { ...state, turn: state.turn + 1, votes: [...state.votes] };
  const incumbent = facts.lastRoute && TIERS.includes(facts.lastRoute) ? facts.lastRoute : baseline;
  const current = incumbentRoute ?? routeFor(incumbent);
  const stay = (reason, estimate = null) => result(incumbent, reason, next, estimate);

  const target = facts.failure && facts.failure.signature !== next.escalatedSignature ? escalateTo(incumbent) : null;
  if (target) {
    next.escalatedSignature = facts.failure.signature;
    next.holdUntilTurn = next.turn + config.policy.escalationHoldTurns;
    next.votes = [];
    const gated = cashGate(config, routeFor(target), facts, now, costs, routeFor);
    return gated.blocked ? gatedResult(gated, incumbent, next) : result(target, 'escalation', next);
  }
  if (next.turn <= next.holdUntilTurn) return stay('hold');
  if (!advice) return stay('no-advice');
  if (advice.choice === 'uncertain') return stay('uncertain');

  const choice = advice.choice;
  next.votes = [...next.votes.slice(-2), { tier: choice, turn: next.turn }];
  if (rank(choice) === rank(incumbent)) return stay('same-tier');
  // Before the first measured reply of a history there is no cache it built, so staying protects nothing and one
  // vote is enough. Facts without the field keep the streak.
  const fresh = facts.historyMeasured === false;
  const upgradeVotes = fresh ? 1 : config.policy.upgradeVotes;
  const downgradeVotes = fresh ? 1 : config.policy.downgradeVotes;

  if (rank(choice) > rank(incumbent)) {
    const upgrade = massAbove(advice.probabilities, incumbent);
    const gated = cashGate(config, routeFor(choice), facts, now, costs, routeFor);
    if (gated.blocked) return gatedResult(gated, incumbent, next);
    const tax = Math.max(0, costs.switchingTaxUsd(config, routeFor(choice), current, facts, now));
    const threshold =
      config.policy.upgradeBase + config.policy.upgradeSlope * (tax / (tax + config.policy.upgradePivotUsd));
    const jump = rank(choice) - rank(incumbent) >= 2 && upgrade >= config.policy.jumpConfidence;
    const streak = trailing(next.votes, (v) => rank(v.tier) > rank(incumbent));
    const cache = {
      candidate: cacheOf(config, routeFor(choice), facts, now, costs),
      incumbent: cacheOf(config, current, facts, now, costs),
    };
    const estimate = { taxUsd: tax, threshold, upgradeMass: upgrade, streak, cache };
    if (jump || (streak >= upgradeVotes && upgrade >= threshold))
      return result(choice, jump ? 'jump' : 'upgrade', next, estimate);
    return stay('upgrade-pending', estimate);
  }

  // The move lands on the cheapest tier the answer supports as a whole: from the choice up to just below the
  // incumbent, the first tier whose mass at or below it clears its bar. A split answer (micro 0.8, low 0.16) on high
  // moves to low instead of waiting for micro alone to reach the bar. A pending stay reports the choice's estimate.
  let pending = null;
  for (const target of TIERS.filter((t) => rank(t) >= rank(choice) && rank(t) < rank(incumbent))) {
    const support = massAtOrBelow(advice.probabilities, target);
    const streak = trailing(next.votes, (v) => rank(v.tier) <= rank(target));
    // A downgrade is not always cheaper this turn: a cold candidate next to a warm incumbent can pay a bigger cache
    // write than it saves. The bar rises with that cost, net of what the next turns save, the way the upgrade bar does.
    const tax = costs.downgradeTaxUsd(
      config,
      routeFor(target),
      current,
      facts,
      now,
      config.policy.downgradeHorizonTurns,
    );
    const threshold =
      config.policy.downgradeMass + config.policy.downgradeSlope * (tax / (tax + config.policy.downgradePivotUsd));
    const estimate = { downgradeMass: support, streak, taxUsd: tax, threshold };
    pending ??= estimate;
    if (support < threshold || streak < downgradeVotes) continue;
    if (sameTaskOf(config, advice, facts) && !facts.downAllowed) return stay('downgrade-held', estimate);
    const gated = cashGate(config, routeFor(target), facts, now, costs, routeFor);
    return gated.blocked ? gatedResult(gated, incumbent, next) : result(target, 'downgrade', next, estimate);
  }
  return stay('downgrade-pending', pending);
}

// Share of a model's window the next request may fill. The estimate leaves out the new prompt and tool
// results, so a model drops out before the conversation reaches its limit.
export const CONTEXT_FILL = 0.8;

// The lowest tier at or above `tier` whose model fits `tokens` of context. Routes need not grow in window
// with rank, so the search falls back to any tier that fits, then to the largest window, keeping `tier` on a tie.
export function fitTier(config, tier, tokens, routeFor = (t) => resolveRoute(config, t)) {
  const windowOf = (t) => routeSpec(config, routeFor(t)).contextWindow;
  const fits = (t) => tokens <= windowOf(t) * CONTEXT_FILL;
  if (fits(tier)) return tier;
  return (
    TIERS.slice(rank(tier)).find(fits) ??
    TIERS.find(fits) ??
    TIERS.reduce((best, t) => (windowOf(t) > windowOf(best) ? t : best), tier)
  );
}

// Cold-write guard: an automatic route (upgrade, downgrade, escalation or activity move) to a credits-billed model whose cache is not warm must not start with a cache
// write above `cashCapUsd`. It bounds that one estimated write, not the spend of the turn: a warm cache passes, and
// output is not counted.
export function cashGate(config, route, facts, now, costs, routeFor = (tier) => resolveRoute(config, tier)) {
  if (routeSpec(config, route).billing !== 'credits') return { blocked: false };
  if (costs.isWarm(facts.models[costs.routeCacheKey(config, route, facts.effort)], now, config.cache))
    return { blocked: false };
  const cold = costs.coldWriteUsd(config, route.model, costs.nextContextTokens(facts));
  if (cold <= config.policy.cashCapUsd) return { blocked: false };
  const fallback = [...TIERS].reverse().find((t) => routeSpec(config, routeFor(t)).billing === 'plan');
  const estimate = {
    coldUsd: cold,
    cap: config.policy.cashCapUsd,
    cache: cacheOf(config, route, facts, now, costs),
  };
  return { blocked: true, fallback, estimate };
}

// A blocked switch lands on the strongest plan tier when that is above the incumbent, else stays.
function gatedResult(gated, incumbent, state) {
  const tier = gated.fallback && rank(gated.fallback) > rank(incumbent) ? gated.fallback : incumbent;
  return result(tier, 'cash-gate', state, gated.estimate);
}

function cacheOf(config, route, facts, now, costs) {
  return costs.cacheState(facts.models[costs.routeCacheKey(config, route, facts.effort)], now, config.cache);
}

function trailing(votes, predicate) {
  let count = 0;
  for (let i = votes.length - 1; i >= 0 && predicate(votes[i]); i -= 1) count += 1;
  return count;
}

function result(tier, reason, state, estimate = null) {
  return { tier, reason, state, estimate };
}

// Probability mass strictly above a tier; `uncertain` supports neither direction.
export function massAbove(probabilities, tier) {
  return TIERS.filter((t) => rank(t) > rank(tier)).reduce((sum, t) => sum + probabilities[t], 0);
}

export function massAtOrBelow(probabilities, tier) {
  return TIERS.filter((t) => rank(t) <= rank(tier)).reduce((sum, t) => sum + probabilities[t], 0);
}
