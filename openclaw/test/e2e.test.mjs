import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function createFakeRtkBin() {
  const dir = mkdtempSync(join(tmpdir(), "rtk-openclaw-e2e-"));
  const bin = join(dir, "rtk");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
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
if (subcommand === "read") {
  const file = process.argv.at(-1);
  const text = fs.readFileSync(file, "utf8");
  if (text.includes("COMPRESS_ME")) {
    console.log("compact read output");
  } else {
    process.stdout.write(text);
  }
  process.exit(0);
}
if (subcommand === "pipe") {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    if (process.argv.includes("log")) {
      console.log("Log Summary");
      console.log("[error] 1 errors (1 unique)");
    } else {
      process.stdout.write(input);
    }
  });
  return;
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
  const middlewares = [];
  return {
    hooks,
    commands,
    middlewares,
    api: {
      config,
      on(name, handler, options) {
        hooks.push({ name, handler, options });
      },
      registerCommand(command) {
        commands.push(command);
      },
      registerAgentToolResultMiddleware(handler, options) {
        middlewares.push({ handler, options });
      },
    },
  };
}

function textResult(text) {
  return { content: [{ type: "text", text }], details: { kept: true } };
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
  assert.equal(registered.middlewares.length, 1);
  assert.equal(registered.hooks[0].name, "before_tool_call");
  assert.equal(registered.hooks[0].options.priority, 10);
  assert.equal(registered.commands[0].name, "rtk_gain");
  assert.equal(registered.commands[0].acceptsArgs, true);
  assert.deepEqual(registered.middlewares[0].options, { runtimes: ["openclaw"] });

  const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "openclaw.plugin.json"), "utf8"));
  assert.deepEqual(manifest.contracts.agentToolResultMiddleware, ["openclaw"]);

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

  const middleware = registered.middlewares[0].handler;
  const readFile = join(fakeBinDir, "large.txt");
  writeFileSync(readFile, `${"COMPRESS_ME\n".repeat(1300)}`);
  const readOriginal = textResult(readFileSync(readFile, "utf8"));
  const compactRead = await middleware({
    toolName: "read",
    args: { path: readFile },
    result: readOriginal,
  });
  assert.match(compactRead.result.content[0].text, /rtk compacted read result via rtk read/);
  assert.match(compactRead.result.content[0].text, /compact read output/);
  assert.deepEqual(compactRead.result.details, { kept: true });

  const offsetRead = await middleware({
    toolName: "read",
    args: { path: readFile, offset: 100 },
    result: readOriginal,
  });
  assert.equal(offsetRead, undefined);

  const smallRead = await middleware({
    toolName: "read",
    args: { path: readFile },
    result: textResult("short output"),
  });
  assert.equal(smallRead, undefined);

  const logText = `${"INFO repeated line\n".repeat(1300)}ERROR boom\n`;
  const compactLog = await middleware({
    toolName: "process",
    args: { action: "log", sessionId: "abc" },
    result: textResult(logText),
  });
  assert.match(compactLog.result.content[0].text, /rtk compacted process\.log result via rtk log/);
  assert.match(compactLog.result.content[0].text, /Log Summary/);

  const imageResult = await middleware({
    toolName: "read",
    args: { path: readFile },
    result: { content: [{ type: "image", image: "data" }], details: {} },
  });
  assert.equal(imageResult, undefined);

  const disabled = createApi({ enabled: false });
  register(disabled.api);
  assert.equal(disabled.hooks.length, 0);
  assert.equal(disabled.commands.length, 0);
  assert.equal(disabled.middlewares.length, 0);

  process.env.PATH = "";
  const { default: registerMissing } = await importPlugin("?missing-rtk");
  const missing = createApi();
  registerMissing(missing.api);
  assert.equal(missing.hooks.length, 0);
  assert.equal(missing.commands.length, 1);
  assert.equal(missing.middlewares.length, 0);
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
