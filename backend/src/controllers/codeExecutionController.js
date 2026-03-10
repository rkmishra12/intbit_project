import { spawn } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";

const MAX_CODE_SIZE = 25_000;
const MAX_OUTPUT_SIZE = 64_000;
const COMPILE_TIMEOUT_MS = 5_000;
const RUN_TIMEOUT_MS = 4_000;

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 20;
const requestBuckets = new Map();

const JS_BLOCKLIST = [
  /\brequire\s*\(/i,
  /\bimport\s+.*\bfrom\b/i,
  /\bprocess\b/i,
  /\bchild_process\b/i,
  /\bfs\b/i,
  /\bnet\b/i,
  /\bhttp\b/i,
  /\bhttps\b/i,
  /\bdgram\b/i,
  /\bworker_threads\b/i,
];

const PY_BLOCKLIST = [
  /\bimport\s+os\b/i,
  /\bimport\s+subprocess\b/i,
  /\bimport\s+socket\b/i,
  /\bimport\s+shutil\b/i,
  /\bimport\s+pathlib\b/i,
  /\bfrom\s+os\s+import\b/i,
  /\bfrom\s+subprocess\s+import\b/i,
  /\bopen\s*\(/i,
  /\beval\s*\(/i,
  /\bexec\s*\(/i,
  /__import__\s*\(/i,
];

function getSafeEnv() {
  const env = {
    PATH: process.env.PATH || "",
    TEMP: process.env.TEMP || os.tmpdir(),
    TMP: process.env.TMP || os.tmpdir(),
  };

  if (process.platform === "win32") {
    env.SystemRoot = process.env.SystemRoot || "C:\\Windows";
    env.ComSpec = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
  }

  return env;
}

function cleanupRateLimitBucket(ip) {
  const bucket = requestBuckets.get(ip);
  if (!bucket) return;

  const freshHits = bucket.hits.filter((hitTs) => Date.now() - hitTs <= RATE_LIMIT_WINDOW_MS);
  if (freshHits.length === 0) {
    requestBuckets.delete(ip);
    return;
  }

  bucket.hits = freshHits;
}

function isRateLimited(ip) {
  cleanupRateLimitBucket(ip);

  const bucket = requestBuckets.get(ip) ?? { hits: [] };
  bucket.hits.push(Date.now());
  requestBuckets.set(ip, bucket);

  return bucket.hits.length > RATE_LIMIT_MAX_REQUESTS;
}

function truncateOutput(text) {
  if (!text) return "";
  if (text.length <= MAX_OUTPUT_SIZE) return text;
  return `${text.slice(0, MAX_OUTPUT_SIZE)}\n\n[output truncated]`;
}

function killProcessTree(child) {
  if (!child?.pid) return;

  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      shell: false,
      windowsHide: true,
    });
    killer.on("error", () => child.kill("SIGKILL"));
    return;
  }

  child.kill("SIGKILL");
}

function runCommand(command, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      detached: false,
      env: getSafeEnv(),
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      if (stdout.length >= MAX_OUTPUT_SIZE) return;
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      if (stderr.length >= MAX_OUTPUT_SIZE) return;
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({
        ok: false,
        timedOut: false,
        stdout: truncateOutput(stdout),
        stderr: truncateOutput(`${stderr}\n${error.message}`),
        exitCode: null,
      });
    });

    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({
        ok: !timedOut && exitCode === 0,
        timedOut,
        stdout: truncateOutput(stdout),
        stderr: truncateOutput(stderr),
        exitCode,
      });
    });
  });
}

function hasBlockedPattern(language, code) {
  if (language === "javascript") {
    return JS_BLOCKLIST.find((pattern) => pattern.test(code));
  }

  if (language === "python") {
    return PY_BLOCKLIST.find((pattern) => pattern.test(code));
  }

  return null;
}

function getExecutionPlan(language, workDir, code) {
  if (language === "javascript") {
    const fileName = "main.js";
    return {
      fileName,
      compile: null,
      run: { command: "node", args: [fileName] },
    };
  }

  if (language === "python") {
    const fileName = "main.py";
    return {
      fileName,
      compile: null,
      run: { command: "python", args: [fileName] },
    };
  }

  if (language === "java") {
    const classNameMatch = code.match(/\b(?:public\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)/);
    const className = classNameMatch?.[1] || "Main";
    const fileName = `${className}.java`;
    return {
      fileName,
      compile: { command: "javac", args: [fileName] },
      run: { command: "java", args: ["-cp", workDir, className] },
    };
  }

  return null;
}

export async function executeCode(req, res) {
  const requesterIp = req.ip || req.socket.remoteAddress || "unknown";
  if (isRateLimited(requesterIp)) {
    return res.status(429).json({
      success: false,
      error: "Too many code execution requests. Please wait and try again.",
    });
  }

  const { language, code } = req.body || {};

  if (!language || typeof language !== "string") {
    return res.status(400).json({ success: false, error: "language is required" });
  }

  if (typeof code !== "string" || !code.trim()) {
    return res.status(400).json({ success: false, error: "code is required" });
  }

  if (code.length > MAX_CODE_SIZE) {
    return res.status(400).json({
      success: false,
      error: `Code is too large. Maximum ${MAX_CODE_SIZE} characters.`,
    });
  }

  const blockedPattern = hasBlockedPattern(language, code);
  if (blockedPattern) {
    return res.status(400).json({
      success: false,
      error: "Code rejected by security policy. Restricted API usage detected.",
    });
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "intbit-exec-"));
  const plan = getExecutionPlan(language, workDir, code);

  if (!plan) {
    await fs.rm(workDir, { recursive: true, force: true });
    return res.status(400).json({
      success: false,
      error: `Unsupported language: ${language}`,
    });
  }

  try {
    await fs.writeFile(path.join(workDir, plan.fileName), code, "utf8");

    if (plan.compile) {
      const compileResult = await runCommand(
        plan.compile.command,
        plan.compile.args,
        workDir,
        COMPILE_TIMEOUT_MS
      );

      if (!compileResult.ok) {
        return res.status(200).json({
          success: false,
          output: compileResult.stdout,
          error: compileResult.timedOut
            ? "Compilation timed out."
            : compileResult.stderr || "Compilation failed.",
        });
      }
    }

    const runResult = await runCommand(plan.run.command, plan.run.args, workDir, RUN_TIMEOUT_MS);
    if (!runResult.ok) {
      return res.status(200).json({
        success: false,
        output: runResult.stdout,
        error: runResult.timedOut ? "Execution timed out." : runResult.stderr || "Execution failed.",
      });
    }

    return res.status(200).json({
      success: true,
      output: runResult.stdout || "No output",
    });
  } catch (error) {
    const message =
      error?.code === "ENOENT"
        ? "Runtime not found on server. Install the selected language runtime."
        : "Failed to execute code on local server.";
    return res.status(200).json({ success: false, error: message });
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}
