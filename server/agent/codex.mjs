// Codex backend.
//
// Spawns `codex exec` in a child project cwd, pipes the prompt through stdin,
// and reads the final JSON message from --output-last-message. Mirrors the
// behaviour of fast-learning's previous inline spawn at index.mjs:416 / 563.
//
// Schema enforcement is done by codex itself via --output-schema; we do not
// need to add anything to the prompt. The result.output is the raw text from
// --output-last-message, identical to what the legacy code read off disk.

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

export class CodexBackend {
  /** @param {string} cliPath */
  constructor(cliPath) {
    this.cliPath = cliPath;
    this.name = "codex";
  }

  /**
   * @param {string} prompt
   * @param {import("./index.mjs").AgentOptions} options
   * @returns {Promise<import("./index.mjs").AgentResult>}
   */
  execute(prompt, options) {
    const { cwd, timeoutMs, env, schemaPath, outputPath } = options;
    if (!schemaPath || !outputPath) {
      return Promise.resolve({
        status: "failed",
        output: "",
        error: "codex backend requires schemaPath and outputPath in options",
        durationMs: 0,
      });
    }

    const start = Date.now();
    return new Promise((resolve) => {
      const child = spawn(
        this.cliPath,
        [
          "exec",
          "--skip-git-repo-check",
          "--ephemeral",
          "--sandbox",
          "read-only",
          "--color",
          "never",
          "--output-schema",
          schemaPath,
          "--output-last-message",
          outputPath,
          "-",
        ],
        {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
          env: env ? { ...process.env, ...env } : process.env,
        },
      );

      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGTERM"); } catch { /* already dead */ }
        resolve({
          status: "timeout",
          output: "",
          error: `codex timed out after ${timeoutMs}ms`,
          durationMs: Date.now() - start,
        });
      }, timeoutMs);

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.stdout.resume();

      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({
          status: "failed",
          output: "",
          error: error.message || String(error),
          durationMs: Date.now() - start,
        });
      });

      child.on("close", async (code) => {
        clearTimeout(timer);
        if (timedOut) return; // already resolved by the timer

        if (code !== 0) {
          const tail = stderr.trim().split("\n").slice(-3).join(" ");
          resolve({
            status: "failed",
            output: "",
            error: tail || `codex exit code ${code}`,
            durationMs: Date.now() - start,
          });
          return;
        }

        try {
          const raw = await readFile(outputPath, "utf8");
          resolve({
            status: "completed",
            output: raw,
            error: "",
            durationMs: Date.now() - start,
          });
        } catch (err) {
          resolve({
            status: "failed",
            output: "",
            error: `failed to read codex output: ${err.message}`,
            durationMs: Date.now() - start,
          });
        }
      });

      child.stdin.end(prompt);
    });
  }
}
