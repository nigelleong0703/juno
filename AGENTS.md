# Juno contributor instructions

Read README.md, docs/ARCHITECTURE.md, docs/DEVELOPMENT.md and the README of the area being changed. frontend/ and backend/ are one workspace. Public wire contracts have one source: backend/packages/public-contracts; never copy schemas into clients. Keep API boundaries between frontend and backend. Do not duplicate production code or relax quality checks to pass. Use production app wiring in tests.

Never commit credentials, local state, logs, personal transcripts, signing certificates or generated builds. Use synthetic examples. Run `pnpm check` and the affected tests before submission. Deployment changes must pass `node deploy/setup.mjs --check` and a fresh-install smoke test. Only claim real-model or computer execution after running it. Keep capability claims tied to code.
