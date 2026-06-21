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
  return {
    hooks,
    api: {
      config,
      on(name, handler, options) {
        hooks.push({ name, handler, options });
      },
    },
  };
}

const originalPath = process.env.PATH;
const fakeBinDir = createFakeRtkBin();

try {
  process.env.PATH = `${fakeBinDir}:${originalPath}`;
  const { default: register } = await importPlugin("?with-rtk");

  const registered = createApi({ verbose: true });
  register(registered.api);

  assert.equal(registered.hooks.length, 1);
  assert.equal(registered.hooks[0].name, "before_tool_call");
  assert.equal(registered.hooks[0].options.priority, 10);

  const hook = registered.hooks[0].handler;

  assert.equal(hook({ toolName: "message", params: { command: "git status" } }), undefined);
  assert.equal(hook({ toolName: "exec", params: { command: "unknown" } }), undefined);
  assert.equal(hook({ toolName: "exec", params: { command: "dangerous" } }), undefined);

  assert.deepEqual(hook({ toolName: "exec", params: { command: "git status" } }), {
    params: { command: "rtk git status" },
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

  const disabled = createApi({ enabled: false });
  register(disabled.api);
  assert.equal(disabled.hooks.length, 0);

  process.env.PATH = "";
  const { default: registerMissing } = await importPlugin("?missing-rtk");
  const missing = createApi();
  registerMissing(missing.api);
  assert.equal(missing.hooks.length, 0);
} finally {
  process.env.PATH = originalPath;
  rmSync(fakeBinDir, { recursive: true, force: true });
}
