# Configuration

The router works with its built-in defaults. Configure the key of the active classifier to enable advice. Change `router.json` only when you need to change the classifier, routes, activity routing, model prices, cache assumptions, or policy.

## Key and profile settings

| Item                               | Where it lives                                  | How to change it                                                                                |
| ---------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Jev API key                        | Sensitive plugin option `typesafe_api_key`      | Run `/plugin configure router`, or use **Set up** or **Credentials → Edit** in the router pane. |
| Cloudflare API token               | Sensitive plugin option `cloudflare_api_token`  | The same dialog. Used by Clef and Clef Flash.                                                   |
| Cloudflare account ID              | Plugin option `cloudflare_account_id`           | The same dialog, or the config menu row. Not a secret.                                          |
| OpenAI API key                     | Sensitive plugin option `openai_api_key`        | The same dialog. Used only by the OpenAI classifier. Ollama needs no key.                       |
| Router settings and classifier     | `router.json` in the active Claude Code profile | Edit the file directly, or use the pane's Routes, Policy and Classifier tabs.                   |
| Anthropic credentials and API cost | Claude Code                                     | The Mod leaves these to Claude Code.                                                            |

The active profile directory is `CLAUDE_CONFIG_DIR` when set. Otherwise it is `~/.claude`. The Mod does not need an Anthropic proxy URL, model alias, hint header, daemon, or custom status line.

The Mod reads each value from its plugin option first. When the option is empty, it reads the environment variable of the same name in upper case, then the one Claude Code exports for the option:

| Plugin option           | Environment variables                                                 |
| ----------------------- | --------------------------------------------------------------------- |
| `typesafe_api_key`      | `TYPESAFE_API_KEY`, `CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY`           |
| `cloudflare_api_token`  | `CLOUDFLARE_API_TOKEN`, `CLAUDE_PLUGIN_OPTION_CLOUDFLARE_API_TOKEN`   |
| `cloudflare_account_id` | `CLOUDFLARE_ACCOUNT_ID`, `CLAUDE_PLUGIN_OPTION_CLOUDFLARE_ACCOUNT_ID` |
| `openai_api_key`        | `OPENAI_API_KEY`, `CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY`               |

Export the variables before you start `claude`. Without the key or the account ID of the active classifier, the Mod keeps Claude's current model and reports which value is missing.

Project and local settings cannot set `HOME` or `CLAUDE_CONFIG_DIR` for this Mod. Those overrides make the router unavailable for the session, so a project cannot redirect the router to another profile's key or configuration.

## Built-in defaults

The default baseline is tier `low`. Each route refers to an alias in `models`.

| Tier     | Model alias | Model ID           | Effort   |
| -------- | ----------- | ------------------ | -------- |
| `micro`  | `haiku`     | `claude-haiku-5-5` | `medium` |
| `low`    | `haiku`     | `claude-haiku-5-5` | `high`   |
| `medium` | `opus`      | `claude-opus-5-5`  | `medium` |
| `high`   | `opus`      | `claude-opus-5-5`  | `xhigh`  |

Every default route names its effort, so no default tier keeps the effort Claude Code sends. The ladder follows Anthropic's published charts. On the OSWorld 2.1 effort chart, Haiku 5.5 at `high` scored above Sonnet 5.5 at `low`, and Haiku at `xhigh` near Sonnet at `medium`, for a fraction of the cost per attempt; OSWorld measures computer use, not coding. On Terminal-Bench 4.0, FrontierCode v1.1, and CursorBench 4.0, Opus 5.5 at `medium` matched or beat Sonnet 5.5 at `xhigh` at 25 to 50% lower cost per task (chart data on anthropic.com/claude-sonnet-5-5). These are routing defaults, not a claim of equal model quality.

`micro` and `low` share a model, so a step between them changes only the effort. The policy prices it as a new messages cache, as it does `medium` to `high`.

To restore the 1.3 ladder, with Sonnet 5.5 at `low` on the session effort and Haiku 5.5 at `low` effort for `micro`:

```json
{ "routes": { "low": { "model": "sonnet", "effort": null }, "micro": { "model": "haiku", "effort": "low" } } }
```

Default model settings:

