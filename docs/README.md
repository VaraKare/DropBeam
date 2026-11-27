# DropBeam docs: who reads what

Start with the row that matches you. Every doc links onward, so you rarely need more than two.

| You are | Read first | Then |
|---|---|---|
| **A user** ("how do I send a file?") | [FEATURES.md](../FEATURES.md) | In-app Privacy and Terms pages |
| **A contributor or AI agent** | [README.md](../README.md) → [SETUP.md](../SETUP.md) | [MAP.md](MAP.md) (how it works), [FORK.md](../FORK.md), [AGENTS.md](../AGENTS.md) / [.claude/CLAUDE.md](../.claude/CLAUDE.md) (rules) |
| **Deploying or self-hosting** | [DEPLOY.md](../DEPLOY.md) | [ADR-006](adr/ADR-006-hosting-and-turn.md) (zero-budget hosting), [ADR-007](adr/ADR-007-signaling-on-cloudflare.md) (Cloudflare signaling) |
| **A security researcher** | `SECURITY.md` *(Phase C, not written yet)* | [audit/](audit/) (external audit + our response), [ADR-001](adr/ADR-001-receiver-flow-control.md), [ADR-002](adr/ADR-002-partial-file-identity.md), [ADR-003](adr/ADR-003-client-ip-and-proxies.md) |
| **Business: owners, partners, sponsors** | [PRODUCT.md](PRODUCT.md) (market, costs, money) | `BUSINESS.md` *(Phase F: revenue, budget split, go/no-go checkpoints)*, [ADR-004](adr/ADR-004-ads-isolation.md) (ads without breaking privacy) |
| **Planning the next piece of work** | [PHASES.md](PHASES.md) (what's being built now) | [ROADMAP.md](ROADMAP.md) (backlog + device test matrix), [CHANGELOG.md](../CHANGELOG.md) |

## Claude Code tooling for this repo

Checked in under `.claude/`, so every session gets them.

| Kind | Name | Use it for |
|---|---|---|
| Skill | `dropbeam-verify` | Tests + typecheck + build + a real two-tab transfer with a hash check |
| Skill | `dropbeam-invariants` | Checking a diff against the hard rules before a PR |
| Skill | `dropbeam-release` | Version bump, changelog, PR, tag, then a fresh session for the next step |
| Skill | `dropbeam-deploy` | Cloudflare Worker deploy, production smoke test, rollback |
| Skill | `dropbeam-device-test` | A guided round on real phones/PCs, recorded in `audit/` |
| Agent | `test-runner` (Haiku) | Runs the checks, reports only failures |
| Agent | `security-auditor` (Opus, read-only) | Threat-model review before releases |
| Agent | `protocol-reviewer` (Sonnet, read-only) | Changes in `packages/protocol` and `packages/transfer` |
| Agent | `docs-keeper` (Sonnet) | Keeps these docs in step with the code |

**Session habits (tokens cost money):** one session per phase or feature; `dropbeam-release` at the end,
then a fresh session. Use `/compact` when context passes ~70%. Hand mechanical work to the cheaper agents.
