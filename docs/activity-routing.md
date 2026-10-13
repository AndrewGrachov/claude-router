# Activity routing

The router picks a model for each turn from two labels. The **tier** says how hard the work is. The **activity** says
what the turn produces: changed code, a found cause, an answer, a plan, review findings, executed commands, or prose.
Since 1.7 activity routing is `on` by default. This page shows the default choices, why each one is there, and how to
change them.

The numbers below come from Anthropic's system cards and from a replay of one developer's sessions at list prices.
They do not measure this router's answer quality or your bill.

## What it does

For each new turn the classifier answers two questions, the tier and the activity, in the same request (Ollama makes
a second call). The router looks up the route for that pair. A route is a model and an effort.

| Activity  | The turn produces                                               |
| --------- | --------------------------------------------------------------- |
| `code`    | Changed code or config, including tests                         |
| `debug`   | A found cause: failing tests, stack traces, "why does X..."     |
| `explore` | An answer: explain code, find where something happens, research |
| `plan`    | A decision or plan: design, task breakdown, trade-offs          |
| `review`  | Findings about existing code: a PR, a diff, an audit            |
| `ops`     | Executed commands: git, builds, test runs, CI, deploys          |
| `docs`    | Prose for people: README, docs, comments, commit messages       |

Most cells use the tier's own route, the **base route**. A few cells have an **override**. When the activity is
unclear, or the classifier gives it less than 60% probability, the router moves back to the base route if the move
passes the cache check below. When the classifier gives no activity answer at all, the running activity stays. A pinned
turn uses the pinned tier's base route.

