<div align="center">

# Juno

### An AI teammate that lives in your group chats.

Add Juno to Slack, Feishu, Discord or Telegram. It takes requests from everyone in the group,
works on its own cloud computer and your connected apps, follows up, and learns how your team works.
Self-hosted. Bring your own model.

[中文](README.zh-CN.md) · [Run it](#run-it-on-your-server) · [How it works](docs/ARCHITECTURE.md) · [Contribute](CONTRIBUTING.md)

</div>

[![Watch the Juno film (110 s, Chinese with on-screen captions)](.github/assets/juno-story-poster.jpg)](https://github.com/nigelleong0703/juno/releases/download/v0.2.0/juno-story.mp4)

*Work and life with Juno: a product launch at work, plans with friends. Recorded from the real apps with a demo account.*

## Why Juno

Most AI assistants work for one person, in their own app. Real work happens in group chats, with several people asking, deciding and changing their minds.

Juno is built for that:

- **It joins the chats you already use.** Each agent gets its own bot identity on Slack, Feishu, Discord or Telegram, with no tokens to paste. Your direct messages from every platform land in one conversation.
- **It serves the whole group, not just you.** It knows who is asking, who decides, and what each person may see. A private detail you told it in a DM stays out of the group.
- **It does the work.** Each agent has a cloud computer with a browser, terminal and files, and can use your Mac when you allow it. It also uses connected apps: Google, Microsoft 365, Notion, Linear, Stripe, any MCP server you add, and a reviewed long tail through Composio.
- **It asks before it acts.** Sending, paying and deleting go through approval cards that carry the consequences. You decide what each agent may do without asking.
- **It remembers and gets better.** People, preferences, group rules and corrections become memory you can read and edit. Skills improve from real outcomes, with a staged rollout and rollback.
- **It keeps working when you're away.** Routines, follow-ups and long tasks run on durable workers that survive restarts and scale across processes.

Results come back as messages, documents you can review, research articles in your Feed, and small web apps you can share.

## Clients

| Client | Status |
|---|---|
| Web | Served by your deployment |
| iPhone | Native SwiftUI source in [`frontend/packages/ios`](frontend/packages/ios). Build and sign it with your own Apple team. |
| Mac | Electron source in [`frontend/packages/desktop`](frontend/packages/desktop). Installers are in [Releases](https://github.com/nigelleong0703/juno-releases/releases). |
| Apple Watch | Companion source in [`frontend/packages/watch`](frontend/packages/watch) |

All clients talk to the same public API. Its schemas live in one place, [`backend/packages/public-contracts`](backend/packages/public-contracts).

## Run it on your server

You need Docker with Compose and the Node version pinned in this repo.

```sh
git clone https://github.com/nigelleong0703/juno.git
cd juno
node deploy/setup.mjs --check     # creates deploy/.env with local defaults
# set your public hostnames, ports and TLS in deploy/.env (see deploy/README.md)
node deploy/setup.mjs --up --allow-unconfigured-model   # builds, migrates, starts, waits for health
```

Then sign in and add a model provider in Settings: an OpenAI-compatible endpoint, or your ChatGPT account. Each chat platform and each app with its own login needs its own app registration; [deploy/README.md](deploy/README.md) lists which.

Installing with an AI assistant? Give it [prompt.txt](prompt.txt).

## Repository

```text
backend/    API, agent runtime, durable workers, memory, channels, connectors, computer services
frontend/   Web, Mac, iPhone and Watch clients, shared client and UI packages
deploy/     Server setup and containers
docs/       Architecture and development notes
```

Develop with Node 26 and pnpm 12.9.1: `pnpm install`, then `pnpm check`. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Status

Juno is early software under active development, and interfaces change often. Please open an issue for anything that doesn't work.

MIT licensed. Third-party code and assets keep their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
