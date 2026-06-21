import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function createFakeRtkBin() {
  const dir = mkdtempSync(join(tmpdir(), "rtk-openclaw-e2e-"));
  const bin = join(dir, "rtk");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const [, , subcommand, command] = process.argv;
if (subcommand === "gain") {
  if (process.env.FAKE_RTK_HANG === "1") {
    setTimeout(() => {}, 60000);
    return;
  }
  const args = process.argv.slice(3);
  if (args.includes("--format") && args.includes("json")) {
    console.log(JSON.stringify({ summary: { total_saved: 1234, avg_savings_pct: 76.5 }, args }));
  } else {
    console.log("Total saved: 1,234 tokens");
    console.log("Args: " + args.join(" "));
  }
  process.exit(0);
}
if (subcommand !== "rewrite") process.exit(64);
if (command === "git status") {
  console.log("rtk git status");
  process.exit(0);
}
if (command === "ls -la") {
  console.log("rtk ls -la");
  process.exit(3);
}
if (command === "dangerous") process.exit(2);
process.exit(1);
`
  );
  chmodSync(bin, 0o755);
  return dir;
}

async function importPlugin(suffix) {
  const url = pathToFileURL(join(import.meta.dirname, "..", "index.js"));
  url.search = suffix;
  return import(url.href);
}

function createApi(config = {}) {
  const hooks = [];
  const commands = [];
  return {
    hooks,
    commands,
    api: {
      config,
      on(name, handler, options) {
        hooks.push({ name, handler, options });
      },
      registerCommand(command) {
        commands.push(command);
      },
    },
  };
}

const originalPath = process.env.PATH;
const originalGainTimeout = process.env.RTK_OPENCLAW_GAIN_TIMEOUT_MS;
const fakeBinDir = createFakeRtkBin();

try {
  process.env.PATH = `${fakeBinDir}:${originalPath}`;
  process.env.RTK_OPENCLAW_GAIN_TIMEOUT_MS = "500";
  const { default: register } = await importPlugin("?with-rtk");

  const registered = createApi({ verbose: true });
  register(registered.api);

  assert.equal(registered.hooks.length, 1);
  assert.equal(registered.commands.length, 1);
  assert.equal(registered.hooks[0].name, "before_tool_call");
  assert.equal(registered.hooks[0].options.priority, 10);
  assert.equal(registered.commands[0].name, "rtk_gain");
  assert.equal(registered.commands[0].acceptsArgs, true);

  const hook = registered.hooks[0].handler;

  assert.equal(hook({ toolName: "message", params: { command: "git status" } }), undefined);
  assert.equal(hook({ toolName: "exec", params: { command: "unknown" } }), undefined);
  assert.equal(hook({ toolName: "exec", params: { command: "dangerous" } }), undefined);
  assert.equal(hook({ toolName: "exec_command", params: { cmd: "unknown" } }), undefined);

  assert.deepEqual(hook({ toolName: "exec", params: { command: "git status" } }), {
    params: { command: "rtk git status" },
  });

  assert.deepEqual(hook({ toolName: "exec_command", params: { cmd: "git status" } }), {
    params: { cmd: "rtk git status" },
  });

  assert.deepEqual(hook({ toolName: "functions.exec_command", params: { cmd: "git status", yield_time_ms: 1000 } }), {
    params: { cmd: "rtk git status", yield_time_ms: 1000 },
  });

  assert.deepEqual(hook({ toolName: "bash", params: { cmd: "ls -la" } }), {
    params: { cmd: "rtk ls -la" },
  });

  assert.deepEqual(
    hook({ toolName: "exec", params: { command: "git status", code: "git status", cwd: "/tmp" } }),
    { params: { command: "rtk git status", code: "rtk git status", cwd: "/tmp" } }
  );

  assert.deepEqual(
    hook({ toolName: "exec", params: { command: "git status", code: "echo keep-code" } }),
    { params: { command: "rtk git status", code: "echo keep-code" } }
  );

  assert.deepEqual(hook({ toolName: "exec", params: { command: "ls -la" } }), {
    params: { command: "rtk ls -la" },
  });

  const gain = registered.commands[0].handler;
  assert.match((await gain({ args: "" })).text, /Total saved: 1,234 tokens/);
  assert.match((await gain({ args: "graph history" })).text, /Args: --graph --history/);
  const jsonResult = await gain({ args: "all json" });
  assert.match(jsonResult.text, /```json/);
  assert.match(jsonResult.text, /"--all"/);
  assert.match((await gain({ args: "quota pro" })).text, /Args: --quota --tier pro/);
  assert.match((await gain({ args: "tier 5x" })).text, /Args: --quota --tier 5x/);
  assert.match((await gain({ args: "-f" })).text, /Args: --failures/);
  assert.match((await gain({ args: "reset" })).text, /Reset is intentionally not available/);
  assert.match((await gain({ args: "help" })).text, /Usage: \/rtk_gain/);
  process.env.FAKE_RTK_HANG = "1";
  assert.match((await gain({ args: "" })).text, /Failed to read RTK Token Savings Analytics/);
  delete process.env.FAKE_RTK_HANG;

  const disabled = createApi({ enabled: false });
  register(disabled.api);
  assert.equal(disabled.hooks.length, 0);
  assert.equal(disabled.commands.length, 0);

  process.env.PATH = "";
  const { default: registerMissing } = await importPlugin("?missing-rtk");
  const missing = createApi();
  registerMissing(missing.api);
  assert.equal(missing.hooks.length, 0);
  assert.equal(missing.commands.length, 1);
  assert.match((await missing.commands[0].handler({ args: "" })).text, /RTK binary not found/);
} finally {
  process.env.PATH = originalPath;
  if (originalGainTimeout === undefined) {
    delete process.env.RTK_OPENCLAW_GAIN_TIMEOUT_MS;
  } else {
    process.env.RTK_OPENCLAW_GAIN_TIMEOUT_MS = originalGainTimeout;
  }
  delete process.env.FAKE_RTK_HANG;
  rmSync(fakeBinDir, { recursive: true, force: true });
}
