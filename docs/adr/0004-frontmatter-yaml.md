# ADR 0004 — Frontmatter via `yaml` package, not gray-matter

Date: 2026-08-28 · Status: accepted

## Context
The spec listed `gray-matter`. It has had no release since 2020, depends on js-yaml 3, and memoizes every parsed string in a process-global cache when called without options — a memory leak for a multi-tenant server.

## Decision
Own 40-line splitter (`---` fences, CRLF tolerant) + `yaml` v2 (`parse`/`stringify`, core schema, dates kept as strings, key order preserved).

## Consequences
Behavior parity with the reference for the common cases; YAML edge cases (anchors, multi-doc) are rejected with INVALID_INPUT instead of silently accepted.