| Alias    | Input / output / cache read, USD per million tokens | Context window | Billing | Effort levels                           |
| -------- | --------------------------------------------------- | -------------- | ------- | --------------------------------------- |
| `opus`   | 4 / 20 / 0.2                                        | 1,000,000      | `plan`  | `low`, `medium`, `high`, `xhigh`, `max` |
| `sonnet` | 2 / 10 / 0.2                                        | 1,000,000      | `plan`  | `low`, `medium`, `high`, `xhigh`, `max` |
| `haiku`  | 0.1 / 0.5 / 0.01                                    | 1,000,000      | `plan`  | `low`, `medium`, `high`, `xhigh`, `max` |

Prices are configured list-price inputs for estimates. They are not a subscription bill or a claim of savings. Haiku 5.5 lists these prices for prompts up to 100,000 tokens and five times each of them, cache reads and writes included, above that. Its default `longContext` is `{ "above": 100000, "multiplier": 5 }`: a request whose prompt, counting input, cache reads and cache writes, is over `above` tokens is priced at `multiplier` times every rate. Every estimate prices through it. Set `"longContext": null` to remove it, for example when you point the `haiku` alias at another model with `id`. A model with `"efforts": []` receives no effort field. A route in `router.json` without an `effort` takes the effort of that tier's default route. To keep the session effort, clamped to what the model supports, set `"effort": null`, for example `"routes": { "high": { "model": "opus", "effort": null } }`. A 1.3 file whose `low` route had no `effort` kept the session effort; in 1.4 it runs at `high` until you add `"effort": null`.

## Activity routing

The classifier also names the activity of a turn: what the turn produces. `activityRouting` decides what the router does with it. [Activity routing](activity-routing.md) explains the defaults for end users.

| `activityRouting` | Behavior                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `off`             | Does not ask the activity: the classifier is asked for the tier only. The base routes run. |
| `on`              | The default since 1.7. Applies the `activities` overrides below.                           |

A `router.json` that still sets `"shadow"`, a mode removed in 1.10.1, is read as not setting it: the default, `on`, runs, and the next save from the pane drops the value.

The seven activities are `code`, `debug`, `explore`, `plan`, `review`, `ops`, and `docs`. The classifier may also answer `uncertain`. In `on`, an activity applies only when its probability is at least `policy.activityMass`. Below that, or on `uncertain`, a new task goes back to its base route if the move passes the cache checks; a continuation of the running task keeps its activity, or moves to the classifier's activity when that route is stronger. When the classifier gives no usable activity answer, the running activity stays and the tier answer still applies. When it gives no answer at all, the running route stays. In `off`, the base route runs.

`activities` maps an activity to a tier to a route override. An override may set `model`, `effort`, or both. A field it leaves out comes from the built-in override for that cell, or from the tier's own route, the **base route**, where there is none:

```
route(tier, activity) = { ...routes[tier], ...activities[activity][tier] }
```

The built-in overrides run only with `activityRouting: "on"`. A `·` cell uses the base route:

| Activity                          | `micro`        | `low`             | `medium`         | `high`       |
| --------------------------------- | -------------- | ----------------- | ---------------- | ------------ |
| Base route                        | Haiku · medium | Haiku · high      | Opus · medium    | Opus · xhigh |
| `code`, `debug`, `plan`, `review` | ·              | **Sonnet · high** | ·                | ·            |
| `ops`                             | ·              | ·                 | **Haiku · high** | ·            |
| `explore`, `docs`                 | ·              | ·                 | ·                | ·            |

