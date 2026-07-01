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
