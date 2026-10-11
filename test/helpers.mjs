import { mergeStores, STORE_KEY, STORE_PREFIX } from '../lib/activity-stats.mjs';

export const T0 = Date.parse('2026-09-22T10:00:00Z');

export function user(text) {
  return { role: 'user', content: [{ type: 'text', text }] };
}

export function toolResult(text, { isError = false } = {}) {
  return {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 't', is_error: isError, content: [{ type: 'text', text }] },
      { type: 'text', text: '<system-reminder>ignored</system-reminder>' },
    ],
  };
}

export function assistant(text, tools = []) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }, ...tools.map((name) => ({ type: 'tool_use', id: 't', name, input: {} }))],
  };
}

export function body(messages, extra = {}) {
  return {
    model: 'jev-router',
    max_tokens: 1000,
    stream: true,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
    system: [],
    tools: [],
    messages,
    ...extra,
  };
}

export function memory({ lastRoute = null, models = {}, lastRequest = null, state = null } = {}) {
  return { lastRoute, models, lastRequest, state };
}

// The models that keep one cache across efforts (code.claude.com/docs/en/prompt-caching), written out so the fixtures
// do not lean on the code under test.
export const EFFORT_SHARED = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'];

// The cache the router observed for a reply: one per effort on a provider that splits it (`effortSplits`) or on a
// model outside EFFORT_SHARED, else one per model.
export function served(
  modelId,
  { tokens = 20_000, output = 500, ttl = '1h', at = T0, effort = null, effortSplits = false } = {},
) {
  const key = effort && (effortSplits || !EFFORT_SHARED.includes(modelId)) ? `${modelId}@${effort}` : modelId;
  return {
    lastRequest: { model: modelId, tokens, outputTokens: output, cacheReadTokens: tokens, ttl, at },
    models: { [key]: { lastAt: at, prefixTokens: tokens + output, ttl } },
  };
}

export function advice(choice, probabilities, { continuation = 0, confidence = 0.9 } = {}) {
  const p = { micro: 0, low: 0, medium: 0, high: 0, uncertain: 0, ...probabilities };
  return { choice, confidence, probabilities: p, continuation };
}

// `activity`, when given, is the activity answer's probabilities; its choice is the most likely one.
export function jevResponse(choice, probabilities, continuation = 0, activity = null) {
  const [activityChoice] = Object.entries(activity ?? {}).sort((a, b) => b[1] - a[1])[0] ?? [];
  return {
    answers: {
      route: { type: 'choice', choice, confidence: 0.9, probabilities },
      continuation: { type: 'noul', noul: continuation },
      ...(activity
        ? { activity: { type: 'choice', choice: activityChoice, confidence: 0.9, probabilities: activity } }
        : {}),
    },
  };
}

// Every session's activity stats record and the shared key from before 1.10.3 added up, as the readout sums them.
export const savedStats = (preferences) =>
  mergeStores(
    [...preferences.entries()]
      .filter(([key]) => key.startsWith(STORE_PREFIX) || key === STORE_KEY)
      .map(([, value]) => value),
  );

// The same without `since`, which depends on the clock.
export function savedCounts(preferences) {
  const { since: _since, ...counts } = savedStats(preferences);
  return counts;
}
