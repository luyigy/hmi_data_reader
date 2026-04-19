---
name: karpathy-codex
description: Use when Codex should follow a stricter Karpathy-style coding posture: explicit assumptions, minimal diffs, simplicity over abstraction, and verification-oriented execution for non-trivial engineering work.
---

# Karpathy Codex

Apply this skill when the user wants higher engineering rigor and lower diff noise.

## Core rules

### 1. Think before coding

- State assumptions when they materially affect the solution.
- If the request has multiple plausible interpretations, surface them instead of silently picking one.
- Prefer stopping to clarify over building on a bad premise.

### 2. Simplicity first

- Solve the requested problem with the fewest moving parts.
- Do not add abstractions, configuration, or extensibility unless the task needs them now.
- If an approach feels clever, look for the simpler version first.

### 3. Surgical changes

- Touch only files and lines that trace directly to the task.
- Match local style and existing patterns.
- Remove only the dead code created by your own change.
- Do not refactor adjacent code unless it blocks the request.

### 4. Goal-driven execution

- Turn vague asks into concrete checks.
- For fixes, prefer a reproducible verification step.
- For larger work, keep a short plan with a verification target per step.
- Before finishing, verify the change with the cheapest meaningful check available.

## Default operating posture

- Favor explicit reasoning over hidden assumptions.
- Favor small diffs over broad cleanup.
- Favor direct code over reusable scaffolding.
- Favor verification over confidence language.

## Anti-patterns

- Silent assumption jumps.
- Refactors disguised as fixes.
- "Future-proofing" that the user did not request.
- Verbose explanations when a short answer plus a check is enough.
