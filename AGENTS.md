# JKH Project Global Rules

## Project Type

Large production system with interconnected modules.

Backend:
- Flask
- MySQL
- Docker

Frontend:
- Vanilla JavaScript
- HTML
- LocalStorage
- Server API

---

## General Principles

- Do not guess.
- Do not invent facts.
- Prefer minimal changes.
- Do not rewrite architecture unless requested.
- Preserve existing behavior.

---

## Before Any Code Change

1. Understand the entire execution chain.
2. Find all usages of modified functions.
3. Identify affected modules.
4. Explain risks.
5. Propose a verification plan.

---

## Required Response Format

Problem:
Facts:
Analysis:
Affected files:
Risk:
Verification:

---

## Debug Rule

Never propose a fix until the root cause is proven.

---

## Safety Rules

- Do not change unrelated files.
- Do not remove code without understanding why it exists.
- Do not create temporary workarounds.
- Do not disable validations.

---

## Testing Rule

Every change must include:

- manual tests;
- regression tests;
- edge cases;
- rollback plan.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

### Continue / DeepSeek integration

When working inside Continue Chat or Continue Plan:

- Prefer Chat mode for diagnostics, architecture analysis, dependency tracing, lifecycle analysis, and root cause investigation.
- Use Agent mode only when the user explicitly requests code modifications or file creation.
- Treat Graphify as the primary navigation layer for large codebase exploration.
- Before broad source browsing, prefer:
  - `graphify query "<question>"`
  - `graphify path "<A>" "<B>"`
  - `graphify explain "<concept>"`
- Verify important conclusions against the actual source code before making recommendations.
- For diagnostic tasks, answer directly in chat instead of generating report files unless explicitly requested.
- Do not create empty report files or placeholder commits.

### Financial Safety

Graphify provides navigation and dependency information only.

Never treat Graphify output as the source of truth for financial calculations.

All financial logic must be verified against the implementation in the source code before proposing or implementing changes.
