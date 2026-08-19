// Claude Code backend.
//
// Spawns `claude -p <prompt> --output-format stream-json --verbose
// --permission-mode bypassPermissions` and accumulates the assistant text
// out of the stream-json event stream.
//
// Reference: alook/src/cli/daemon/agent/claude.ts (260 lines, same shape).
// We skip the AsyncIterable/SSE plumbing — fast-learning wants a single
// accumulated string, not a live event feed.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export class ClaudeBackend {
  /** @param {string} cliPath */
  constructor(cliPath) {
    this.cliPath = cliPath;
    this.name = "claude";
  }

  /**
   * @param {string} prompt
   * @param {import("./index.mjs").AgentOptions} options
   * @returns {Promise<import("./index.mjs").AgentResult>}
   */
  execute(prompt, options) {
    const { cwd, timeoutMs, env } = options;
    const args = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
    ];

    // Lift claude CLI output cap (default ~4K tokens) so lesson mode can emit
    // a full SVG + lesson JSON in one turn. Caller can override per-call via
    // options.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS; otherwise we use 16K which
    // comfortably fits the current lesson schema.
    const mergedEnv = {
      ...process.env,
      CLAUDE_CODE_MAX_OUTPUT_TOKENS:
        (env && env.CLAUDE_CODE_MAX_OUTPUT_TOKENS) || "16384",
      ...(env || {}),
    };

    const start = Date.now();
    return new Promise((resolve) => {
      const child = spawn(this.cliPath, args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: mergedEnv,
      });

      let timedOut = false;
      let lastOutput = "";
      let lastError = "";
      /** @type {"completed" | "failed" | "aborted"} */
      let resultStatus = "completed";

      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGTERM"); } catch { /* already dead */ }
      }, timeoutMs);

      const stderrChunks = [];
      child.stderr.on("data", (chunk) => {
        stderrChunks.push(chunk.toString());
      });
      child.stdout.on("data", (chunk) => {
        // We use readline for line-level JSON parsing, but drain here so
        // the pipe never blocks.
      });

      const rl = createInterface({ input: child.stdout });

      rl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        /** @type {any} */
        let event;
        try {
          event = JSON.parse(trimmed);
        } catch {
          // Non-JSON stdout lines (e.g. progress spinners) — ignore.
          return;
        }

        const eventType = event.type;
        if (eventType === "assistant") {
          const message = event.message;
          const content = message?.content;
          if (!Array.isArray(content)) return;
          for (const block of content) {
            if (block.type === "text" && typeof block.text === "string") {
              lastOutput = block.text;
            }
          }
        } else if (eventType === "result") {
          if (typeof event.result === "string") {
            lastOutput = event.result;
          }
          if (event.is_error) {
            resultStatus = "failed";
            if (!lastError) lastError = lastOutput || "unknown error";
          }
        } else if (eventType === "control_request") {
          // Auto-approve permission/tool prompts so a oneshot can run unattended.
          // Mirrors alook's handleControlRequest (claude.ts:261-298).
          const requestId = event.request_id;
          if (!requestId) return;
          let updatedInput = undefined;
          const payload = event.payload;
          if (payload && typeof payload.input === "string") {
            try { updatedInput = JSON.parse(payload.input); }
            catch { updatedInput = payload.input; }
          } else if (payload) {
            updatedInput = payload.input;
          }
          const approval = JSON.stringify({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: requestId,
              response: { behavior: "allow", updatedInput },
            },
          });
          try { child.stdin.write(approval + "\n"); } catch { /* stdin closed */ }
        }
        // 'system' / 'user' / 'tool_result' / unknown — ignored.
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({
          status: timedOut ? "timeout" : "failed",
          output: lastOutput,
          error: lastError || err.message || String(err),
          durationMs: Date.now() - start,
        });
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          resolve({
            status: "timeout",
            output: lastOutput,
            error: `claude timed out after ${timeoutMs}ms`,
            durationMs: Date.now() - start,
          });
          return;
        }
        if (code !== 0 && resultStatus === "completed") {
          resultStatus = "failed";
        }
        const stderr = stderrChunks.join("");
        if (stderr && !lastError) lastError = stderr.trim().split("\n").slice(-3).join(" ");
        resolve({
          status: resultStatus,
          output: lastOutput,
          error: lastError,
          durationMs: Date.now() - start,
        });
      });
    });
  }
}
