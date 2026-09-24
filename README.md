# Tool dependency graph

Agents fail on tool calls for a boring reason: the call needs an argument the
agent has no way to produce. `REPLY_TO_THREAD` wants a `thread_id`, and nobody
has one memorised. It is an opaque handle, and it comes from a prior call.

This builds that map. Given a catalog of tools described by JSON Schema, it
works out which tools must run **before** which, and which arguments have to be
asked of the user instead.

Open **`graph.html`** in a browser. No server, no build step, no network.

![Tools and entities are both nodes. Producers point into the entity, the entity points into consumers.](docs/bipartite.svg)

## The two shapes it has to get right

**A handle you cannot invent.** Replying to a mail thread needs a `thread_id`.
A thread listing produces one. That is a hard ordering constraint.

**A value that is sometimes a handle.** Sending mail needs an address. If the
user gives one, it is user supplied. If the user gives a *name*, a contacts
lookup has to run first. The same slot is tool derived in one case and not the
other, so the graph has to record both possibilities rather than pick one.

## Why the obvious approach does not work

Match input names against output names, draw an edge. Twenty lines, and it
fails for three separate reasons that only appear on a real catalog.

### 1. Generic names collide

`id`, `name`, `query`, `type`, `path` and `state` appear on hundreds of
unrelated tools. Name matching wires a mail client to a source control API.

Every handle is resolved to a **namespaced entity** instead (`gmail.thread_id`,
`github.issue_number`), and resolution is scoped to the service that owns the
tool, so a bare `id` on a mail tool can only resolve inside the mail namespace.

### 2. A bare `id` means nothing on its own

The single most common shape in a real catalog:

```json
{ "data": { "threads": [ { "id": "...", "snippet": "..." } ] } }
```

The leaf is `id`. The meaning lives in the **parent segment**, `threads`.
Discard the path and the most important producer in the whole catalog, the
thread listing, becomes invisible.

Resolution therefore runs in three tiers, widest context last:

1. the leaf name, for example `thread_id`
2. the nearest meaningful ancestor, so `threads[].id` resolves to a thread
3. the producing tool's own object, so `LIST_REPOSITORY_ISSUES` yields an issue
   even when every segment above the leaf is envelope

### 3. Almost every response embeds almost every object

A workflow run response contains a full repository, which contains an owner.
Taken literally, `CANCEL_WORKFLOW_RUN` "produces" a repository name. True, and
useless: nobody calls it to discover a repo name.

Producers are split into **primary** and **incidental**. A producer is primary
when yielding that entity is what the tool is *for*, judged by the head noun of
its slug's object phrase and by how shallowly the field sits in the response.
When a primary producer exists, incidental ones are suppressed.

Head nouns matter more than they sound. English compounds are head final, so
matching any token in the phrase gets these backwards:

| slug | object phrase | head | yields |
| --- | --- | --- | --- |
| `CREATE_A_REPOSITORY_VARIABLE` | repository variable | **variable** | not a repo |
| `CREATE_AN_ORGANIZATION_REPOSITORY` | organization repository | **repository** | a repo |
| `CREATE_AN_ISSUE_COMMENT` | issue comment | **comment** | not an issue |

All three are wrong under token matching, and the first two point in opposite
directions despite both containing `REPOSITORY`.

## Why the graph is bipartite

The natural encoding is an edge from every producing tool to every consuming
tool. At catalog scale it collapses. One entity, `github.repo_owner`, is
required by hundreds of tools and produced by dozens, so that entity alone emits
tens of thousands of edges and the picture says nothing.

Tools and entities are both nodes instead:

```
LIST_THREADS      --produces-->  gmail.thread_id
gmail.thread_id   --requires-->  REPLY_TO_THREAD
```

Edge count drops from producers times consumers to producers plus consumers, the
hub structure becomes legible, and the two hop path is exactly the "run A before
B" answer.

## Slot classification

Every input lands in one bucket, because "what do I ask the user for" needs an
answer as much as "what do I call first".

