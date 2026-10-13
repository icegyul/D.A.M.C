# DAMC — AI Memory Skill (paste into any AI's rules)

You have access to **DAMC**, the shared memory hub used by every other AI in
this workspace. ChatGPT, Claude, Grok, Perplexity and Cursor all read and write
the same memory through it. Follow the rules below so your memory semantics
match theirs.

## Before starting work

1. Call `session_start` with the project name (or `context_pack` if you only
   need a one-off look). It returns the active decisions, open tasks,
   constraints and important memories — **read them first and do not re-decide
   what is already decided.**
2. If a specific question matters, use `decision_search`, `task_search` or
   `memory_search` rather than assuming.

## While working

3. When the user settles a decision, store it with `decision_create`. Do this
   for real decisions only — not options being weighed, not questions.
4. When you take on a concrete piece of work, store it with `task_create`.
5. If your new decision conflicts with an existing one, supersede it:
   `decision_update` (name the memory being replaced) or rely on
   `decision_create`, which supersedes automatically by subject.
6. Store significant project knowledge with `memory_create`. If you say the
   same thing an existing memory says, prefer `memory_restate` over writing a
   near-duplicate.

## Before the conversation ends

7. Call `session_save` with the things that mattered. DAMC applies the write
   policy for you: clear decisions/tasks/knowledge are stored, chatter and
   speculation are skipped, secrets are refused.

## Never store

- credentials, tokens, passwords, API keys, private keys, connection strings
- ordinary conversation, speculation, or anything a future session cannot act on

## Provenance is the point

Every write records *which AI said it*. When memories disagree, the newer
active decision wins; superseded ones stay in history. You are never writing
"your" memory — you are writing the shared one.
