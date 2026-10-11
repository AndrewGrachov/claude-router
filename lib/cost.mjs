import { EFFORTS, routeSpec } from './config.mjs';

// Models that keep one prompt cache across effort levels with an API key or a Claude subscription
// (code.claude.com/docs/en/prompt-caching, "Changing effort level"). A dated snapshot or a `[1m]` suffix is the same
// model. `config.effortSplitsCache`, set by the hook from the session's provider, gives every effort its own cache.
const EFFORT_SHARED_CACHE = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'];

export function effortSharesCache(config, modelId) {
  if (config.effortSplitsCache || typeof modelId !== 'string') return false;
  const bare = modelId.replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '');
  return EFFORT_SHARED_CACHE.includes(bare);
}

export function cacheKey(config, modelId, effort) {
  return effort && !effortSharesCache(config, modelId) ? `${modelId}@${effort}` : modelId;
}

export function clampEffort(wanted, supported) {
  if (!wanted || supported.length === 0) return null;
  if (supported.includes(wanted)) return wanted;
  for (let i = EFFORTS.indexOf(wanted); i >= 0; i -= 1) if (supported.includes(EFFORTS[i])) return EFFORTS[i];
  return supported[0];
}

// The one place a model's list prices become rates: per million tokens for a request whose prompt (input, cache read
// and cache write) is `promptTokens`, with the model's long-context multiplier above its threshold. Every estimate
// prices through here.
export function ratesAt(model, promptTokens) {
  const k = model.longContext && promptTokens > model.longContext.above ? model.longContext.multiplier : 1;
  return {
    input: model.input * k,
    cacheRead: model.cacheRead * k,
    output: Number.isFinite(model.output) ? model.output * k : undefined,
  };
}

export function nextContextTokens(facts) {
  const previous = facts.lastRequest ? facts.lastRequest.tokens + facts.lastRequest.outputTokens : 0;
  return Math.max(previous, Number.isFinite(facts.contextTokens) ? facts.contextTokens : 0);
}

// Functions below take a route { model, effort }, not a tier: one tier can run on different routes.
export function routeEffort(config, route, sentEffort) {
  const model = routeSpec(config, route);
  if (model.efforts.length === 0) return null;
  if (route.effort) return clampEffort(route.effort, model.efforts);
  if (typeof sentEffort === 'number' && Number.isFinite(sentEffort)) return sentEffort;
  return clampEffort(sentEffort, model.efforts);
}

export function routeCacheKey(config, route, sentEffort) {
  return cacheKey(config, routeSpec(config, route).id, routeEffort(config, route, sentEffort));
}

export function isWarm(state, now, cache) {
  return Boolean(
    state?.prefixTokens > 0 && now >= state.lastAt && now < state.lastAt + cache.ttlMs['5m'] - cache.warmMarginMs,
  );
}

export function cacheState(state, now, cache) {
  return isWarm(state, now, cache) ? 'fresh' : 'unknown';
}

// Bounds are scenarios, never an independent ledger. Unknown incumbent cache can still be served.
export function inputBounds(config, route, tokens, facts, now) {
  const model = ratesAt(routeSpec(config, route), tokens);
  const state = facts.models[routeCacheKey(config, route, facts.effort)];
  const prefix = Math.min(state?.prefixTokens ?? tokens, tokens);
  const fresh = isWarm(state, now, config.cache);
  const maximumWrite = model.input * Math.max(...Object.values(config.cache.writeMultiplier));
  return {
    min: (model.cacheRead * prefix + model.input * (tokens - prefix)) / 1e6,
    max: fresh ? (model.cacheRead * prefix + maximumWrite * (tokens - prefix)) / 1e6 : (maximumWrite * tokens) / 1e6,
  };
}

export function coldWriteUsd(config, alias, tokens) {
  return (
    (ratesAt(config.models[alias], tokens).input * Math.max(...Object.values(config.cache.writeMultiplier)) * tokens) /
    1e6
  );
}

export function switchingTaxUsd(config, candidate, incumbent, facts, now) {
  const tokens = nextContextTokens(facts);
  return (
    inputBounds(config, candidate, tokens, facts, now).max - inputBounds(config, incumbent, tokens, facts, now).min
  );
}

// The next request on `candidate` against `incumbent` as a range: the input bounds crossed, plus the output difference
// at the last reply's length when both routes have an output price, as switchEconomics compares.
export function nextTurnRange(config, candidate, incumbent, facts, now) {
  const tokens = nextContextTokens(facts);
  const proposed = inputBounds(config, candidate, tokens, facts, now);
  const current = inputBounds(config, incumbent, tokens, facts, now);
  const [to, from] = [ratesAt(routeSpec(config, candidate), tokens), ratesAt(routeSpec(config, incumbent), tokens)];
  const outputTokens = facts.lastRequest?.outputTokens ?? 0;
  const output = to.output > 0 && from.output > 0 ? ((to.output - from.output) * outputTokens) / 1e6 : 0;
  return { minUsd: proposed.min - current.max + output, maxUsd: proposed.max - current.min + output };
}

export function switchEconomics(config, candidate, incumbent, facts, now) {
  const tokens = nextContextTokens(facts);
  const proposed = ratesAt(routeSpec(config, candidate), tokens);
  const current = ratesAt(routeSpec(config, incumbent), tokens);
  if (!(proposed.output > 0) || !(current.output > 0)) return null;
  const outputTokens = facts.lastRequest?.outputTokens ?? 0;
  const output = ((proposed.output - current.output) * outputTokens) / 1e6;
  const nextTurnUsd = switchingTaxUsd(config, candidate, incumbent, facts, now) + output;
  const laterTurnUsd = ((proposed.cacheRead - current.cacheRead) * tokens) / 1e6 + output;
  const paybackTurns =
    nextTurnUsd <= 0 && laterTurnUsd <= 0
      ? 0
      : nextTurnUsd > 0 && laterTurnUsd < 0
        ? Math.ceil(nextTurnUsd / -laterTurnUsd)
        : null;
  return { nextTurnUsd, laterTurnUsd, paybackTurns, outputTokens };
}

export function downgradeTaxUsd(config, candidate, incumbent, facts, now, turns) {
  const estimate = switchEconomics(config, candidate, incumbent, facts, now);
  if (!estimate) return Math.max(0, switchingTaxUsd(config, candidate, incumbent, facts, now));
  return Math.max(0, estimate.nextTurnUsd + (turns - 1) * estimate.laterTurnUsd);
}
