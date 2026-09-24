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

