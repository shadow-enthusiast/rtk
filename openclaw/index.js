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

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

let rtkAvailable = null;
const TELEGRAM_TEXT_LIMIT = 3900;
const GAIN_TIMEOUT_MS = Number.parseInt(process.env.RTK_OPENCLAW_GAIN_TIMEOUT_MS || "10000", 10);
const execFileAsync = promisify(execFile);

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

const SHELL_TOOL_NAMES = new Set(["exec", "exec_command", "bash", "shell", "functions.exec_command"]);

function isShellToolName(toolName) {
  return SHELL_TOOL_NAMES.has(toolName);
}

function rewriteExecParams(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  const commandKey = typeof params.command === "string" ? "command" : typeof params.cmd === "string" ? "cmd" : null;
  if (!commandKey) return null;

  const command = params[commandKey];
  if (typeof command !== "string") return null;

  const rewritten = tryRewrite(command);
  if (!rewritten) return null;

  const nextParams = { ...params, [commandKey]: rewritten };
  if (params.code === command) {
    nextParams.code = rewritten;
  }
  return { command, rewritten, params: nextParams };
}

function gainHelp() {
  return [
    "RTK Token Savings Analytics",
    "",
    "Usage: /rtk_gain [options]",
    "",
    "Options:",
    "  graph       ASCII graph for the last 30 days",
    "  history     recent command history",
    "  daily       day-by-day breakdown",
    "  weekly      weekly breakdown",
    "  monthly     monthly breakdown",
    "  all         daily + weekly + monthly",
    "  quota       monthly quota estimate",
    "  quota pro   quota estimate for pro tier",
    "  failures    parse failure log",
    "  project     current project only",
    "  json        JSON output",
    "  csv         CSV output",
    "",
    "Examples:",
    "  /rtk_gain",
    "  /rtk_gain graph history",
    "  /rtk_gain all json",
    "  /rtk_gain quota pro",
  ].join("\n");
}

function parseGainArgs(rawArgs) {
  const tokens = rawArgs.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { args: [] };

  const args = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i].toLowerCase();
    switch (token) {
      case "help":
      case "--help":
      case "-h":
        return { help: true };
      case "project":
      case "--project":
      case "-p":
        args.push("--project");
        break;
      case "graph":
      case "--graph":
      case "-g":
        args.push("--graph");
        break;
      case "history":
      case "--history":
        args.push("--history");
        break;
      case "daily":
      case "--daily":
      case "-d":
        args.push("--daily");
        break;
      case "weekly":
      case "--weekly":
      case "-w":
        args.push("--weekly");
        break;
      case "monthly":
      case "--monthly":
      case "-m":
        args.push("--monthly");
        break;
      case "all":
      case "--all":
      case "-a":
        args.push("--all");
        break;
      case "failures":
      case "--failures":
      case "-F":
      case "-f":
        args.push("--failures");
        break;
      case "quota":
      case "--quota":
      case "-q":
        args.push("--quota");
        if (["pro", "5x", "20x"].includes(tokens[i + 1]?.toLowerCase() ?? "")) {
          args.push("--tier", tokens[i + 1].toLowerCase());
          i += 1;
        }
        break;
      case "tier":
      case "--tier":
      case "-t": {
        const tier = tokens[i + 1]?.toLowerCase();
        if (!["pro", "5x", "20x"].includes(tier ?? "")) {
          return { error: `Invalid tier: ${tokens[i + 1] ?? ""}\n\n${gainHelp()}` };
        }
        args.push("--quota", "--tier", tier);
        i += 1;
        break;
      }
      case "json":
        args.push("--format", "json");
        break;
      case "csv":
        args.push("--format", "csv");
        break;
      case "text":
        args.push("--format", "text");
        break;
      case "reset":
      case "--reset":
        return { error: "Reset is intentionally not available from /rtk_gain." };
      default:
        return { error: `Unknown option: ${tokens[i]}\n\n${gainHelp()}` };
    }
  }

  return { args };
}

function fenceForArgs(args, output) {
  if (args.includes("json")) return `\`\`\`json\n${output}\n\`\`\``;
  if (args.includes("csv")) return `\`\`\`csv\n${output}\n\`\`\``;
  return `\`\`\`\n${output}\n\`\`\``;
}

function truncateText(text) {
  if (text.length <= TELEGRAM_TEXT_LIMIT) return text;
  return `${text.slice(0, TELEGRAM_TEXT_LIMIT - 80).trimEnd()}\n\n[truncated; run rtk gain locally for full output]`;
}

async function runGainCommand(rawArgs) {
  const parsed = parseGainArgs(rawArgs);
  if ("help" in parsed) return { text: gainHelp() };
  if ("error" in parsed) return { text: parsed.error };

  try {
    const { stdout } = await execFileAsync("rtk", ["gain", ...parsed.args], {
      encoding: "utf-8",
      timeout: Number.isFinite(GAIN_TIMEOUT_MS) && GAIN_TIMEOUT_MS > 0 ? GAIN_TIMEOUT_MS : 10000,
      maxBuffer: 1024 * 1024,
    });
    const output = stdout.trim();
    const body = output || "No RTK analytics data yet.";
    return { text: truncateText(`RTK Token Savings Analytics\n\n${fenceForArgs(parsed.args, body)}`) };
  } catch (err) {
    if (err.code === "ENOENT") {
      return { text: "RTK binary not found in PATH. Install RTK first, then retry /rtk_gain." };
    }
    const details = String(err.stderr || err.stdout || err.message || err).trim();
    return { text: `Failed to read RTK Token Savings Analytics.\n\n${truncateText(details)}` };
  }
}

function registerGainCommand(api) {
  if (typeof api.registerCommand !== "function") return;
  api.registerCommand({
    name: "rtk_gain",
    description: "RTK Token Savings Analytics",
    acceptsArgs: true,
    nativeProgressMessages: {
      telegram: "Reading RTK Token Savings Analytics...",
    },
    handler: async (ctx) => await runGainCommand(ctx.args || ""),
  });
}

export default function register(api) {
  if (!api) return;

  const pluginConfig = api.config ?? {};
  const enabled = pluginConfig.enabled !== false;
  const verbose = pluginConfig.verbose === true;

  if (!enabled) return;

  registerGainCommand(api);

  if (typeof api.on !== "function") return;

  if (!checkRtk()) {
    console.warn("[rtk] rtk binary not found in PATH -- plugin disabled");
    return;
  }

  api.on(
    "before_tool_call",
    (event) => {
      if (!isShellToolName(event.toolName)) return;

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
