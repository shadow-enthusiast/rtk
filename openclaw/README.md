# RTK Plugin for OpenClaw

Transparently rewrites shell commands executed via OpenClaw's `exec` tool to their RTK equivalents, achieving 60-90% LLM token savings.

This is the OpenClaw equivalent of the Claude Code hooks in `hooks/rtk-rewrite.sh`.

## How it works

The plugin registers a `before_tool_call` hook that intercepts shell tool calls (`exec`, `exec_command`, `bash`, and compatible variants). When the agent runs a command like `git status`, the plugin delegates to `rtk rewrite` which returns the optimized command (e.g. `rtk git status`). The compressed output enters the agent's context window, saving tokens.

It also registers OpenClaw tool-result middleware for large `read` and `process` log results. That path runs after the tool executes but before OpenClaw feeds the tool output back into the model. The middleware is intentionally conservative: it only touches text-only, non-error results above a size threshold and keeps the original output when RTK does not save enough tokens.

All rewrite logic lives in RTK itself (`rtk rewrite`). This plugin is a thin delegate -- when new filters are added to RTK, the plugin picks them up automatically with zero changes.

## Installation

### Prerequisites

RTK must be installed and available in `$PATH`:

```bash
brew install rtk
# or
curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh
```

### Install the plugin

```bash
# Copy the plugin to OpenClaw's extensions directory
mkdir -p ~/.openclaw/extensions/rtk-rewrite
cp openclaw/index.js openclaw/openclaw.plugin.json ~/.openclaw/extensions/rtk-rewrite/

# Restart the gateway
openclaw gateway restart
```

### Or install via OpenClaw CLI

```bash
openclaw plugins install ./openclaw
```

### Verify locally

```bash
cd openclaw
npm install
npm test
npm run build
```

## Configuration

In `openclaw.json`:

```json5
{
  plugins: {
    entries: {
      "rtk-rewrite": {
        enabled: true,
        config: {
          enabled: true,    // Toggle rewriting on/off
          verbose: false     // Log rewrites to console
        }
      }
    }
  }
}
```

## Telegram command

The plugin also registers `/rtk_gain` as an OpenClaw runtime slash command for
RTK Token Savings Analytics.

Examples:

```text
/rtk_gain
/rtk_gain graph history
/rtk_gain all json
/rtk_gain quota pro
```

The command only forwards a fixed allowlist of analytics options to `rtk gain`.
Destructive analytics actions such as `--reset` are intentionally not available
through the slash command.

## What gets rewritten

Everything that `rtk rewrite` supports (30+ commands). See the [full command list](https://github.com/rtk-ai/rtk#commands).

## Tool-result compaction

Large non-shell tool outputs can also be compacted:

- `read` results: rerendered with `rtk read --level minimal` when the read has no `offset`/`limit` slicing.
- `process` results: large `process.log` and `process.poll` text output is filtered through `rtk pipe --filter log`.

Safety guards:

- text-only results only; images and structured media are left alone
- tool errors are left alone
- small outputs are left alone
- sliced `read` calls (`offset`/`limit`) are left alone so the middleware does not accidentally reread different content
- compacted output must beat the original by at least 15% after the provenance header is added

Environment overrides:

```bash
RTK_OPENCLAW_RESULT_MIN_CHARS=12000
RTK_OPENCLAW_RESULT_MIN_SAVINGS_PCT=15
RTK_OPENCLAW_RESULT_TIMEOUT_MS=3000
RTK_OPENCLAW_READ_LEVEL=minimal
```

## What's NOT rewritten

Handled by `rtk rewrite` guards:
- Commands already using `rtk`
- Piped commands (`|`, `&&`, `;`)
- Heredocs (`<<`)
- Commands without an RTK filter

## Measured savings

| Command | Token savings |
|---------|--------------|
| `git log --stat` | 87% |
| `ls -la` | 78% |
| `git status` | 66% |
| `grep` (single file) | 52% |
| `find -name` | 48% |

## License

Apache 2.0 -- same as RTK.
