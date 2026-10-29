# Contributing

Juno brings persistent AI agents into work and everyday life. Contributions to accessible clients, memory quality, learning, people and relationships, integrations, deployment and documentation are welcome.

Start with [Architecture](docs/ARCHITECTURE.md), [development](docs/DEVELOPMENT.md) and the [issue tracker](https://github.com/nigelleong0703/juno/issues). For a substantial change, explain the user problem, proposed behavior and validation in an issue first.

Install the pinned Node and pnpm versions, run `pnpm install` at the repository root, then use `pnpm check` and the affected package tests. Add behavioral regression coverage for persistence, permissions and recovery. Use the production wiring; do not create a parallel app only for tests.

Keep changes focused, preserve a single public-contract source, and include verification results in the pull request. UI changes should include before/after screenshots using synthetic data. Describe limitations and migrations. New integrations should document setup, granted capabilities, cancellation and failure behavior.

Do not include personal conversations, secrets or local machine configuration. Security vulnerabilities should follow [SECURITY.md](SECURITY.md). Contributions are made under the repository MIT license; preserve third-party notices.
