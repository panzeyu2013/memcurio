# Deterministic quality baseline

`bun run eval:lexical` runs the repository's offline retrieval and safety
smoke against [`fixtures/retrieval.json`](fixtures/retrieval.json). It creates
an isolated temporary memory root, writes the fixture documents, exercises the
same `searchMemory` path used by CLI/MCP, and reports:

- Recall@5 for the retrieval cases;
- injection blocking for an unsafe memory line;
- secret leakage checks on returned content.

This is a regression baseline, not a claim about LLM extraction quality. A
future provider benchmark should add labeled session transcripts, no-op
precision, summary fidelity, compaction retention, and latency/cost budgets.