The router compares routes, not labels. If the new activity resolves to the route already running, nothing changes.
A move to a cheaper route must pay back its cache write first. A move to a stronger route needs the classifier's
support. The [user guide](user-guide.md#route-by-activity) has the full rules.

The label comes from the prompt, so it can be wrong. A prompt such as "run the worker brief" reads as `ops` and the
turn may then spend 80 requests writing code. The router therefore also watches the turn's own tool calls. Once the
turn edits a file, it moves to the `code` route of its tier (or `docs` for doc files) if that route is stronger. This
move only goes up. The cache cost does not hold it back; only the cash cap on a credits-billed model can. A later
classifier review in the same turn can move it down again, past the checks in
[Changes during a task](user-guide.md#changes-during-a-task). The next turn starts from the route the turn ended on.

## The default matrix

A `·` cell uses the base route.

| Activity                          | `micro`        | `low`             | `medium`         | `high`       |
| --------------------------------- | -------------- | ----------------- | ---------------- | ------------ |
| Base route                        | Haiku · medium | Haiku · high      | Opus · medium    | Opus · xhigh |
| `code`, `debug`, `plan`, `review` | ·              | **Sonnet · high** | ·                | ·            |
| `ops`                             | ·              | ·                 | **Haiku · high** | ·            |
| `explore`, `docs`                 | ·              | ·                 | ·                | ·            |

Why each row:

- **Base route.** The tier ladder, unchanged since 1.4. It runs for every cell without an override, and for every
  turn when activity routing is `off`.
- **`code`, `debug`, `plan`, `review` at `low`: Sonnet · high.** Code is where Haiku trails most. Sonnet at `high`
  scores well above Haiku on coding tests. Sonnet at `medium` does not, so it is not used.
- **`ops` at `medium`: Haiku · high.** Command runs last many requests, so Haiku pays back its cache write. Haiku is
  weaker on multi-step tool work, so `ops` at `high` stays on Opus. Repeated tool errors move an `ops` turn to the
  `high` route, Opus · xhigh. An `ops` turn that starts editing code moves to Opus · medium.
- **`explore` and `docs`.** Moving them saved nothing in the replay. Haiku also scores lower on research
  benchmarks: 50.1% on Humanity's Last Exam with tools against 63.0% for Opus at `medium`. They keep the base routes.

The matrix uses five routes on three models. Opus 5.5, Sonnet 5.5 and Haiku 5.5 keep one cache across efforts, so the
five routes use three caches, one more (Sonnet) than the base routes alone. On a provider that caches each effort apart,
each (model, effort) pair is its own cache.

## Which model fits which work

**Haiku 5.5**: running commands, lookups, quick answers, commit messages, routine edits.

- It is weakest at code. Terminal-Bench 4.0: Haiku 39.2%, Sonnet 70.6%, Opus 66.4%. SWE-bench Pro: 64.8%, 81.3%,
  89.9%.
- Its quality depends on effort more than the larger models do. The defaults use `medium` and `high`.
- Avoid `xhigh` in multi-turn chats. Anthropic reports that Haiku then sometimes puts the whole answer in its thinking
  and shows no reply.
- Above 100,000 tokens of context, Anthropic charges 5 times Haiku's list price. Even then it costs at most a quarter
  of what Sonnet or Opus costs per token.

**Sonnet 5.5**: small, well-defined code changes.

- At `high` it scored about 49% on FrontierCode Main and 47.8% on CursorBench 4.0. Haiku at `high` scored about 42%
  on FrontierCode Main.
- At `medium` it scored about 37% and 39.2%, below Haiku at `high` on FrontierCode Main. That is why the defaults use
  `high`.
- It reads cached context at the same price as Opus. In long sessions a request costs only about 20% less than on
  Opus.

**Opus 5.5**: ordinary and hard engineering, design, review, and research answers.

- At `medium` it has the best FrontierCode Main score on Anthropic's chart, 54.6%. On CursorBench 4.0 it scored
  52.5%, close to Sonnet at `xhigh` (53.1%).
- At `high` and `xhigh` it scored the same on CursorBench 4.0 (56.0%). `xhigh` gains a little on research and long
  knowledge work.

These are Anthropic's results, mostly at `max` effort and in other harnesses. They are not a claim of equal quality.

## What a model change costs

Each model keeps its own cache of the conversation. A model change writes the whole conversation into the new model's
cache. In the sample below Claude Code always wrote a one-hour cache, which costs twice the input price.

At 350,000 tokens of context, the typical size in that sample, at list prices:

| Cost                         | Haiku 5.5   | Sonnet 5.5  | Opus 5.5    |
| ---------------------------- | ----------- | ----------- | ----------- |
| Write the whole context once | $0.35       | $1.40       | $2.80       |
| One request on a warm cache  | about $0.03 | about $0.10 | about $0.13 |

- A move from Opus to Haiku pays back after about 4 requests, from Sonnet after about 5. Command runs lasted 6 to 11
  requests at the median, so the `ops` move pays back. Question-and-answer runs lasted 1 to 3, so moving `explore`
  does not.
- A move from Opus to Sonnet saves about $0.03 per request and costs $1.40 to start. It rarely pays back. That is why
  the defaults do not move `medium` or `high` work to Sonnet.

The router does this sum for every move with the prices in `router.json`. A move to a cheaper route inside a tier is
taken only when it pays back within the payback horizon. A move down a tier weighs the same cost against the
classifier's confidence: a costly write needs a more confident answer, but a confident enough answer can still move. Like the table, it prices Haiku at five times its list rates above 100,000 tokens
(`models.haiku.longContext` in [Configuration](configuration.md)).

## Turn it off

| Mode  | What the router does                                                                       |
| ----- | ------------------------------------------------------------------------------------------ |
| `on`  | The default. Asks the activity and runs the override when the cell has one.                |
| `off` | Does not ask the activity: the classifier is asked for the tier only. The base routes run. |

A `router.json` that still sets `"shadow"`, a mode removed in 1.10.1, is read as not setting it: the default, `on`, runs, and the next save from the pane drops the value.

Pick one of:

- Run `/router activities off`. It is saved to `router.json` at once. **Undo** in the
  pane reverts it.
- Open the pane with `/router`, press `2` for the **Routes** tab, set **Activity routing** at the top, and press
  **Save** (`s`).
- Write it in `router.json`:

  ```json
  { "activityRouting": "off" }
  ```

Routing as a whole has its own on/off pair at the top of the pane. Turning routing off keeps Claude's model for every
turn, whatever the activity mode.

## Change a cell

**In the pane.** Open `/router` and press `2` for the **Routes** tab. It starts with the mode, then one grid: a column
per tier, the **every turn** row with each tier's own model, and a row per activity. A cell shows the model the activity
runs at that tier, such as `sonnet·high`, or `·` for the tier's model; `°` marks a built-in default. Select a cell to
edit its model and effort under the grid. **Use tier model** drops the override; **Restore default** puts a built-in
one back. Edits are a draft: the tab reads **Routes ●** and lists the `router.json` lines they change. **Save** (`s`)
writes them, **Discard** (`d`) drops them, and **Undo** (`u`) reverts the last write. A yellow note flags a cell
stronger than the tier above, or the only cell on its cache, which adds one. A selected cell whose override
changes nothing says `same as the tier’s model: no effect`.

**In `router.json`.** `activities.<activity>.<tier>` takes `model`, `effort`, or both. A field you leave out keeps its
default. This runs `code` at `low` on Sonnet at `xhigh` and adds `max` effort for hard code:

```json
{
  "activities": {
    "code": { "low": { "effort": "xhigh" }, "high": { "effort": "max" } }
  }
}
```

A cell cannot be `null`. To drop a built-in override, set the cell to the tier's base route, or press **Use tier
model** in the pane, which writes that for you. The cell keeps that route if you later change the tier's route; drop it
again then:

```json
{
  "activities": { "ops": { "medium": { "model": "opus", "effort": "medium" } } }
}
```

Two other directions, with what they trade:

- **Cheaper.** Put `ops`, `docs`, and `explore` at `medium` and `high` on Haiku · high. Haiku scored 39.2% on
  Terminal-Bench 4.0 against 66.4% for Opus, and 50.1% on Humanity's Last Exam with tools against 63.0% for Opus at
  `medium`.
- **Stronger.** Put `code`, `debug`, `plan`, and `review` at `low` on Opus · medium, and `ops` at `medium` back on
  Opus · medium.

```json
{
  "activities": {
    "code": { "low": { "model": "opus", "effort": "medium" } },
    "debug": { "low": { "model": "opus", "effort": "medium" } },
    "plan": { "low": { "model": "opus", "effort": "medium" } },
    "review": { "low": { "model": "opus", "effort": "medium" } },
    "ops": { "medium": { "model": "opus", "effort": "medium" } }
  }
}
```

**Activity threshold.** An activity applies only when the classifier gives it at least this probability. Below it, a
new task goes back to the base route if that move passes the usual checks; the running task follows
[Changes during a task](user-guide.md#changes-during-a-task). The default is 60% (`policy.activityMass: 0.6`). Change it on the Policy tab under **Activities**,
or in `router.json`. There is no data to tune it on yet: the probe results record whether the
label was right, not the classifier's probabilities.

[Configuration](configuration.md#activity-routing) has the full schema.

## Upgrading from 1.6

1.6 asked the activity but ran the base routes. 1.7 turns activity routing `on`, with the matrix above.

- A `router.json` with `activityRouting: "off"` keeps it. Any other file now runs `on`. To keep 1.6's routes, run
  `/router activities off`.
- A session started on Sonnet 5.5 used to start with routing off, because no tier route used Sonnet. Sonnet now runs
  the `code` cell at `low`, so the session starts with routing on and the router may move it to Haiku or Opus. To
  stay on Sonnet in this session, choose it with `/model` or run `/router off`. To make future Sonnet sessions start
  with routing off, also run `/router activities off`.
- Overrides you saved stay as written. An override that sets only one field, such as `"effort"`, takes the other from
  1.7's built-in for that cell, or from the base route where 1.7 has none (`explore` and `docs` at `medium`, `docs` at
  `low`). 1.6's overrides in those cells and in `ops` at `medium` were Sonnet · medium, so such a cell can now run
  another model or effort. Write both `model` and `effort` to keep 1.6's route.
- If you removed a 1.6 built-in override that 1.7 no longer has, such as `docs` at `low`, its cell on the Routes tab
  says "same as the tier’s model: no effect". Press **Use tier model** and **Save** to drop it.
- 1.6 reads the same keys. A file without `activityRouting` runs 1.6's default under 1.6.

## What the estimates mean

**In the pane.** The band and the Now tab report Claude's own readings: cost, context, and cache. The
dollar figures next to them, such as the switch cost, and the payback, are estimates
at the list prices in `router.json`. They are not your bill: a plan does not charge list prices. They are not measured
savings: the router does not know what another model would have answered, or how many requests it would have needed.

**The replay behind the defaults.** We replayed 10 days of one developer's Claude Code sessions at list prices, main
conversation only. Each request kept its recorded size and output. The tier came from the route that ran. The activity
came from the tools the turn used. In the 11 sessions with router markers, the default matrix came out between 2% below
and 1% above what ran, with 19 or 20 model changes where the sessions had 14. 1.6's matrix came out between 4% below
and 15% above. The ranges cover seven ways to run the replay.

Limits:

- One developer, 10 days, 11 router sessions. In a sample this small, a few percent is one or two cache writes.
- List prices, not a subscription bill.
- The replay keeps each request's output and the number of requests. A weaker model can need more requests, a
  stronger one fewer. It does not measure answer quality.
- The tools a turn used show `code`, `ops`, `docs`, and reads. They cannot show `debug`, `plan`, or `review`.

## What we do not know yet

- The answer quality of routed sessions.
- How well the classifier labels real turns. On 70 synthetic prompts, Jev and OpenAI labelled all 70 right; see
  [Evaluation](evaluation.md#activity-probe-set). The **Agreement** lines, on the
  Classifier tab for this session and across sessions, check your own turns against the tools they used.
- Whether an effort change on the same model keeps the cache. We found only 6 cases. Claude Code's prompt-caching
  docs say it does on the 5.5 models and Fable 5.1 with an API key or a subscription, and the router now prices it so.
- How many requests a turn needs on each model.

## Sources

- Claude Haiku 5.5 system card: Table 8.1.A; FrontierCode Main by effort (Figure 8.3.A); Terminal-Bench 4.0 (§8.4);
  Humanity's Last Exam with tools by effort (Figure 8.8.1.A); OSWorld 2.1 (Figure 8.9.3.B); effort and PhysicianBench
  (§8.11.3).
- Claude Sonnet 5.5 system card: Table 8.1.A; FrontierCode by effort (Figure 8.4.A); CursorBench 4.0 by effort
  (Figure 8.8.A).
- Claude Opus 5.5 system card: Table 8.1.A; FrontierCode (§8.4); CursorBench 4.0 (§8.8); AA-Briefcase (§8.14.4).
- Anthropic prompting guides for Haiku 5.5 and Sonnet 5.5: effort starting points, Haiku at `xhigh` in multi-turn
  chat.
- List prices: [`test/fixtures/list-prices.json`](../test/fixtures/list-prices.json).