| bucket | meaning |
| --- | --- |
| `tool_derived` | resolves to an entity, so a producer can supply it |
| `user_supplied` | freeform content the user authors, such as a subject or body |
| `control` | paging, formatting, auth plumbing. Never a dependency |
| `enum_or_constant` | fixed vocabulary |
| `unresolved` | handle shaped, but no entity covers it yet |

`unresolved` is reported rather than hidden. It is the registry's own to do
list, and it is how the entities for `repository_id`, `project_id`, `runner_id`
and `invitation_id` were found.

## Results

Measured on a production catalog of 1,391 tools across two large toolkits.

| | |
| --- | --- |
| Tools | 1,391 |
| Canonical entities | 46 |
| Edges | 3,278 |
| Input slots | 7,102, of which 2,728 are required |
| Required slots resolved to an entity | 1,770 of 2,728 (65%) |
| Of those, with at least one producer | 1,768 of 1,770 (99.9%) |
| Tools with a real output schema | 1,239 of 1,391 (89%) |
| Tools needing the slug inference fallback | 0 |
| Handle shaped slots with no entity yet | 568 |

Two of those are easy to misread, so to be explicit: **99.9% is coverage of the
slots that resolved to an entity, not of all required inputs.** The honest
version is that 65% of required inputs are typed handles, and almost all of
those can be satisfied by another tool. The rest are content the user writes,
paging knobs, enums, and 568 handles the registry does not cover yet.

The slug inference fallback fired **zero** times. Real output schemas covered
every tool that needed one, so every edge traces to a declared output field.

## Checking it

```bash
python3 check.py
```

Eight hand written assertions. All eight pass. Each one started out failing, and
four of them are the bugs above: the bare `id` under `threads[]`, cross service
producers leaking into a plan, requiredness not compounding through an optional
parent, and the head noun error.

## Running it

```bash
bun install
bun run src/graph.ts   # build the graph
bun run src/viz.ts     # rebuild graph.html
python3 check.py       # verify
```

With no catalog of your own this runs against `data/sample/catalog.json`, eight
tools chosen to exercise every resolution path, and writes
`data/graph.sample.json` so a full build is never clobbered.

### Using your own catalog

Drop one or more JSON files into `data/catalog/`. Each is an array of tools:

```json
[
  {
    "slug": "LIST_THREADS",
    "name": "List threads",
    "description": "...",
    "toolkit": { "slug": "mail" },
    "inputParameters":  { "type": "object", "properties": {}, "required": [] },
    "outputParameters": { "type": "object", "$defs": {}, "properties": {} }
  }
]
```

`inputParameters` and `outputParameters` are plain JSON Schema, including
`$ref` into `$defs`. Snake case spellings are accepted too. Nothing else is
required, and nothing in the pipeline is specific to any one provider.

## Layout

| path | purpose |
| --- | --- |
| `src/extract.ts` | JSON Schema flattening. Knows nothing about any service |
| `src/entities.ts` | entity registry, service inference, producer ranking |
| `src/graph.ts` | builds the bipartite graph |
| `src/viz.ts` | inlines the graph into `graph.html` |
| `check.py` | the eight assertions |
| `viz.template.html` | page source before data is inlined |

## Limitations

- **The registry is hand built.** 46 entities cover the common handles, not all
  of them. 568 handle shaped slots still resolve to nothing.
- **Producer ranking is a heuristic.** It prefers a read verb whose direct
  object is the entity, a shallow output path, and locality. It gets the common
  cases right and will get exotic ones wrong.
- **Some schemas are thinner than reality.** One contacts search tool in the
  measured catalog declares no email field in its output, so it gets no credit
  for supplying an address even though it plainly returns people. The graph
  reflects the catalog, not the API behind it.
- **No transitive planning.** This answers "what comes immediately before".
  Chaining those into a full plan is the obvious next step and is not built.
- **The raw catalog is not redistributed here.** Only the derived graph and the
  small fixture are committed.
