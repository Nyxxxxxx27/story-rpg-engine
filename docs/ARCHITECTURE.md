# Architecture

```mermaid
flowchart LR
  Web[React workbench] --> API[/Fastify API v2/]
  Codex[Codex MCP] --> API
  API --> Store[(PostgreSQL)]
  API --> Queue[pg-boss + outbox]
  Queue --> Runtime[Persistent turn runtime]
  Runtime --> SDK[OpenAI Agents SDK]
  SDK --> Provider{Explicit provider}
  Provider --> AppServer[Codex App Server]
  Provider --> OpenAI[OpenAI API optional]
  Runtime --> Packs[Versioned story packs]
  Runtime --> Store
  Store --> SSE[SSE projections]
  SSE --> Web
```

## Commit boundary

Agents cannot write database state. Director returns `ScenePlan`; reviewers return `AgentReview`. After all checks pass, the transaction committer applies the allowlisted `StateChange` union and emits canonical facts with structured payloads and source IDs. Narrator then reads the committed projection and creates a public draft. When enabled, Polish Agent receives only that committed draft and returns `prose`; a deterministic guard rejects changes to people, place, numbers, dialogue presence, event signals or excessive length before the public-output sanitizer runs. Title, summary, choices and world state never enter the polishing output schema. A crash before commit safely repeats planning; a crash after commit resumes at narration, polishing or summarization without another scene insert.

## Context policy

The composer uses XML visibility boundaries around immutable engine rules, world config, versioned advanced Prompt, story packs, current stage, character records, up to eight scene summaries, up to 24 relevant facts, current input and output Schema. Private engine context is never a public output field. The protagonist and core cast always receive compact state. Only present characters receive private profile, drives and fears.

## Concurrency

Each branch has `running_turn_id`, so only one mutating turn commits at once. Manual and MCP turns are persisted with idempotency keys and queued by server receipt order. Dynamic Character Agents and rule reviewers use a four-worker concurrency limit. The outbox prevents a committed API request from losing its queue job, and startup recovery re-dispatches interrupted turns.

## Story packs

The kernel knows only time, location, characters, relationships, facts, scenes and stages. A pack contributes a prompt layer and deterministic plan validators. Domain systems such as cultivation, magic, combat or economy belong in separately versioned packs.
