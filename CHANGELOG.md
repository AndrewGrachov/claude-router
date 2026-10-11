# Changelog

## Unreleased

The route now follows the task while it runs, for the tier and the activity, in both directions. Before, a turn was
routed once, from its prompt, and a continuation prompt could only keep the route. A team worker whose `/goal` brief
read as `ops` ran on Haiku · high and kept it for 100+ requests of coding. See
[Changes during a task](docs/user-guide.md#changes-during-a-task).

### Added

- A turn whose own tool calls edit a code file moves at once to the tier's `code` route (`docs` for doc-only edits), shown as `↗ coding` with a toast. The tools are the evidence, so no classifier support is needed and the cache cost does not hold the move back; only the cash cap on a credits-billed model can, priced at the route the context fits. It only goes up and skips pinned turns and `activityRouting: off`.
- Classifier reviews inside a turn: every `policy.reviewEveryRequests` requests (default 4; `0` turns them off) the classifier is asked again in the background, with the turn's prompt and recent dialogue. A step never waits; the answer applies at the next step and can move the tier or the activity either way. Each review sends the classifier the same kind of text a new turn does.
- `policy.minDwellRequests` (default 8) and a checkpoint for cheaper routes on the running task: a downgrade or a cheaper activity waits for that many requests after the last model change and for the last test, build, lint or type-check command since then to pass. Until then the route stays: a tier shows `… down after a passed check` (reason `downgrade-held`), a held activity keeps the running one. A check is a test runner, type checker or linter, or a launcher running one (`npm test`, `go test`, `make lint`), alone or after `&&`; a piped check (`npm test | tail`), `;`, `|| true`, package names and paths do not count. A cheaper activity also needs `policy.downgradeMass` probability.

### Changed

- A downgrade lands on the cheapest tier the answer supports as a whole, not only on the chosen tier. A split answer (micro 0.63, low 0.3) on `high` now moves to `low` instead of staying until `micro` alone reaches 0.9, and a cold candidate can give way to a warm tier between it and the incumbent.
- A prompt the classifier scores as a continuation of the task no longer keeps the route by itself. It is decided like a review: up on the usual votes, down past the checkpoint. The `continuation` reason is gone. `policy.continuationMass` now only decides whether a prompt counts as the running task.

### Fixed

- Replies after an in-turn move are labelled with the activity they ran on, not the turn's first label; the classifier's answer stays as recorded for the stats.

The review interval, the dwell and the checkpoint are starting values, not tuned on data.

## 1.10.3 (2026-10-11)

### Fixed

- Activity stats kept across sessions (classifier vs tools, runs, activity moves) no longer lose counts when two sessions finish turns at the same moment, and a session that read them before **Reset stats** can no longer write them back. Each session now keeps its own `activity:stats:v1:<session id>` record, summed on read like the other counts. The single key earlier versions shared still counts until the next **Reset stats** deletes it. After running this version, 1.10.2 or earlier shows only the counts in that shared key.
- A one-turn pin is no longer lost when the turn is interrupted before its route is set, and a pin pressed again while a pinned turn chooses its model now serves the next turn.
- A subagent spawn keeps core's model when the router cannot read the settings, since they may limit the models through `availableModels`.
- An agent definition file that could not be read is read again at the next spawn of its type, instead of passing that type through for the rest of the session.
- The Now tab's **Why** line gives a sentence, not a raw key, for a turn routing did not choose, routing off, a model fallback by Claude Code, and an interrupted turn.
- The Classifier tab names the host a request actually reaches: user info before `@` in an endpoint is not shown as the host, and an endpoint on `[::1]` shows as this machine.
- `scripts/migrate-config.mjs` refuses to write through a symlink, writes the converted file beside `router.json` and renames it into place, and removes its backup after a failed write, so the next run starts clean.

## 1.10.2 (2026-10-11)

### Fixed

- Different npm test failures that share a runner header no longer trigger a false model escalation. Repeated-failure matching fingerprints the full normalized error output instead of its first 120 characters. Test names, case, whitespace, and numeric error values stay distinct; empty errors are ignored. Known source positions and runner timings remain comparable across retries.

## 1.10.1 (2026-10-11)

### Removed

- `shadow` mode, from both `activityRouting` and `subagentRouting`. Each now takes `off` or `on`. A `router.json` that still sets `"shadow"` is read as not setting the key, so the default, `on`, runs; the next save from the pane drops it. To keep the base routes, set `off`. `/router activities` takes `off` or `on`. Gone with it: the Shadow line on the Now tab, the `(shadow)` label on the band, the "if activity routing were on" estimate and the Shadow counts on the Usage and Classifier tabs, and the shadow section of SUBAGENTS.
- Counts kept across sessions drop their shadow figures and keep the rest. After running this version, 1.10.0 or earlier resets the activity counts kept across sessions.

## 1.10.0 (2026-10-10)

### Changed

- The pane has five tabs: Now, Routes, Policy, Classifier, Usage (`1`–`5`). The old Routing tab is split in two, and each tab now answers one question.
- **Routes** is one grid of tiers by activities. Each cell shows the model it runs: `·` for the tier's model, `°` for a built-in default, **●** for an unsaved edit. Select a cell to edit it. **remove** is now **Use tier model**, and **Restore default** puts a built-in override back. `5 distinct routes · 3 caches` now reads `3 prompt caches in use: one per model`, with what a cold cache costs.
- **Policy** writes each control as a sentence, such as `Going down  after 2 ▾ agreeing turns`, shows the default beside a changed value, and says when the credits cap has no effect.
- **Now** leads with the next turn's model and why. The letter row under the replies strip (`eeccoo…`) is gone; replies are counted per tier and per activity instead, such as `coding 12 · exploring 4`.
- **Classifier** compares the classifiers in one table (where the prompt goes, probe, p95 wait, status) and flags a deadline shorter than the real wait. The counts across sessions moved here from Usage.
- **Usage** opens with the answer, such as `Routing saved $1.84 (22%) this session vs Opus 5.5 · xhigh`. Claude's readings fold to one line behind **details**.

### Fixed

- The Now picture in the docs showed `0 switches` next to a strip with three tier changes.

## 1.9.0 (2026-10-10)

### Added

- Subagent routing, on by default (`subagentRouting`: `off`, `shadow`, `on`). A subagent gets one model when it starts and keeps it for every step: Haiku for exploration, Opus for clearly hard tasks, Sonnet for the rest. The router reads each agent's definition and routes it when it names no model, says `model: inherit`, or sets the new frontmatter key `modelRouting: auto`; an agent that pins a model keeps it. The built-in Explore runs on Haiku, and Plan and general-purpose are classified. Forks, Agent calls that name a model, teammates and workflow agents keep their model. `subagents.types` overrides the rule per agent type. The active classifier now also receives the description and prompt of each routed subagent, as it receives main-turn prompts; set `"subagentRouting": "off"` to stop that. The Usage tab's new **SUBAGENTS** section shows, per type, what routing cost against the model Claude Code would have used, and what passed through and why. A classified spawn waits up to 3 seconds for the classifier; `shadow` records without changing models or delaying a spawn. Checked on Claude Code 2.1.293 and 2.1.296; unverified on older builds. See [Subagent routing](docs/configuration.md#subagent-routing).

### Changed

- An effort-only move on Opus 5.5, Sonnet 5.5, Haiku 5.5 or Fable 5.1, such as Opus at `medium` to `high`, is no longer priced as a cache write. These models keep one prompt cache across efforts with an API key or a Claude subscription, so the policy stops holding back moves that cost nothing, and Routing vs your model stops counting them as off your cache. On Amazon Bedrock, Google Cloud, Microsoft Foundry, a custom `ANTHROPIC_BASE_URL` or with `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`, each effort still has its own cache.

## 1.8.1 (2026-10-10)

### Changed

- The band names the activity with a verb in orange italic, `high  coding → Opus 5.5 · xhigh`, so it no longer reads as part of the model. `ops` reads `running`, `docs` reads `documenting`, and the rest end in `-ing`. The reasons and the switch toast use the same words: `↗ coding`, `↘ running`. In `shadow` the label stays dim.
- A space now follows the tier chip, so its background no longer runs into the next word.

## 1.8.0 (2026-10-10)

### Changed

- The band's second row now shows one thing: this session against your model, by name. For example, `session  saved $1.84 (22%) vs Opus 5.5 · xhigh  ·  64 replies  ·  cold-cache writes +$0.47`, or `extra $2.48 (×5.0) vs Haiku 5.5 · high` when routing cost more. The strip of recent replies, the switch count and the last reply's cache saving are gone from the band. The reply count drops first on a short row, then the cost part.
- Your model is the one `/model` selects now. Each routed reply is priced against every model in `router.json`, so after a `/model` change the band and the Usage tab show the whole session against the new model. The Usage tab adds `vs other models: Sonnet 5.5 extra $2.28 · Haiku 5.5 extra $6.19`. The totals kept across sessions still price each reply against the model selected when it ran.
- The first band row shows the switch cost, `switch cost ≈ $0.37`, next to the decision it explains. A classifier figure shows tenths when whole percents would read as equal: `Jev 81.0% < 81.4%`, not `81% < 81%`. `cache` now reads `cache hit`.
- The words are plainer. `tax` is now **switch cost**, `cache saved` and **Cache read benefit** are now **cache hits saved**, and `vs your model −5% (−$0.89, list prices)` is now `saved $0.89 (5%) vs <model>`.

## 1.7.4 (2026-10-10)

### Fixed

- Routing turned off while a turn's record is being saved ends the escalation watch, as it already did for the rest of the turn. Before, a switch of routing off and back on during that last step could start the watch again for the turn's cheaper move. Routing itself is unchanged.

## 1.7.3 (2026-10-10)

### Fixed

- Turning routing off while a turn runs ends the watch behind **Escalations**, even when routing is back on by the time the turn finishes. Before, that turn could start the watch again for its cheaper activity move, and a later escalation counted against it. Routing itself is unchanged.

## 1.7.2 (2026-10-10)

### Fixed

- A Manual turn ends the watch behind **Escalations** (ACROSS SESSIONS). A turn that moved to a cheaper activity route and finished after routing was turned off mid-turn could count a later escalation against that move.

### Added

- More live evidence in `experiments/mod-router/results/activity-live-acceptance.json`: the Sonnet → Haiku → Sonnet → Opus chain with tool calls, Sonnet and Opus thinking blocks after a Haiku detour, and the `shadow` would-route line, with no API errors.

## 1.7.1 (2026-10-10)

Readouts the activity routing plan asked for, and a record of the live checks behind 1.7.0.

### Added

- The Now tab's **Why** line names the activity cell when activity routing is on and the activity moved the route or the route is an override: `code at low runs on Sonnet 5.5 · high`. Tier moves, holds and refused moves keep their reason.
- The Usage tab's **ACTIVITY** table adds `est. cost`, the list price of each activity's replies (the same estimate as Routing vs your model, shown only when every reply was priced), and `mostly on`, the route most of its replies used. A narrow pane drops these columns first.
- **ACROSS SESSIONS** adds **Escalations** (`after a cheaper activity move: 1 in 12 moves`) and **Latency** (`Jev p95 ≤ 350 ms · 20 turns`, the active classifier), each only when there is data. Each session keeps its own record, merged when the pane reads it.
- The Classifier tab shows each classifier's last checked-in activity probe under its row, such as `activity probe 70/70 · p95 299 ms · Oct 10`, when the configured model is the one that was probed.
- `experiments/mod-router/results/activity-live-acceptance.json`: four live Claude Code 2.1.296 sessions in agterm across Haiku, Sonnet and Opus with tool calls, `shadow` and `on`, and Opus thinking blocks intact after a Haiku detour, with no API errors.

### Changed

- Activity moves refused by an escalation hold or the credits cap now count as refused, in the session's **Switches** line (`· 2 refused`) and in **Activity moves** across sessions. Before, only moves that did not pay back were counted.
- A probe run without a single usable activity answer no longer replaces the checked-in result.

### Upgrade notes

- 1.7.0 keeps reading `activity:stats:v1` after a downgrade. It does not read the new `activity:metrics:v1:*` records, so the Escalations and Latency lines are not shown on 1.7.0.

## 1.7.0 (2026-10-10)

Activity routing is now on by default, with a new default matrix that uses Opus, Sonnet and Haiku. The Usage tab shows what routing cost against running every reply on your own model. The band has one routing on/off control.

### Changed

- Activity routing is on by default. At `low`, `code`, `debug`, `plan` and `review` run on Sonnet 5.5 at `high`; at `medium`, `ops` runs on Haiku 5.5 at `high`. Every other cell, and every turn without an activity, uses the base route, which is unchanged: `micro` Haiku 5.5 · `medium`, `low` Haiku 5.5 · `high`, `medium` Opus 5.5 · `medium`, `high` Opus 5.5 · `xhigh`. 1.6's Sonnet 5.5 · `medium` cells for `docs`, `explore` and `ops` are gone. [Activity routing](docs/activity-routing.md) gives the reason for each cell, from Anthropic's model cards and a list-price replay of real sessions; it does not measure answer quality.
- Haiku 5.5 is priced at 5x on every rate above 100,000 prompt tokens, as Anthropic lists it. Switch-tax estimates and comparisons for Haiku routes rise there, and a decision near its bar can change: for example, an effort-only `micro` → `low` upgrade at 400K tokens now waits. The new model field `longContext` (`above`, `multiplier`, or `null`) holds it.
- The band has one routing control at a time. While routing is on, **Turn off** sits on the hover row next to the pins. While it is off, the first line reads `○ Routing off [ Turn on ] · every turn uses <model>`, and **Turn on** stays at any width. The pane header is one radio pair, `ROUTING [ ◉ on ] [ ○ off ]`; its hotkeys `o` and `f`, and the `/router` commands, are unchanged.
- The Now tab's **Replies** count and the two-row band count a switch as a change of model or effort, so a move from Sonnet to Haiku inside `low` counts.
- Wording: "base route" replaces "tier route", the Usage tab's "Lateral" line is now **Activity moves**, and **Reset activity stats** is now **Reset stats**, which also clears routing vs your model.

### Added

- **Routing vs your model**, the Usage tab's first section: routed replies against the same tokens on your model (the session's model and effort before routing), for this session and since the last reset, at configured list prices. The difference splits into cheaper models, stronger than yours, and cache writes from switches. It reads `too early` under 10 routed replies. It is an estimate, not a bill: output length is held the same, on a Claude plan it stands for quota, and answer quality is not measured. The two-row band shows the session figure, such as `vs your model −22% (−$1.84, list prices)`, and `/router` without a pane prints one line with it.
- **Activity threshold** (`policy.activityMass`) on the Routing tab under **POLICY**. Every activity-routing setting is now editable in the pane: the mode, each cell's model and effort, adding or removing a cell, and the threshold.
- The Routing tab leads **ACTIVITIES** with the mode, and **OVERRIDES** says whether the overrides are in use and, if not, why.
- [Activity routing](docs/activity-routing.md): what it does, the default matrix with its reasons, how to change any cell in `router.json` or the pane, and the limits of the estimates.

### Fixed

- When routing is unavailable (an old Claude Code, v0.8 gateway settings, an invalid `router.json`), the pane header and `/router` say so with the reason instead of offering on and off.
- When the routed model is not available, the fallback no longer takes another activity's cell: a session limited to Sonnet keeps its session effort on such a turn instead of running Sonnet · `high` labelled `code`.

### Upgrade notes

- A `router.json` without `activityRouting` now runs `on`. 1.6 removed the key when you chose its default, `shadow`, so if you chose `shadow` in 1.6, run `/router activities shadow` again.
- An activity override that sets only `model` or only `effort` takes the other field from 1.7's built-in cell, or from the base route where 1.7 has none (`explore` and `docs` at `medium`, `docs` at `low`). Write both fields to keep a 1.6 Sonnet · `medium` cell.
- A session started on Sonnet 5.5 starts with routing on, because Sonnet runs the `code` cell at `low`. To stay on Sonnet, use `/model` or `/router off`.
- If your `router.json` points the `haiku` alias at another model by setting only `id`, add `"longContext": null`, or it inherits the 5x surcharge.
- 1.6 does not read `models.<alias>.longContext`; remove it before downgrading.

## 1.6.1 (2026-10-10)

### Added

- The **Shadow** line on the Usage tab now estimates what the turns `on` would route differently would cost on their next request, as a range at the configured list prices in `router.json`, such as `est. −$0.300 … −$0.120 at list prices`. It is an estimate, not a measured saving.
- **ACROSS SESSIONS** on the Usage tab shows the activity counts kept since the last reset: labelled turns, tool agreement overall and on `code`, `ops` and `explore` turns, the two most frequent mismatches, lateral switches taken and refused, and the shadow readout with its estimate. `/router` without a UI surface prints the agreement across sessions. **Reset activity stats** clears it too.

### Changed

- Tool agreement counts a turn that only ran read-only commands, such as `git status`, as agreeing with `ops`. It used to count as a mismatch, which understated agreement on `ops`. Counts already stored are not recomputed.

### Upgrade notes

- Downgrading to 1.6.0 resets the activity counts kept across sessions: 1.6.0 does not read the shadow estimate 1.6.1 stores.

## 1.6.0 (2026-10-10)

The classifier now also names the turn's **activity**: what the turn produces (`code`, `debug`, `explore`, `plan`, `review`, `ops`, `docs`, or `uncertain`). The route can then depend on tier and activity, so a `low` coding turn can run on Sonnet 5.5 while a `low` git turn stays on Haiku 5.5. Routing does not change until you opt in.

### Added

- Activity routing, `activityRouting` in `router.json`: `off`, `shadow` (the default), or `on`. `shadow` asks for the activity, shows it, records stats, and works out what `on` would run; the tier route still runs. `on` applies the activity overrides. Switch with `/router activities on|shadow|off` or the mode selector on the Routing tab.
- Default activity overrides on top of the unchanged tier routes: at `low`, `code`, `debug`, `plan`, `review` and `docs` run on Sonnet 5.5 at `medium`; at `medium`, `ops`, `explore` and `docs` run on Sonnet 5.5 at `medium`. Every other cell uses its tier's route. Override any cell, per field, under `activities.<activity>.<tier>`.
- `policy.activityMass` (0.6): the probability an activity needs to apply.
- Switching between routes of one tier compares routes, not labels: a move to a stronger route needs the classifier's support, a move to a cheaper one must pay back its cache write, and both pass the cash gate. A continuation may move the activity only to a stronger route. Escalation keeps the activity and skips tiers whose route is no stronger.
- The band shows the activity between the tier and the model, `(shadow)` while in shadow, and the reasons `↗ code`, `↘ ops`, `… ops: not worth a switch`. The toast names the activity of an activity move.
- Pane: **Now** has **Activity** and **Route** lines and a letter row under **Replies**; **Routing** has the **ACTIVITIES** matrix and an **OVERRIDES** editor that joins the routing draft; **Usage** has **ACTIVITY · this session**, switches by tier and by activity, tool **Agreement**, the **Shadow** line, and **Reset activity stats**.
- Tool agreement: each finished turn is labelled from its tool calls (edits, Bash, reads, none), locally and without storing any text, and compared with the classifier's activity. Counts are kept per session and across sessions.
- `scripts/probe-activity.mjs` and a 70-prompt synthetic probe set. Clef and Clef Flash each answered 69 of 70 against the live API (p50 444 and 470 ms). Jev, OpenAI and Ollama have no probe result yet.

### Changed

- Before the first measured reply of a history (session start, `/clear`, compaction, rewind), an upgrade or downgrade needs one classifier answer that clears its bar instead of a streak of votes. A session started on the wrong tier now moves on turn 1.
- Jev, Clef and Clef Flash get the activity as one more question in the same request, and OpenAI as a second question. Ollama asks it in a second request inside the same deadline, only when at least 300 ms remain. With `off`, the requests are the same as in 1.5. A missing or malformed activity answer never costs the tier answer and never counts as a classifier failure.

### Upgrade notes

- Nothing routes differently after the upgrade: `shadow` runs the tier routes, as 1.5 did.
- With `shadow` or `on`, every classified turn sends the activity question too. Set `"activityRouting": "off"` to send exactly what 1.5 sent.
- 1.5 rejects `activities`, `activityRouting` and `policy.activityMass`. Remove them from `router.json` before downgrading.

## 1.5.1 (2026-10-09)

### Changed

- The band and pane name the mode **Routing on** and **Routing off**, not Auto and Manual. The footer reads `routing off`. The commands `/router auto` and `/router off` are unchanged.
- In the pane, the mode buttons use the hotkeys `o` (Routing on) and `f` (Routing off). They were `a` and `m`.
- A fresh session on a model no tier routes to starts with routing off, and the band says why: `Sonnet 5.5 is not a routing tier`. The note stays until the mode changes.
- The **Routing off** button sits on the band line while routing is on. It was reachable only on hover.
- The model-change toast reads `Model changed: old → new · reason`.
- The band uses the design prototype's colors: tier chips, filled buttons, an accent color while a turn is classified. Yellow is reserved for warnings.

## 1.5.0 (2026-10-08)

Two classifiers are new: OpenAI and a local Ollama model. Jev stays the default, and nothing changes until you select one of the new classifiers.

### Added

- OpenAI classifier: `gpt-6-luna` through OpenAI's Decisions API. Save an OpenAI API key with `/plugin configure router`, then select the OpenAI row on the Classifier tab. The prompt text goes to OpenAI. This path has not been run against a live key yet.
- Ollama classifier: a local model that needs no key. The prompt text stays on your machine. Checked with Ollama 0.35.1 and `qwen3.5:9b`.
- `classifiers.<id>.api` selects the wire protocol: `system-one`, `openai-decisions`, or `ollama`. An entry without `api` keeps `system-one`. `keyOption: null` means the classifier needs no key.

### Changed

- The Classifier tab's deadline choices include 5,000 ms, the default for Ollama.

## 1.4.1 (2026-10-08)

### Fixed

- Installing or updating the plugin no longer downloads the development tools (Biome, TypeScript; about 85 MB per version) into the plugin cache. Router has no runtime dependencies. Claude Code removes old cached versions, and their downloaded tools, 14 days after an update.

## 1.4.0 (2026-10-08)

### Changed

- `low` is now Haiku 5.5 at `high` effort (was Sonnet 5.5 on the session effort), and `micro` Haiku 5.5 at `medium` (was `low`). On Anthropic's OSWorld 2.1 effort chart, Haiku 5.5 at `high` scored above Sonnet 5.5 at `low`, and at `xhigh` near Sonnet at `medium`, for a fraction of the cost per attempt; OSWorld is computer use, not coding.
- `medium` and `high` stay Opus 5.5 at `medium` and `xhigh`. Opus 5.5 at `medium` matched or beat Sonnet 5.5 at `xhigh` at 25 to 50% lower cost per task on Terminal-Bench 4.0, FrontierCode v1.1, and CursorBench 4.0 (anthropic.com/claude-sonnet-5-5).
- No default tier keeps the session effort now. The `sonnet` alias stays. To restore the 1.3 ladder, add to `router.json`: `"routes": { "low": { "model": "sonnet", "effort": null }, "micro": { "model": "haiku", "effort": "low" } }`.
- A new session starts in Auto when its model is the model of any configured tier, not only the baseline's, and in Manual otherwise. A saved mode still wins on resume, `/model` still enters Manual, and `/clear` still starts Auto.

### Upgrade notes

- A session started on Sonnet 5.5, as the 1.3 guides suggested, now starts in Manual, because no default tier routes to Sonnet. Start on Opus 5.5 or Haiku 5.5, run `/router auto`, or restore the 1.3 ladder above.
- A `routes.low` entry in `router.json` without an `effort` used to keep the session effort, because the 1.3 default named none. It now takes the new default, `high`. Add `"effort": null` to that entry to keep the session effort.

### Fixed

- The start mode was decided by whichever ran first, the band or session start. When the band drew first, a session on a model no tier routes to could start in Auto.

## 1.3.2 (2026-10-08)

### Fixed

- The band and the pane's **Served** row now call a reply a fallback by the same rule routing uses: the requested model, or its one mapped dated snapshot (Haiku 4.5). Before, they accepted any dated suffix of the requested model, so a reply that routing treated as an engine substitution could show no **fallback**.
- Pressing **?** in the pane or **2 rows** on the band twice before the next redraw now toggles twice. The second press used to repeat the first.

### Internal

- Module names drop the historical `native-` and `jev` prefixes: `lib/classifier-contract.mjs`, `classifier-client.mjs` (class `ClassifierClient`), `route.mjs`, `cost.mjs`, `panel.mjs`, `band.mjs`, `display.mjs` and `facts.mjs`. The hook entry stays `hooks/native-router.mjs`; option names, state keys and the pane id are unchanged.
- Pure logic moved out of the hooks module into `lib/config-file.mjs` and `lib/view.mjs`, with tests. The hook tests are split by area, and lint is stricter, with complexity limits.
- `npm run typecheck` runs `tsc` on `lib/` in CI and in the pre-push hook. TypeScript is a dev dependency for this check only.

## 1.3.1 (2026-10-08)

### Changed

- `micro` is now Haiku 5.5 at `low` effort (was Haiku 4.5 with no effort setting). The `haiku` alias is `claude-haiku-5-5` with a 1,000,000-token window, all five effort levels, and list prices of 0.1 / 0.5 / 0.01 USD per million tokens. Those prices hold for prompts up to 100,000 tokens and are higher above, so estimates run low there.
- To keep Haiku 4.5, set `models.haiku` to `claude-haiku-4-5` with `"efforts": []`, a 200,000-token window, and 1 / 5 / 0.1 prices, and set `routes.micro.effort` to `null`.

## 1.3.0 (2026-10-06)

### Changed

- The pane's settings follow one rule per tab. **Routing** (was Tiers, now with the policy controls) edits routes and policy as one draft with one **Save** (`s`) and **Discard** (`d`). **Classifier** (was the classifier part of Tuning) writes a row or a deadline at once.
- Unsaved routing changes show on every tab: the tab reads **Routing ●**, and the status bar lists the `router.json` lines **Save** will write. The draft stays when you change tab or close the pane, and a new session drops it.
- **Undo** (`u`) puts back the settings the last pane write changed, from any tab: a classifier, a deadline, or a routing save. It writes back what `router.json` held before that write, so a hand edit elsewhere in the file stays. It no longer goes away when you change tab.
- **Reset policy to defaults** joins **Reset routes to defaults**. A policy value equal to its default is removed from `router.json`, as routes and deadlines already were.
- Notices sit in the status bar: green for a write or an undo, red for a refused write. In Manual the pin buttons give way to "Pins need Auto". **Manual: keep /model** is now **Manual**.

### Fixed

- The pane opened with the notice from the last press before it was closed. It now opens without one; the last write keeps its **Undo**.

## 1.2.0 (2026-10-05)

### Added

- Choose the classifier: Jev on typesafe.ai (the default), or Cloudflare's Clef and Clef Flash on Workers AI. Save the Cloudflare API token and account ID in `/plugin configure router`, then select the classifier's row on the Tuning tab. The choice is saved at once, with **Undo**. Only the active classifier is asked.
- The Tuning tab opens with the classifier section: each classifier's service and credentials state, the missing setting by name (`no API token`) with **Set up**, the active classifier's deadline and health, the host that receives the prompt text, and what each classifier needs.
- `router.json` can add a classifier for another service that speaks the same API. Its key and endpoint settings reuse the plugin's three options.
- `scripts/probe-classifier.mjs` sends the router's real request to one classifier and prints the status, latency, and answer.

### Changed

- Classifier settings moved from `jev` to `classifiers.<id>`, and `classifier` names the active one. Each classifier has its own deadline (Jev 1,500 ms, Clef and Clef Flash 3,000 ms), failure count, and pause. A turn being classified when you switch finishes with its own classifier.
- The band and pane name the active classifier and the missing setting: `⚠ Jev: no API key`, `⚠ Clef: no account ID`. On a narrow band the warning and **Set up** come first. **Set key** is now **Set up**.
- A classifier endpoint must use `https`, or `http` on localhost.

### Upgrade

1. If your `router.json` has a `jev` section, run `node scripts/migrate-config.mjs ~/.claude/router.json` from the installed plugin directory after you update. Until then routing stays off and the band reads `Router unavailable`. The command keeps an exact-byte `router.json.v1.1.backup`. A file without `jev`, or no file at all, needs nothing.

## 1.1.1 (2026-10-05)

### Fixed

- The credits cap now also guards downgrades and failure escalations. It checked only upgrades, so a downgrade or an escalation could start with a cold cache write above `policy.cashCapUsd` on a `credits` model. A blocked switch now stays on the current tier, or moves to the strongest `plan` tier above it. Default routes use `plan` models and are not affected.

## 1.1.0 (2026-10-05)

### Added

- The status band is redrawn as **Router**: a tier meter, the route, a one-word reason, classifier support, and context and cache, fitted to the band's width. It offers **Auto**, **Set key**, and pin cancel in place. Hover reveals tier pins, Manual, and an optional second row with recent replies by tier.
- A model change between turns raises a toast; a pin or an effort-only change does not. The spinner says `Choosing model` while the classifier runs. The prompt footer shows `router off` in Manual mode.
- The router pane has four tabs: Now, Tiers, Tuning, and Usage. Now shows the classifier's support for each tier next to its pin button, and the last 30 replies colored by tier.
- The Tiers tab edits each tier's model and effort and the baseline tier. It shows the `router.json` diff and how the policy prices each step up before you save. A route can set `"effort": null` to keep the session effort.
- The Tuning tab adds the credits cap.
- The user guide and README show the band and pane, drawn from the render code with `npm run docs:images`.

### Changed

- The `medium` tier defaults to Opus 5.5 at `medium` effort (was Sonnet 5.5 at `xhigh`), for a speed and cost balance. A `routes.medium` entry in `router.json` still overrides it.
- The plugin is named Router. Jev is named only where it explains a reading or a failure, so other classifiers can follow. The plugin ID is unchanged.
- `/router` takes `auto`, `off`, or `pin <tier>`. `status` and `setup` are removed: without a UI surface, `/router` prints the status, and **Set key** in the band or pane opens the secure key dialog.
- A failed save in the pane names the invalid setting instead of a generic error.

### Fixed

- `/router setup` failed with "no command.run hook answered it". Claude Code refuses `$.command.run` inside a `command.run` hook, so the key dialog now opens from a timer.
- The input trend scales from the lowest to the highest reading. Before, similar large readings drew as one solid bar.
- The band yields to surveys and no longer shows the main conversation's tier in a subagent transcript.
- Leftover v0.8 gateway settings are listed in the pane, not only in text status.

## 1.0.0 (2026-10-05)

### Changed

- Model routing now runs as a Claude Code Mod. It changes only `model` and `effort` on the main conversation. Claude Code sends Anthropic requests and handles streaming, tools, credentials, and usage. Subagent model choices pass through unchanged.
- Removed the gateway process, local proxy endpoint, gateway launcher hooks, status-line script, and gateway-only skills from the plugin package. The Mod needs no Node runtime service or router-specific Claude settings.
- Added an integrated status band and `/router` pane. It shows response usage, route reasons, configured-price comparisons, controls, one-turn pins, secure Jev key setup, and three tuning controls.
- Replaced gateway configuration with optional profile `router.json` settings. Added a backup-first migration command for v0.8 configuration files.
- The UI reports Claude's native cost reading and labels model-price comparisons as estimates. It does not claim measured savings or keep a second cost ledger.

### Migration

- The plugin ID stays `router@alexei-led-claude-router`. Marketplace installs with auto-update receive 1.0.0 at the next start; `claude plugin update router@alexei-led-claude-router` updates now. Keep the plugin enabled.
- Before the first 1.0.0 session, remove what 0.8 `/router:setup` wrote to `settings.json`: `model: "jev-router[1m]"`, the `jev-router[1m]` row in `modelPicker.options`, `env.ANTHROPIC_BASE_URL` set to `http://127.0.0.1:43170`, `env.CLAUDE_CODE_GATEWAY_HINT_HEADERS`, `env.ENABLE_TOOL_SEARCH` if setup added it, and a `statusLine` that runs the router's `scripts/statusline.mjs`. Until then, requests go to a gateway that 1.0.0 no longer starts, and the band reads `v0.8 gateway settings remain`.
- Run `node scripts/migrate-config.mjs /path/to/router.json` from the plugin directory for an existing 0.8 `router.json`. It keeps an exact-byte `.v0.8.backup` and converts supported route, model, cache and policy settings.
- Start Claude Code on the full baseline model, for example `claude-sonnet-5-5`. A `/model` choice enters Manual mode; `/router auto` resumes routing. Manual mode follows the session: `/clear` starts Auto, `/resume` restores the resumed session's mode.
- The Mod requires Claude Code 2.1.289 or newer.

## 0.8.0 (2026-10-01)

### Changed

- **Sonnet 5.5 replaces Sonnet 5.** The `sonnet` model is now
  `claude-sonnet-5-5`, at the same prices. A live probe through Claude Code
  2.1.286 shows it takes all five effort levels and all three request
  features, so the gateway no longer adapts its history.
- **`medium` runs on Sonnet 5.5 at `xhigh`**, not on Opus 5.5 at `high`.
  `/router:medium` changes with it. `high` stays Opus 5.5 at `xhigh`. From
  2026-09-23 to 2026-10-01, 15 of 16 escalations from Sonnet moved the
  session onto Opus for good, at about $31.6 of cold cache writes; most were
  triggered by environment or hook errors, not by the model. An escalation
  from `low` now stays on Sonnet.

### Upgrade

- If your `router.json` sets `models.sonnet.id` to `claude-sonnet-5`, also
  set `"features": ["mid-conversation-system"]`. The new default lists all
  three features, and Sonnet 5 answers the other two with 400.
- To keep the old `medium`, set
  `"routes": { "medium": { "model": "opus", "effort": "high" } }` and change
  `skills/medium/SKILL.md` to match.

## 0.7.2 (2026-09-25)

### Fixed

- `router.json` accepted a `policy.downgradePivotUsd` of 0 and a
  `policy.downgradeSlope` that is not a number. A zero pivot made the
  downgrade bar `NaN` whenever a switch cost nothing, and then no downgrade
  ever passed. Both values now stop a new gateway from starting, as the
  upgrade keys already did; `/router:status` names the field.

### Changed

- The downgrade bar counts what a cheaper model saves, not only its cache
  write. The tax used to count the input of the next request alone. It now
  nets the output and cache-read savings of the next
  `policy.downgradeHorizonTurns` turns (default 5). From a warm Opus at
  `xhigh` to a cold Sonnet, with 104k of context and 4k of output, the bar
  drops from 0.935 to 0.922 (1-hour TTL). It never goes below 0.90. A model
  without an `output` price keeps the input-only tax.

## 0.7.1 (2026-09-24)

### Fixed

- A downgrade paid no attention to its own cost. The switching policy
  checked confidence and vote count for a lower tier, never the price of
  getting there: a candidate whose cache was cold next to a warm incumbent
  could downgrade into a full cache write bigger than what the smaller
  model saved. The downgrade bar now grows with the switching tax the same
  way the upgrade bar does: `0.90 + 0.08 × tax / (tax + $0.50)`, up to
  0.98. A downgrade to an already-warm candidate is unaffected.

## 0.7.0 (2026-09-24)

### Upgrade requirements

- **Jev advises again.** Current Claude Code (2.1.x) sends hook output as a
  `system` message after your prompt. The router read only the last message,
  found no prompt, and never asked Jev: each new turn logged `no-advice` and
  stayed on its route. Now Jev sees each prompt, so routes change again:
  expect `upgrade`, `downgrade` and `continuation` reasons in the status line.
- **The gateway adapts the history for Sonnet and Haiku.** Claude Code builds
  each request for Opus. For a model without a request feature, the gateway
  now removes it, as Claude Code does after a 400: Sonnet and Haiku lose
  `tool_addition`/`tool_removal` blocks and per-turn control (the beta and the
  `output_config` on messages); Haiku also gets each `system` message as a
  `<system-reminder>` in the user message. A model that you add in
  `router.json` without `features` gets all three removed.
- **`high` runs at `xhigh` again.** On Opus, the per-turn effort that Claude
  Code puts on messages overrides the request's effort, so `medium` and `high`
  both ran at your session effort. A route with its own effort now sets it on
  the messages too.
- **`/router:micro` pins again.** Claude Code 2.1.x ignores `model: haiku` in the
  skill and sends the turn to the alias; the gateway now reads the command and
  serves the turn on `micro`, reason `pinned`. The next prompt goes back to Jev
  from the route before the pin.
- **`router.json` is strict.** An unknown key (for example a typo such as
  `routs`), a forbidden key (`__proto__`, `constructor`, `prototype`), a
  section that is not an object, or a number out of range now stops a new
  gateway from starting. The error names the file and the field, never the
  value. A gateway that already runs keeps serving. If no gateway runs, every
  request fails to connect until you fix the file. The SessionStart hook
  prints the error; the prompt hook is quiet. `/router:status` shows it too.
- **`ROUTER_CONFIG` counts only under `~/.claude/`.** The home directory comes
  from your OS user account, not from `$HOME`. A user with no account entry
  (some containers) has no trusted home: the gateway then ignores
  `router.json` and runs on the defaults, with a warning. A path elsewhere is
  ignored, with a warning. Move the file under `~/.claude/`: the hooks and the
  status line pass no flags, so `--config` works only for a gateway that you
  start by hand.
- **`ROUTER_FORCE_TIER` is gone.** Use `scripts/gateway.mjs --force-tier <tier>`.
- **A request with an `Origin` header gets 403.** Claude Code sends none. A
  browser page, also one on another loopback port, cannot use the gateway.
- **Jev receives less text.** The prompt is capped at `context.maxTextChars`
  (1,200 by default), like each earlier turn. A longer text keeps its start
  and its end. The current message is no longer also the last earlier turn.

### Added

- `--config <path>` on `scripts/gateway.mjs`, `scripts/ensure-gateway.mjs` and
  `scripts/status.mjs`, and `--force-tier <tier>` on `scripts/gateway.mjs`.
- `decisions.jsonl`: `model` and `effort` on each decision line, `effort` on
  each `observed` line, a `failed` line for a routed turn that Anthropic
  answered with an error, and a `reason: error` line when routing fails.
- `test/fixtures/effort-support.json`: the effort levels each default model
  accepts, from a probe against the real API. A test pins the defaults to it.
- `models.<alias>.features` and `test/fixtures/model-features.json`: the request
  features each model accepts, from a live probe; a test pins the defaults.

### Changed

- The hook sends a stop signal only to a pid that runs `scripts/gateway.mjs`.
- `Retry-After` from Jev is also read as an HTTP date.
- The status line keeps working when `router.json` fails to load, and
  `/router:status` names the error in one line.

### Fixed

- A `system` message after the prompt (hook output, tool additions) hid the
  prompt, a tool result and a resent request from the router. Jev was not
  asked, a tool continuation looked like a new turn, and a request that Claude
  Code resent after a 400 was decided again.
- The first Haiku turn of a session failed with `400 role 'system' is not
supported on this model`, and a later one made Claude Code flatten the
  history for the rest of the session: Opus then lost its features, and the
  router saw a shorter history and reset its votes. Sonnet answered the first
  turn with two 400s before Claude Code retried without the features.
- `/router:micro` did not switch the model with Claude Code 2.1.x.
- A project's `.claude/settings.json` could point the shared gateway at its own
  `router.json` (and so its own Jev endpoint) through `ROUTER_CONFIG`, while
  the hook passed the real Jev key to that gateway.
- `routes.<tier>.model: "constructor"` passed the model check; a merge key such
  as `constructor` reached the prototype chain.
- `policy.upgradePivotUsd: 0` silently stopped upgrades, and an infinite
  `policy.cashCapUsd` turned off the cold-write guard.
- A side request (title, classifier, compaction) on a session cleared its
  pending tool wait, so the gateway could exit under an open permission
  prompt. This needs the request-class header that `/router:setup` turns on
  (`CLAUDE_CODE_GATEWAY_HINT_HEADERS`); without it the gateway cannot tell a
  side request from a turn and keeps the old behavior.
