/**
 * RTK Rewrite Plugin for OpenClaw
 *
 * Transparently rewrites exec tool commands to RTK equivalents
 * before execution, achieving 60-90% LLM token savings.
 *
 * All rewrite logic lives in `rtk rewrite` (src/discover/registry.rs).
 * This plugin is a thin delegate -- to add or change rules, edit the
 * Rust registry, not this file.
 */

import { execFileSync } from "node:child_process";

let rtkAvailable = null;

function checkRtk() {
  if (rtkAvailable !== null) return rtkAvailable;
  try {
    execFileSync("which", ["rtk"], { stdio: "ignore" });
    rtkAvailable = true;
  } catch {
    rtkAvailable = false;
  }
  return rtkAvailable;
}

// `rtk rewrite` exit-code protocol (see hooks/claude/rtk-rewrite.sh):
//   0 + stdout  rewrite found, allow-classified
//   1           no RTK equivalent; pass through unchanged
//   2           deny rule matched; pass original through so native policy sees it
//   3 + stdout  rewrite found, ask-classified; rewrite, host exec policy still governs
// execFileSync throws on non-zero exits, so status 3 must recover stdout.
function tryRewrite(command) {
  let stdout = null;
  try {
    stdout = execFileSync("rtk", ["rewrite", command], {
      encoding: "utf-8",
      timeout: 2000,
    })
      .toString()
      .trim();
  } catch (err) {
    if (err.status === 3 && err.stdout) {
      stdout = err.stdout.toString().trim();
    } else {
      return null;
    }
  }

  return stdout && stdout !== command ? stdout : null;
}

function rewriteExecParams(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  const command = params.command;
  if (typeof command !== "string") return null;

  const rewritten = tryRewrite(command);
  if (!rewritten) return null;

  const nextParams = { ...params, command: rewritten };
  if (params.code === command) {
    nextParams.code = rewritten;
  }
  return { command, rewritten, params: nextParams };
}

export default function register(api) {
  if (!api || typeof api.on !== "function") return;

  const pluginConfig = api.config ?? {};
  const enabled = pluginConfig.enabled !== false;
  const verbose = pluginConfig.verbose === true;

  if (!enabled) return;

  if (!checkRtk()) {
    console.warn("[rtk] rtk binary not found in PATH -- plugin disabled");
    return;
  }

  api.on(
    "before_tool_call",
    (event) => {
      if (event.toolName !== "exec") return;

      const rewrite = rewriteExecParams(event.params);
      if (!rewrite) return;

      if (verbose) {
        console.log(`[rtk] ${rewrite.command} -> ${rewrite.rewritten}`);
      }

      return { params: rewrite.params };
    },
    { priority: 10 }
  );

  if (verbose) {
    console.log("[rtk] OpenClaw plugin registered");
  }
}
