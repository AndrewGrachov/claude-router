# Evaluation

The native Mod has no measured savings result. The pane reports Claude's own usage and configured-price scenarios. Its one counterfactual is [routing vs your model](#routing-vs-your-model), an estimate at configured list prices, not a bill or a measured saving.

This page separates an older gateway experiment from a shadow replay of native policy. Neither result measures answer quality or proves lower real spend. [Activity routing](#activity-routing) adds two checks of the activity label, with no savings result either.

## Historical gateway experiment

These figures are retained from the earlier gateway implementation. They do not evaluate the native Mod or its current routes. The snapshot covers 26 Claude Code sessions and 1,611 requests from 2026-09-23 09:05 UTC through 2026-09-24 06:00 UTC. Jev advised on 111 prompts.

![Historical gateway model share and configured-price costs](tier-share.svg)

The original list-price comparison was:

| Scenario                                        | Estimated cost | Difference from router |
| ----------------------------------------------- | -------------: | ---------------------: |
| Always Opus at `xhigh`                          |        $166.26 | Router was 15.5% lower |
| Strongest model selected for each whole session |        $146.54 |  Router was 4.1% lower |
| Earlier gateway router                          |        $140.55 |                      — |

The session-level baseline assumes a user knows the strongest tier needed by each session and uses it for every request. All scenarios reuse the router's token and output counts. The estimate holds stronger-model output constant, so it does not capture any change in output length. The [original evaluation method](#historical-method-and-limits) lists the limits.

This is one developer's short trace at configured list prices. It does not include a quality review. Do not use these values as expected results for the native Mod.

## Native shadow replay

The native replay uses an aggregate Team-session trace from 2026-09-23 through 2026-10-04. The checked-in result is [`trace-evaluation.json`](../experiments/mod-router/results/trace-evaluation.json), produced by [`trace-eval.mjs`](../experiments/mod-router/scripts/trace-eval.mjs).

| Coverage item                                               |                            Result |
| ----------------------------------------------------------- | --------------------------------: |
| Team rows                                                   |        24,408 across 112 sessions |
| Main-conversation decision rows                             |                            11,619 |
| Main decisions with Jev advice                              |                                37 |
| Advised decisions replayed at both cache-prefix bounds      |                          37 of 37 |
| Decisions with a different route or reason between policies |                           0 of 37 |
| Differing switches and estimated switch cost                | 0; no switch cost can be computed |

The legacy replay matched the logged tier and reason for 1,704 of 1,704 replayable decisions. On the 37 advised main decisions, both policies produced the same route and reason. This replay therefore shows no native routing difference and cannot support a savings claim.

Eight advised decisions reached a switching-cost threshold calculation. The native configured-price tax ranged from $0.028660 to $3.471293 and the threshold from 0.860483 to 0.953675. These are shadow estimates for individual next requests, not bills or additive savings.

The old log records cache reads but not uncached input or cache-creation tokens. The native replay tests two prefix bounds: cache reads alone and the full observed input. All 37 decisions matched at both bounds. That is a bound-stability check, not an exact reconstruction of native cache state.

### Reproduce the native replay

Run this command with the Team `decisions.jsonl` log available in its usual Claude Code profile:

```sh
node experiments/mod-router/scripts/trace-eval.mjs
node --test experiments/mod-router/scripts/trace-eval.test.mjs
```

The script writes aggregate counts, reason histograms, route transitions, and shadow estimates. It excludes prompts, session identifiers, agent names, error text, headers, keys, and filesystem paths from the result. It reads the local profile log and writes the JSON result file.

## Activity routing

Activity routing has no measured result. The replay above predates it and covers tiers only. It is `on` by default since 1.7, with defaults chosen from Anthropic's published benchmarks and a list-price replay of one developer's sessions; [Activity routing](activity-routing.md#what-the-estimates-mean) gives that replay and its limits. The pane counts turns, requests, switches, and the turns `on` would route differently, with a configured list-price estimate of those turns' next requests, not a measured saving. Two checks look at the classifier's activity label.

The figures plan §11 tracks (tool agreement of at least 80% on `code` against `ops` and `explore`, Jev p95 latency of at most 450 ms, at most 1 tool-error escalation in 10 cheaper activity moves, the number of activity switches) are read from the Classifier tab's **ACROSS SESSIONS** block, which shows the counts kept since the last reset: **Code/ops/explore** for the tool agreement on turns the classifier answered `code`, `ops` or `explore`, **Agreement** and **Mismatch** for all of them, **Activity moves** for moves inside a tier taken and refused (a refusal by a hold or the credits cap included), **Escalations** for the tool-error escalations that followed a cheaper activity move in `on` while the turns stayed on its route in `on` (turning routing off, a turn with routing off, or a turn in `off` ends the watch, a pin in between does not, and an escalation the credits cap held counts). The active classifier's p95 wait is on its **Deadline** line on the same tab, above that block. Latency is kept in fixed buckets, so the p95 reads as a bound (`≤ 350 ms`); it is the wait for the classifier's answer, transient retries included, without the routing after it, so it compares with the probe's p95 below, and is not recorded with activity routing `off`. `/router` without a UI surface prints both agreements. The underlying counts are the per-session `activity:stats:v1:<session id>` and `activity:metrics:v1:<session id>` records described in [Architecture](architecture.md).

### Tool agreement

Each finished turn is labelled from the tools the assistant used, locally and at no cost. Only the bucket and counts are kept; no text or path is stored.

| Observed bucket | Rule, first match                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `code`          | An edit tool (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`) on a path that is not a doc path                                                |
| `docs`          | Edits only to paths ending `.md`, `.mdx`, `.rst`, or `.txt`, or under a `docs/` directory                                                   |
| `ops`           | A Bash command that is not read-only                                                                                                        |
| `read`          | Other tool use: reads, searches, web fetches, Task, TodoWrite, MCP tools, and Bash commands that only read, such as `ls`, `grep`, `cat`, or `git status` and `git diff` |
| `talk`          | No tool calls                                                                                                                               |

A subagent's edits and commands never reach the main transcript, so a turn that delegates its coding to a Task reads as `read`: agreement on `code` is understated for delegated work. A Bash command counts as read-only only when every command in the pipeline or list is on a short list of readers. Redirects, command substitution, and `find` with `-exec` or `-delete` are not read-only, and neither is any command the list does not name.

The classifier's activity agrees with the turn when the bucket is one it allows:

| Activity  | Allowed buckets        |
| --------- | ---------------------- |
| `code`    | `code`                 |
| `debug`   | `code`, `ops`, `read`  |
| `explore` | `read`, `talk`         |
| `plan`    | `talk`, `read`, `docs` |
| `review`  | `read`, `talk`         |
| `ops`     | `ops`, `read`          |
| `docs`    | `docs`                 |

Agreement is a weak check. It tells `code` from `ops` and `explore` well, but not `ops` from `explore` when the commands only read. It cannot tell `plan` from `review`, and it says nothing about whether the route was good enough. It does catch the costly mistake, a cheap route on a coding turn. The Classifier tab shows the session's count as `Agreement` under **THIS SESSION**, over the turns where the classifier gave an activity at or above `activityMass`, in `on` too when the route kept another activity. The counts kept across sessions hold the classifier's raw answer, `uncertain` and no answer included, against the bucket. The pane's **ACROSS SESSIONS** block counts agreement over the answers that name an activity; `uncertain` and no answer appear only in **Labelled**.

### Activity probe set

`test/fixtures/activity-probe.json` holds 70 synthetic prompts, ten for each activity, weighted to the boundary cases: "fix the deploy script" against "deploy the fix", "why does the test fail" against "make the test pass", short replies after a dialogue, and a review followed by a fix. It holds no real user text.

```sh
node scripts/probe-activity.mjs [classifier]
```

The script sends each prompt to one classifier as the router would ask it, with activity routing forced to `on`. It reads credentials as `probe-classifier.mjs` does and needs a classifier you can reach. The run is billed on a paid classifier, and it is run by hand, not in CI. It writes accuracy, an expected-by-answered confusion matrix, p50 and p95 latency against the classifier's deadline, and error counts to `experiments/mod-router/results/activity-probe-<classifier>.json`. For Ollama the latency covers both requests. It never prints a key.

Five probe results are checked in, run on 2026-10-09 and 2026-10-10 (UTC) with the synthetic set above: Jev against the live typesafe.ai API, OpenAI against the live Decisions API, Clef and Clef Flash against the live Cloudflare API, Ollama with `qwen3.5:9b` on an Apple M2 Pro laptop:

| Classifier |  Correct | p50 latency | p95 latency | Result file                                                                                          |
| ---------- | -------: | ----------: | ----------: | ---------------------------------------------------------------------------------------------------- |
| Jev        | 70 of 70 |      260 ms |      299 ms | [`activity-probe-jev.json`](../experiments/mod-router/results/activity-probe-jev.json)               |
| OpenAI     | 70 of 70 |      161 ms |      286 ms | [`activity-probe-openai.json`](../experiments/mod-router/results/activity-probe-openai.json)         |
| Clef       | 69 of 70 |      444 ms |      883 ms | [`activity-probe-clef.json`](../experiments/mod-router/results/activity-probe-clef.json)             |
| Clef Flash | 69 of 70 |      470 ms |      874 ms | [`activity-probe-clef-flash.json`](../experiments/mod-router/results/activity-probe-clef-flash.json) |
| Ollama     | 66 of 70 |     2986 ms |     3483 ms | [`activity-probe-ollama.json`](../experiments/mod-router/results/activity-probe-ollama.json)         |

Ollama's latency covers both requests and stays inside its 5000 ms deadline; on slower hardware the activity step is skipped when less than 300 ms remain. They measure the label on synthetic prompts, not routing quality or savings. The activity question costs little time: 30 alternating pairs of the same prompts, with and without it, gave Jev p50 259 ms both ways and p95 300 ms without, 306 ms with; OpenAI p50 163 ms and 162 ms, p95 296 ms and 349 ms. OpenAI's first request of a run took about 2.3 s of its 3000 ms deadline. The Classifier tab shows each result under its classifier, such as `activity probe 70/70 · p95 299 ms · Oct 10` (UTC date), when the classifier runs the probed model. The script regenerates `lib/probe-results.mjs` from the result files after each run; `npm run probe:results` does it alone, and a test fails when the two disagree. A run without a single activity answer (an activity or `uncertain`) or without a p95 latency, such as one with a revoked key or a model whose answers all lack the activity, exits with an error and writes neither file. `policy.activityMass` was not tuned on any classifier; run the probe before you trust it with a new one. Clef Omni has no probe result yet, so its Classifier tab row shows none.

## Routing vs your model

The Usage tab compares what routed replies cost with what the same tokens would cost on your model, the model `/model` selected at the session effort when each reply ran. It answers "at list prices, did routing spend more or less than my own model for this work". It does not answer whether the answers were as good.

Method, per main reply that routing chose:

- **Routed** prices the usage Claude reported (uncached input, cache read, cache write, output) on the model that served it.
- **Yours** prices the same tokens on each model in `router.json` at the session effort. The Usage tab keeps each reply against the model selected when it ran, and **What if** shows the period against each model alone; the two-row band and `/router` show the session against the model `/model` selects now, so a `/model` change shows the whole session against the new model there. While this reply and the one before it ran on that model's route, it is the reply's own usage, so a session on your model differs by exactly $0.00. Otherwise each model keeps one cache that never switched: it reads the previous prompt, up to this one less its uncached input, inside the cache lifetime, unless a compaction shrank the history or, on a model that keeps one cache per effort, the effort changed since, and never less than the API actually read; it writes the rest. Output tokens are the same. 
- **Parts**: the served model on your cache against yours is the model price, under cheaper models when negative and stronger than yours when positive; routed against the served model on your cache is the cache the switches cost, never negative. They sum to the difference. The pane rounds to cents and gives the remainder only to a part that is not zero: a surplus to the switch part, else the stronger part, else the cheaper part toward $0.00; a shortfall comes off the stronger part, down to $0.00, then the cheaper part. The shown parts add up, none changes sign, and none appears from rounding alone.
- **Prices**: `router.json` list prices through `ratesAt`, so Haiku 5.5 above 100,000 prompt tokens is priced at 5x. Claude Code reports no 5m/1h split to a Mod, so cache writes use the lifetime Claude Code 2.1.296 gives the main conversation by its own rule: one hour on a Claude plan unless an environment variable or the `promptCacheTtl` setting says otherwise, five minutes with an API key.

Checks:

- Unit tests (`test/savings.test.mjs`) cover a session that saves, one that costs more with Haiku as your model, equal routes at exactly 0, cache expiry at 5m and 1h, a compaction, a change of your model or effort, the 100K surcharge, an unpriced model, and a corrupted store. `test/hook-routing.test.mjs` covers two sessions finishing turns at the same moment, and a `/model` change mid-session that shows the whole session against the new model. `test/usage.test.mjs` covers calendar days across month ends and daylight saving changes, the periods, the record cap and expiry, the trend buckets and what is worth a look; `test/usage-view.test.mjs` covers the Usage tab.
- A one-off replay, not checked in, of this machine's main-conversation transcripts from 2026-10-01 to 2026-10-10 (nine sessions with 10 or more replies) gave $0.00 for every session that ran only on the model it was compared with: three on Opus 5.5, one on Haiku 5.5. Every main-conversation cache write in them was a one-hour write, which is what the lifetime rule gives on this Max plan.
- A live Claude Code 2.1.296 session on 2026-10-10, Opus 5.5 at `high` with turns pinned to Haiku 5.5, showed **Routed replies $0.48** beside **Cost $0.480 reported by Claude** for the same 16 replies; its last Haiku reply had a 114K-token prompt, which agrees only at the 5x rate. A Haiku 5.5 session with a pinned Opus turn showed $0.45 routed against $0.446 reported.

Limits:

- Output length is held the same. A stronger model may write less, or finish in fewer tool steps; a cheaper one may need more. The readout cannot see either.
- Answer quality is not measured. A saving bought with worse answers would read the same.
- Your model's cache is simulated, and a five-minute session that the lifetime rule takes for one hour (a plan subscriber billed as overage) would read too much cache on your side.
- A route that changes only the effort costs the same per token. On Opus 5.5, Sonnet 5.5, Haiku 5.5 and Fable 5.1 it shares your cache and reads $0.00; on a provider that caches each effort apart, it shows its cache writes.
- Subagents (see [Subagent routing](#subagent-routing)), classifier charges and replies with routing off are not counted. On a Claude plan the dollars stand for quota, not cash.
- The usage records keep one record per session, by local calendar day, so sessions finishing turns at the same moment both count. A turn's switch counts on the day it ended, its replies on the days they arrived. Claude Code's store has no atomic update, which leaves these gaps: the same session open in two Claude Code processes at once can lose one's turn; a turn finishing in another process during **Delete history** can be lost; and a session's total from before a reset comes back if its first saved reply has the same millisecond as the reset, or if the system clock moved back across the reset. The router reads every session's record at session start and when the pane opens, so that read grows with the number of sessions kept. A session drops its days older than 400 days when it writes its record; on that read, another session's record with no day in the last 400 days is deleted, and past 1,000 records of other sessions those with the oldest last day go too. A record that does not read whole, such as one a later version wrote, counts toward the 1,000 but is never deleted. Totals kept before the dated usage records have no dates: All adds them, and the other periods leave them out.

## Subagent routing

Subagent routing has no measured result over time yet. It is `on` by default since 1.9. The Usage tab's **SUBAGENTS** section shows the counts for the chosen period:

- Every agent by the model it ran on, filled when the router moved it off core's model, and what routing saved or cost on the routed agents.
- **ROUTED**, per type: agents, routed cost, and **vs CC**, the same tokens on core's model. Open, per model: the agents the router kept, moved up or moved down by output price, and their cost; requests per agent, respawns and classifier failures.
- **NOT ROUTED**, the spawns that passed through, by reason (`fork`, `workflow agent`, `explicit model`, `teammate`, `type not routed`, `pinned model`, `no definition`), priced on the model they ran on. This is the share of subagent spend that routing cannot reach.

Method:

- The routed cost is the reply on the routed model and **vs CC** the same tokens on core's model as the router estimates it: `CLAUDE_CODE_SUBAGENT_MODEL`, except for Explore and Plan without `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`, else the parent's model. A subagent starts with a cold cache on one model and keeps it, so its own token counts on another model are a fair counterfactual. `ratesAt` applies Haiku 5.5's 5x rate above 100,000 prompt tokens. Explore agents often pass that, so Haiku can cost more than its base price suggests.
- Cache writes are priced at the subagent lifetime: five minutes unless `FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`, `subagentPromptCacheTtl` or `ENABLE_PROMPT_CACHING_1H` say otherwise, on a subscription too.
- The counts cannot see quality. Two proxies stand in for it: requests per agent, and **respawns**, a spawn of the same type by the same parent within 10 minutes after one finished.

Checks:

- `test/subagents.test.mjs` covers each pass reason, the pin rule, the classify mapping, core's model estimate, the router's move, the subagent lifetime, Haiku's long-context price, and the store's days, merge, reset, bad values and records from before 1.14.0. `test/hook-subagents.test.mjs` covers `on` (the routed model), a fork, an explicit model, a teammate, a workflow agent and a pinned project agent (each passes), a classifier failure (core's model), parallel spawns, a spawn-path pause that leaves main routing alone, respawns, session end, Delete history, and the Usage and Now tabs. `test/usage-view.test.mjs` covers the block by period, an open row, a narrow pane and undated records; `test/hook-band.test.mjs` the band in a subagent's transcript.
- `experiments/mod-router/results/agent-spawn-probe.json` records what Claude Code 2.1.296 does with a spawn's model, frontmatter and workflow agents.
- `experiments/mod-router/results/subagent-routing-live.json` is a live `on` run on 2026-10-10 with Sonnet as the parent. Explore was sent Haiku and ran on it. general-purpose was classified `standard`. A pinned project agent and an explicit `opus` call passed through. The store counted each one.

When to turn it `on`:

- **vs CC** is below zero for the routed types, by enough to matter;
- the models look right for the tasks: Haiku for searches and reads, Opus rarely;
- **Not routed** leaves enough routable spend to bother.

Keep it if requests per agent and respawns per type stay no higher than before you turned it on. Otherwise change `types` or `heavyMass`, exclude a type with `null`, or set `subagentRouting` to `off`.

Limits:

- Answer quality is not measured.
- Workflow agents cannot be routed. In the maintainer's sessions they were 22 of 24 Opus subagents (`workflow-subagent-models.json`), so most inherited Opus spend there is out of reach. `CLAUDE_CODE_SUBAGENT_MODEL` is the lever for them.
- `on` estimates core's model. It does not apply the family-alias rule or the `availableModels` substitution.
- Respawns are a proxy. A parent may spawn the same type twice on purpose.
- Records follow the savings records' storage, with the same gaps.

## Historical method and limits

- Costs use configured USD list prices per million tokens. They are not subscription cash charges.
- The older gateway baseline uses the router's observed tokens and cache reads. After a route change, the baseline assumes the prior context can be read from cache.
- The native replay uses the current default routes and prices, with recorded model IDs substituted. It compares the native cost bounds with a legacy cost model using the same policy state and trace facts.
- The replay cannot reconstruct exact native cache prefixes or one-hour cache evidence from the old log. The native cache model treats TTL as unknown.
- The replay applies the legacy state chain to both policy arms. It does not simulate later state changes after a different decision.
- Failure signatures and pins are not present in the trace. The relevant route decisions are excluded from comparison.
- Most main rows are tool continuations or have no Jev advice. Only 37 advised decisions support the native comparison.
- Costs cover the next request. They use the last observed output size and do not model effort-dependent output length or future answer quality.
