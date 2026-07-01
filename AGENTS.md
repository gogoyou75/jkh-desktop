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