- `code`, `debug`, `plan`, `review` at `low` run on Sonnet at `high`. Coding is where Haiku 5.5 trails most (Terminal-Bench 4.0: Haiku 39.2%, Sonnet 70.6%). Sonnet at `medium` scored below Haiku at `high` on FrontierCode Main (about 37% against 42%); at `high` it scored about 49%.
- `ops` at `medium` runs on Haiku at `high`. Command runs last long enough for Haiku to repay its cache write: about 4 requests from Opus at 350,000 tokens of context, against a median run of 6 to 11 requests in one developer's sessions. Haiku is weaker on multi-step tool work (OSWorld 2.1: about 61% against 79% for Opus at `medium`), so `ops` at `high` stays on Opus, and repeated tool errors move an `ops` turn to the `high` route.
- `explore` and `docs` keep the base routes: moving them saved nothing in that replay, and Haiku scores lower on research benchmarks (Humanity's Last Exam with tools: 50.1% against 63.0% for Opus at `medium`).

These are vendor benchmarks and a list-price replay, not measurements of this router, and they are not a claim of equal quality. The overrides add one (model, effort) pair the base routes do not use, Sonnet at `high`. It is the only route on Sonnet, so activity routing adds one cache. [Activity routing](activity-routing.md) has the evidence per cell and its limits.

A user file merges over these overrides one field at a time, as `routes` does. This sets only the effort of the built-in `code` override at `low`, so the cell runs Sonnet at `xhigh`, and adds a new override at `high`:

```json
{
  "activities": {
    "code": { "low": { "effort": "xhigh" }, "high": { "effort": "max" } }
  }
}
```

An override for a cell with no built-in names both fields, or inherits the missing one from the base route. This runs `docs` at `medium` on Sonnet at the base route's `medium` effort:

```json
{ "activities": { "docs": { "medium": { "model": "sonnet" } } } }
```

- `effort: null` keeps the session effort, as in `routes`.
- A cell cannot be `null`. To drop a built-in override, set it to the base route, for example `"ops": { "medium": { "model": "opus", "effort": "medium" } }`. The pane writes this for you when you press **Use tier model** on a built-in cell. The cell keeps that route if you later change the tier's route; drop it again then.
- An override applies to whatever the tier's route is. If you move `routes.low` to Opus, the built-in `code` override at `low` still runs Sonnet. Set it to match, or remove it.
- Unknown activities and tiers, unknown model aliases, and invalid efforts make the file invalid, like any other invalid setting. The pane refuses to save one and names it, such as `activities.code.low.model is not in models`.
- The Routes tab counts the prompt caches the routes use: one per model on Opus 5.5, Sonnet 5.5, Haiku 5.5 and Fable 5.1, one per (model, effort) pair on a provider that caches each effort apart.

`policy.activityMass` (default `0.6`) is the lowest probability at which an activity applies. The Policy tab sets it under **Activities**, from 50% to 80%. It has not been tuned on any classifier, and the probe results do not record probabilities, so there is no data to tune it on yet.

Switch the mode with `/router activities off|on`, or with the **Activity routing** selector at the top of the Routes tab. The command writes `router.json` at once; the selector joins the routing draft and writes on **Save**. Choosing `on`, the default, removes the key from the file.

**Upgrade from 1.6.** 1.6 asked the activity but ran the base routes, with Sonnet at `medium` in every override. A file with `"activityRouting": "off"` keeps it; any other file now runs `on`. Run `/router activities off` after upgrading to keep 1.6's routes. A session started on Sonnet 5.5 now starts with routing on, because Sonnet runs the `code` cell at `low`; to stay on Sonnet in that session, choose it with `/model` or run `/router off`, and run `/router activities off` to make future Sonnet sessions start with routing off. Cells you saved stay as written. A cell that sets one field takes the other from 1.7's built-in for that cell, or from the base route where 1.7 has none (`explore` and `docs` at `medium`, `docs` at `low`). 1.6's overrides in those cells and in `ops` at `medium` were Sonnet · medium, so such a cell can now run another model or effort; write both fields to keep 1.6's route. A 1.6 removal of a built-in that 1.7 no longer has, such as `docs` at `low`, stays in the file as the tier's route; its cell on the Routes tab says "same as the tier’s model: no effect", and **Use tier model** drops it.

**Rollback.** To go back to 1.6 behavior without downgrading, set `"activityRouting": "off"`. Router 1.6 reads the same keys; under 1.6 a file without `activityRouting` runs 1.6's default. Router 1.10.0 and earlier reset the activity stats store that this version writes without a `shadow` key. Router 1.5 rejects unknown keys and makes routing unavailable. Before you install 1.5 again, remove `activities`, `activityRouting`, and `policy.activityMass` from `router.json`. The pane writes them when you set the mode to `off`, change the activity threshold, or edit or remove an override.

## Classifiers

`classifier` names the active entry of `classifiers`. Each entry names its wire protocol in `api`: `system-one` for Jev, Clef and Clef Flash, `openai-decisions` for OpenAI, and `ollama` for a local Ollama server. Every protocol is converted to the same advice, so the routing policy does not change with the classifier. Unless `activityRouting` is `off`, each one is also asked for the turn's [activity](#activity-routing); the answer is optional, and a missing or malformed one keeps the activity already running. Cloudflare wraps the System One answer in `{ result, success, errors }`; Router reads both forms.

| `classifier` | Endpoint                                                                                                 | Request `model` | Key option             | `timeoutMs` |
| ------------ | -------------------------------------------------------------------------------------------------------- | --------------- | ---------------------- | ----------: |
| `jev`        | `https://api.typesafe.ai/v1/systemone`                                                                   | `jev-1.13.0`    | `typesafe_api_key`     |      `1500` |
| `clef`       | `https://api.cloudflare.com/client/v4/accounts/{cloudflare_account_id}/ai/run/@cf/cloudflare/clef`       | `clef`          | `cloudflare_api_token` |      `3000` |
| `clef-flash` | `https://api.cloudflare.com/client/v4/accounts/{cloudflare_account_id}/ai/run/@cf/cloudflare/clef-flash` | `clef-flash`    | `cloudflare_api_token` |      `3000` |
| `openai`     | `https://api.openai.com/v1/decisions`                                                                    | `gpt-6-luna`    | `openai_api_key`       |      `3000` |
| `ollama`     | `http://127.0.0.1:11434/api/chat`                                                                        | `qwen3.5:9b`    | none                   |      `5000` |

`jev` is the default. Select another one with a row on the pane's **Classifier** tab, or in `router.json`:

```json
{ "classifier": "clef-flash" }
```

An entry has six fields: `label` (the name the band and pane show), `api`, `endpoint`, `model`, `keyOption`, and `timeoutMs`. An entry without `api` speaks `system-one`. `endpoint` must use `https`; plain `http` is accepted only for `localhost`, `127.0.0.1`, or `[::1]`, because the key travels with each request. A `{name}` in `endpoint` is filled from the plugin option of that name, URL-encoded. `keyOption` names the plugin option sent as the bearer token, or is `null` when the service takes no key. Override one field of a built-in entry and the rest stay, for example `"classifiers": { "clef": { "timeoutMs": 4000 } }`.

You can add an entry for another service that speaks one of the three protocols. Its `keyOption` and endpoint placeholders must be one of `typesafe_api_key`, `cloudflare_api_token`, `cloudflare_account_id`, or `openai_api_key`, or `null` for no key. Claude Code lets a Mod read only the options its manifest declares and environment variables it names in code, so an entry cannot bring a key of its own. Nor can it add request headers. For example, a company proxy in front of Jev:

```json
{
  "classifier": "jev-proxy",
  "classifiers": {
    "jev-proxy": {
      "label": "Jev",
      "endpoint": "https://jev-proxy.example.internal/v1/systemone",
      "model": "jev-1.13.0",
      "keyOption": "typesafe_api_key",
      "timeoutMs": 1500
    }
  }
}
```

The active classifier receives the current prompt and recent dialogue, as described in the [architecture](architecture.md#request-flow). Give a Cloudflare token Workers AI permissions only. The routing policy thresholds were tuned against Jev, and `activityMass` against none; another classifier's probabilities can place the same prompt differently.

To check a classifier outside Claude Code, run `node scripts/probe-classifier.mjs [classifier]` from a checkout. It reads `router.json` and the upper-case variables `TYPESAFE_API_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `OPENAI_API_KEY` from the environment or `./.env`; it does not read plugin options or the `CLAUDE_PLUGIN_OPTION_*` names. It sends the router's real request, and prints the status, latency, and parsed answer. It never prints the key or the full endpoint. `node scripts/probe-activity.mjs [classifier]` does the same for the activity question with the [probe set](evaluation.md#activity-probe-set).

### OpenAI

`openai` sends the prompt and recent dialogue to OpenAI's Decisions API, `POST /v1/decisions`, with `gpt-6-luna`. Save an OpenAI API key in `openai_api_key`. The Decisions API is in public beta, and this adapter follows its guide, not a live check of every response shape.

### Ollama

`ollama` needs no key and keeps the text on this machine. Run `ollama serve`, pull the model named in `model`, and select the classifier. `model` is any tag you have pulled, such as `qwen3.5:9b`; change it under `classifiers.ollama.model`. The endpoint must stay on `localhost`, `127.0.0.1`, or `[::1]`, so a server on another machine on your network is not reachable through this entry. Each request turns thinking off. The activity is a second request, sent after the route answer parses and only when at least 300 ms of the deadline remain; if it fails, the turn keeps the running activity and the classifier is not counted as failed. If Ollama rejects that setting for a model, the request fails and the router keeps the baseline. Ollama unloads an idle model after its keep-alive period, and the first request after that can exceed `timeoutMs` while the model loads; the router then keeps the baseline for that turn.

## Subagent routing

`subagentRouting` gives each subagent one model when it starts, as the router gives each main turn one. It never changes the model between a subagent's steps: that would rewrite its context cold. With `CLAUDE_CODE_SUBAGENT_MODEL=sonnet`, agents that name no model already run on Sonnet. The router chooses per task instead: Haiku for exploration, Opus only for clearly hard work, Sonnet for the rest. It also routes the built-in Explore and Plan agents, which ignore that variable.

| `subagentRouting` | Behavior                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------- |
| `off`             | Asks nothing, records nothing. Every agent runs on the model Claude Code gives it.        |
| `on`              | The default. Sends the decided model, which Claude Code uses in place of the agent's own. |

A file that still sets `"shadow"` is read as not setting it, so subagents are routed (`on`).

**Which agents are routed.** The router reads the definition file of the agent being started: a plugin agent's file under the plugin's install path, a project agent's under `.claude/agents`, your own under `~/.claude/agents`. It routes the agent when its frontmatter:

- names no `model`;
- says `model: inherit`, which means "the main conversation's model", and the router routes that too;
- or sets `modelRouting: auto`. The agent's `model` is then what it runs on without the router.

An agent whose `model` names a model, such as `model: haiku`, keeps it. The Usage tab counts it as `pinned`. An agent whose file the router cannot find or read keeps its model as `unknown`; so does a plugin that keeps its agents outside `agents/`. Claude Code ignores frontmatter keys it does not know, so `modelRouting: auto` changes nothing without the router. To let the router choose a pinned agent's model, add the key to the agent's frontmatter:

```yaml
---
name: runner
model: haiku          # without the router
modelRouting: auto    # the router may choose
---
```

These agents always keep their model:

- a fork;
- an Agent call that names a `model`;
- a teammate;
- a workflow `agent()`: Claude Code ignores a rewrite of its model, so workflow agents get only `CLAUDE_CODE_SUBAGENT_MODEL`;
- a built-in agent other than Explore, Plan and general-purpose: its definition is not on disk.

```json
{
  "subagentRouting": "on",
  "subagents": {
    "types": { "Explore": "haiku", "Plan": "classify", "general-purpose": "classify" },
    "light": "haiku",
    "standard": "sonnet",
    "heavy": "opus",
    "heavyMass": 0.8
  }
}
```

The values above are the defaults.

- `types` overrides the rule for an agent type: a models key, `classify`, or `null` to never route it. A user file adds to the defaults. A key without a colon matches only Claude Code's built-in of that name, such as `Explore`; a project agent named `Explore` replaces the built-in and follows its own definition. A `plugin:name` key matches only that plugin's agent. A listed type is routed even if its definition pins a model.
- `classify` asks the active classifier, once, with the task's description and prompt. It sends no history and no tool results. The task runs on `heavy` when the classifier gives `high` at least `heavyMass`. It runs on `light` for exploration (the `explore` activity above `policy.activityMass`) or the `micro` tier. Everything else runs on `standard`. Every routed agent not listed in `types` is classified. In `on` the spawn waits up to the classifier's `timeoutMs`, at most 3 seconds.
- A classifier failure or a missing key keeps the model Claude Code gives the agent, and so does a model that `availableModels` blocks. So does routing off: `/router off`, or a `/model` choice.
- A spawn sets a model, not an effort. An agent's `effort` frontmatter still applies.

The Usage tab's **SUBAGENTS** section shows, per agent type, what routing cost against the model Claude Code would have used, and which agents passed through and why. [Evaluation](evaluation.md#subagent-routing) says what to look for. To stop it, set `"off"`. Router 1.8 rejects both keys as unknown, so remove `subagentRouting` and `subagents` before you downgrade. Subagent routing needs the `agent.spawn` hook: it is checked on Claude Code 2.1.293 and 2.1.296, and unverified on older builds.

## Optional `router.json`

Start with the setting you need and leave the rest at defaults. For example, require three votes before moving to a cheaper tier and allow Jev up to two seconds:

```json
{
  "classifiers": { "jev": { "timeoutMs": 2000 } },
  "policy": { "downgradeVotes": 3 }
}
```

The Mod validates the whole file. Unknown keys and invalid values make routing unavailable with a general configuration error. Retired gateway keys and the 1.1 `jev` section trigger a migration instruction. The migration command reports an invalid setting path and does not print its value.

| Section                        | Supported fields                                                                     | Defaults                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| `baselineTier`                 | `micro`, `low`, `medium`, `high`                                                     | `low`                                                    |
| `routes.<tier>`                | `model`, optional `effort` (a level, or `null` for the session effort)               | As in the route table above                              |
| `activityRouting`              | `off`, `on`                                                                          | `on`                                                     |
| `activities.<activity>.<tier>` | optional `model` and `effort`, as in `routes`                                        | The overrides in [Activity routing](#activity-routing)   |
| `models.<alias>`               | `id`, `input`, optional `output`, `cacheRead`, optional `longContext` (`above`, `multiplier`, or `null`), `contextWindow`, `billing`, `efforts` | Three defaults above                                     |
| `cache`                        | `writeMultiplier`, `ttlMs`, `warmMarginMs`                                           | `5m: 1.25`, `1h: 2`; `300000` / `3600000` ms; `30000` ms |
| `policy`                       | Fields below                                                                         | Values below                                             |
| `classifier`                   | An id in `classifiers`                                                               | `jev`                                                    |
| `classifiers.<id>`             | `label`, `api`, `endpoint`, `model`, `keyOption`, `timeoutMs`                        | [Classifiers](#classifiers) above                        |
| `context`                      | `recentTurns`, `maxTextChars`                                                        | `6`, `1200`                                              |
| `subagentRouting`              | `off`, `on`                                                                          | `on`                                                     |
| `subagents`                    | `types` (type → models key, `classify` or `null`), `light`, `standard`, `heavy`, `heavyMass` | [Subagent routing](#subagent-routing)            |

Policy defaults:

| Field                   | Default | Meaning                                                                                            |
| ----------------------- | ------: | -------------------------------------------------------------------------------------------------- |
| `upgradeVotes`          |     `2` | Consecutive supporting votes before an upgrade; one before a history's first measured reply.       |
| `upgradeBase`           |  `0.75` | Minimum probability mass required for an upgrade.                                                  |
| `upgradeSlope`          |  `0.15` | Maximum increase to the upgrade bar from estimated switching cost.                                 |
| `upgradePivotUsd`       |   `0.5` | Cost scale used by the upgrade bar. Must be positive.                                              |
| `jumpConfidence`        |  `0.95` | Support for a two-tier jump without waiting for votes.                                             |
| `downgradeVotes`        |     `2` | Consecutive supporting votes before a downgrade; one before a history's first measured reply.      |
| `downgradeMass`         |   `0.9` | Minimum probability mass required for a downgrade.                                                 |
| `downgradeSlope`        |  `0.08` | Maximum increase to the downgrade bar from estimated switching cost.                               |
| `downgradePivotUsd`     |   `0.5` | Cost scale used by the downgrade bar. Must be positive.                                            |
| `downgradeHorizonTurns` |     `5` | Later turns included in a downgrade payback estimate.                                              |
| `continuationMass`      |   `0.7` | Advice probability that keeps the current route for a continuation.                                |
| `escalationHoldTurns`   |     `2` | Turns held after a repeated tool error escalates the route.                                        |
| `cashCapUsd`            |     `2` | Maximum estimated cold cache write for a `credits` model. It does not cap output or session spend. |
| `activityMass`          |   `0.6` | Minimum probability for the classifier's activity to apply. Not tuned on any classifier.           |

The pane writes a subset of these settings. The **Routes** and **Policy** tabs set `routes`, `activities`, `activityRouting`, `baselineTier`, `policy.downgradeVotes`, `policy.downgradeHorizonTurns`, `policy.cashCapUsd`, and `policy.activityMass` in one save: it writes only values that differ from the defaults and removes the rest. `/router activities <mode>` writes `activityRouting` at once, with **Undo**. The **Classifier** tab sets `classifier` and the active classifier's `timeoutMs` at once. **Undo** reverts the settings the last pane write changed. Each save validates the whole file, keeps other keys, and applies from the next turn. A failed check names the setting and leaves the file unchanged. The pane refuses to write through a symlink. Model aliases and the other settings require a direct edit.

Opus 5.5, Sonnet 5.5, Haiku 5.5 and Fable 5.1 keep one prompt cache across effort levels, so the policy prices an effort-only move, such as Opus at `medium` to Opus at `high`, as no cache write. On Amazon Bedrock, Google Cloud, Microsoft Foundry, a custom `ANTHROPIC_BASE_URL`, or with `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`, each effort has its own cache and the move pays its write. A HIPAA configuration cannot be detected; the router then prices those moves as free.

Native cache freshness is unknown after 270 seconds or after a history reset. Claude usage does not report the cache TTL. The policy evaluates price bounds for five-minute and one-hour writes, but the one-hour case is not observed fact. See the [architecture](architecture.md#cache-and-cost) for the estimate rules.

## Convert an older `router.json`

Router 1.1 kept the Jev settings in a `jev` section. The current version reads `classifiers.jev` instead and makes routing unavailable while a `jev` section remains. Run the migration command below on the file. It moves `jev.endpoint`, `jev.model`, and `jev.timeoutMs` to `classifiers.jev`, keeps everything else, and writes an exact-byte `router.json.v1.1.backup`. A file without a `jev` section needs no change.

## Convert a v0.8 configuration

The `router.json` converter changes only that file. It does not remove Claude Code gateway settings. Remove them before the first native session.

A marketplace install keeps the plugin ID `router@alexei-led-claude-router`: update it and keep it enabled. If you load v1 from a checkout with `--plugin-dir` instead, disable the marketplace install so only one router loads. Set `CLAUDE_CONFIG_DIR` to the intended profile directory first:

```sh
CLAUDE_CONFIG_DIR=/path/to/profile claude plugin disable router@alexei-led-claude-router --scope user
```

Then inspect that profile's `settings.json`. Remove the old `jev-router[1m]` model-picker row and any `model` or `env.ANTHROPIC_MODEL` value set to that alias. Remove `env.ANTHROPIC_BASE_URL` when it points to the router's loopback port. Clear `env.CLAUDE_CODE_GATEWAY_HINT_HEADERS`. Restore or remove a router-specific `statusLine` that points to the deleted script. Remove `env.ENABLE_TOOL_SEARCH` only if the old router setup added it and you do not need it for another reason. Preserve unrelated settings. Set the normal full baseline model, for example `claude-haiku-5-5`.

No conversion is needed if you never created `router.json`. For an existing file, run the migration command that ships with the installed plugin:

```sh
node ~/.claude/plugins/cache/alexei-led-claude-router/router/1.2.0/scripts/migrate-config.mjs ~/.claude/router.json
```

Use the installed version in the path. From a checkout, run `node scripts/migrate-config.mjs ~/.claude/router.json`.

Pass the file under your active profile instead when `CLAUDE_CONFIG_DIR` points elsewhere. The command validates the converted configuration before writing it and creates an exact-byte `router.json.v0.8.backup` for a v0.8 file, or `router.json.v1.1.backup` for a 1.1 file. It refuses to overwrite an existing backup. Route, model-price, cache, and policy overrides remain in the converted file.

The converter removes old gateway and logging settings, request-feature fields, and model output caps. It moves `gateway.baselineTier` to top-level `baselineTier` and the `jev` section to `classifiers.jev`. It stops without writing when it finds an unsupported old field or invalid setting.

Node.js 22 or later is needed only for this migration command and project development. Claude Code runs the Mod. Node is not a routing service.
