// OpenCode backend.
//
// Spawns `opencode run --format json --dir <cwd> <prompt>` and accumulates
// the assistant text from the JSON event stream. We force-permit everything
// via OPENCODE_PERMISSION so the oneshot never blocks on a permission prompt.
//
// References:
//   - alook    src/cli/daemon/agent/opencode.ts (opencode run --format json)
//   - multica  server/pkg/agent/opencode.go     (same flag set, same events)
//
// Event shape (v1.14+):
//   { type: "session",     session_id }
//   { type: "step_start" }
//   { type: "text",        part: { text: "..." } }   <-- assistant text
//   { type: "message",     role: "assistant", content: "..." }  (legacy)
//   { type: "thinking",    part: { thinking: "..." } }
//   { type: "tool_call",   call_id, name, input }
//   { type: "tool_result", call_id, output }
//   { type: "step_finish", part: { reason: "stop" | "end_turn" | ... } }
//   { type: "done"|"complete", status, output }
//   { type: "error",       message }

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export class OpenCodeBackend {
  /** @param {string} cliPath */
  constructor(cliPath) {
    this.cliPath = cliPath;
    this.name = "opencode";
  }

  /**
   * @param {string} prompt
   * @param {import("./index.mjs").AgentOptions} options
   * @returns {Promise<import("./index.mjs").AgentResult>}
   */
  execute(prompt, options) {
    const { cwd, timeoutMs, env } = options;
    const args = ["run", "--format", "json", "--dir", cwd, prompt];

    const start = Date.now();
    return new Promise((resolve) => {
      const child = spawn(this.cliPath, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...(env || process.env),
          OPENCODE_PERMISSION: '{"*":"allow"}',
        },
      });

      let timedOut = false;
      let lastOutput = "";
      let lastError = "";
      let turnDone = false;
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

      const rl = createInterface({ input: child.stdout });

      const finish = (status) => {
        if (turnDone) return;
        turnDone = true;
        resultStatus = status;
        try { child.kill("SIGTERM"); } catch { /* already dead */ }
      };

      rl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        /** @type {any} */
        let event;
        try {
          event = JSON.parse(trimmed);
        } catch {
          return;
        }
        const eventType = event.type;
        const part = event.part;

        switch (eventType) {
          case "text": {
            const text = part?.text ?? event.content;
            if (typeof text === "string" && text) {
              lastOutput = text;
            }
            break;
          }
          case "message": {
            // legacy format: { type: "message", role: "assistant", content: "..." }
            if (event.role === "assistant" && typeof event.content === "string") {
              lastOutput = event.content;
            }
            break;
          }
          case "step_finish": {
            const reason = part?.reason;
            if (reason === "stop" || reason === "end_turn") {
              finish("completed");
            }
            break;
          }
          case "done":
          case "complete": {
            if (typeof event.output === "string") lastOutput = event.output;
            if (event.status === "error" || event.status === "failed") {
              finish("failed");
              if (!lastError) lastError = lastOutput || "opencode run failed";
            } else {
              finish("completed");
            }
            break;
          }
          case "error": {
            const content =
              event.message ?? event.content ?? part?.error ?? "opencode error";
            lastError = String(content);
            finish("failed");
            break;
          }
          default:
            // session / step_start / thinking / tool_call / tool_result — ignored
            break;
        }
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
            error: `opencode timed out after ${timeoutMs}ms`,
            durationMs: Date.now() - start,
          });
          return;
        }
        if (code !== 0 && resultStatus === "completed" && !turnDone) {
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
