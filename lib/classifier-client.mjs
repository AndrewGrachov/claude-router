import { buildActivityRequest, buildRequest, parseActivityAnswer, parseAnswers } from './classifier-apis.mjs';
import {
  ACTIVITY_STEP_MIN_MS,
  FAILURES_TO_PAUSE,
  isTransientStatus,
  PAUSE_MS,
  RETRY_DELAY_MS,
  retryDelayMs,
} from './classifier-contract.mjs';
import { activeClassifier } from './config.mjs';

// A classifier answer is a few hundred bytes; anything far larger is not one.
const MAX_ANSWER_CHARS = 16_384;

class AdviceError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

// Owned by one Mod activation. It survives history resets; the host cancels its work on unload. An exclusive client
// (the main turn's) answers `busy` while a request is in flight, so a late answer never overlaps the next turn's; the
// spawn path's client is not exclusive, so a parent that spawns several agents at once gets an answer for each.
// `config` with the active classifier asking for `model`.
const withModel = (config, model) => ({
  ...config,
  classifiers: { ...config.classifiers, [config.classifier]: { ...activeClassifier(config), model } },
});

export class ClassifierClient {
  constructor({ now = Date.now, health = null, exclusive = true } = {}) {
    this.now = now;
    this.exclusive = exclusive;
    this.pending = null;
    this.active = false;
    this.restore(health);
  }

  restore(health) {
    this.failures =
      Number.isInteger(health?.failures) && health.failures >= 0 ? Math.min(health.failures, FAILURES_TO_PAUSE) : 0;
    this.pausedUntil = Number.isFinite(health?.pausedUntil) ? health.pausedUntil : 0;
  }

  snapshot() {
    return { failures: this.failures, pausedUntil: this.pausedUntil };
  }

  // `model` is the classifier's model with its settings filled in, and `missing` what resolveCredentials found missing
  // (a gateway URL that is not https reads as no endpoint here otherwise); without them the entry's own model.
  async ask({ request, sleep, config: entryConfig, apiKey, endpoint, model, missing, prompt, turns, signal }) {
    const config = model ? withModel(entryConfig, model) : entryConfig;
    if (missing === 'bad-url') return { advice: null, error: missing };
    if (!apiKey && activeClassifier(config).keyOption !== null) return { advice: null, error: 'missing-key' };
    if (!endpoint) return { advice: null, error: 'missing-account' };
    if (signal?.aborted) return { advice: null, error: 'cancelled' };
    if (this.now() < this.pausedUntil) return { advice: null, error: 'paused' };
    if (this.exclusive && (this.active || this.pending)) return { advice: null, error: 'busy' };
    this.active = true;
    try {
      const advice = await this.complete({ request, sleep, config, apiKey, endpoint, prompt, turns, signal });
      this.failures = 0;
      this.pausedUntil = 0;
      return { advice, error: null };
    } catch (error) {
      const code = signal?.aborted ? 'cancelled' : error instanceof AdviceError ? error.code : 'unreachable';
      if (code !== 'cancelled' && code !== 'policy') {
        this.failures = Math.min(this.failures + 1, FAILURES_TO_PAUSE);
        if (this.failures >= FAILURES_TO_PAUSE) this.pausedUntil = this.now() + PAUSE_MS;
      }
      return { advice: null, error: code };
    } finally {
      this.active = false;
    }
  }

  async complete({ request, sleep, config, apiKey, endpoint, prompt, turns, signal }) {
    const deadline = this.now() + activeClassifier(config).timeoutMs;
    const body = JSON.stringify(buildRequest(config, prompt, turns));
    const transport = { request, sleep, apiKey, endpoint, signal };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const remaining = deadline - this.now();
      if (signal?.aborted) throw new AdviceError('cancelled');
      if (remaining <= 0) throw new AdviceError('timeout');
      let response;
      try {
        response = await this.send(transport, body, remaining);
      } catch (error) {
        if (signal?.aborted) throw new AdviceError('cancelled');
        if (error instanceof AdviceError) throw error;
        if (/policy|denied|(?<!conn)refus|network access|nonessential/i.test(String(error?.message)))
          throw new AdviceError('policy');
        if (attempt === 1) throw new AdviceError('unreachable');
        if (RETRY_DELAY_MS >= deadline - this.now()) throw new AdviceError('timeout');
        await sleep(RETRY_DELAY_MS, { signal });
        continue;
      }
      if (signal?.aborted) throw new AdviceError('cancelled');
      if (this.now() >= deadline) throw new AdviceError('timeout');
      if (response.ok) {
        let advice;
        try {
          if (typeof response.text !== 'string' || response.text.length > MAX_ANSWER_CHARS)
            throw new AdviceError('malformed');
          advice = parseAnswers(config, JSON.parse(response.text));
          if (this.now() >= deadline) throw new AdviceError('timeout');
        } catch (error) {
          if (error instanceof AdviceError) throw error;
          throw new AdviceError('malformed');
        }
        const step = buildActivityRequest(config, prompt, turns);
        if (!step || deadline - this.now() < ACTIVITY_STEP_MIN_MS) return advice;
        return { ...advice, activity: await this.activity(transport, config, step, deadline) };
      }
      if (response.status === 401 || response.status === 403) throw new AdviceError('auth');
      if (!isTransientStatus(response.status) || attempt === 1) throw new AdviceError('http');
      const value = response.headers?.['retry-after'];
      const wait = retryDelayMs(typeof value === 'string' ? value : null, this.now()) ?? RETRY_DELAY_MS;
      if (wait >= deadline - this.now()) throw new AdviceError('timeout');
      await sleep(wait, { signal });
    }
    throw new AdviceError('unreachable');
  }

  // The optional activity step: one attempt, no retry, inside the route's deadline. Any failure but an abort reads as
  // no activity and leaves the route advice and the classifier's health as they are.
  async activity(transport, config, step, deadline) {
    let activity = null;
    try {
      const response = await this.send(transport, JSON.stringify(step), deadline - this.now());
      if (
        response.ok &&
        typeof response.text === 'string' &&
        response.text.length <= MAX_ANSWER_CHARS &&
        this.now() < deadline
      )
        activity = parseActivityAnswer(config, JSON.parse(response.text));
    } catch {}
    if (transport.signal?.aborted) throw new AdviceError('cancelled');
    return activity;
  }

  // One POST raced against the time left. The call holds the in-flight slot until it settles, even past a timeout,
  // so a late answer never overlaps the next request.
  async send({ request, sleep, apiKey, endpoint, signal }, body, remaining) {
    const call = Promise.resolve().then(() =>
      request(endpoint, {
        method: 'POST',
        headers: { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), 'content-type': 'application/json' },
        body,
      }),
    );
    this.pending = call;
    const release = () => {
      if (this.pending === call) this.pending = null;
    };
    call.then(release, release);
    const timer = new AbortController();
    const cancel = () => timer.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      return await Promise.race([
        call,
        sleep(remaining, { signal: timer.signal }).then(() => {
          throw new AdviceError('timeout');
        }),
      ]);
    } finally {
      signal?.removeEventListener('abort', cancel);
      timer.abort();
    }
  }
}
