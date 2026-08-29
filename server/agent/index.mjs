// Agent runner abstraction.
//
// Each backend (codex / claude / opencode) is a CLI subprocess wrapped by an
// AgentBackend implementation. The factory picks one by name. CLI binary
// resolution follows the solo convention: <TYPE>_BIN env > default name.
//
// Reference patterns:
//   - solo  pkg/agent/{backend,registry,builtins}.go
//   - alook src/cli/daemon/agent/{index,codex,claude,opencode}.ts
//   - multica server/pkg/agent/opencode.go (opencode run --format json)
//
// Unlike solo (long-lived persistent sessions) or alook (AsyncIterable stream
// for SSE), Solo Learning wants a one-shot: send prompt, get a single string
// of accumulated assistant text. We expose that as Promise<AgentResult>.

import { CodexBackend } from "./codex.mjs";
import { ClaudeBackend } from "./claude.mjs";
import { OpenCodeBackend } from "./opencode.mjs";

/** @typedef {"completed" | "failed" | "aborted" | "timeout"} AgentStatus */

/**
 * @typedef {Object} AgentResult
 * @property {AgentStatus} status
 * @property {string} output  Full assistant text (caller will JSON.parse it).
 * @property {string} error   Last stderr / protocol error if any.
 * @property {number} durationMs
 */

/**
 * @typedef {Object} AgentOptions
 * @property {string} cwd
 * @property {number} timeoutMs
 * @property {Record<string, string>=} env
 * @property {string[]=} images      Codex-only: local image paths attached with --image.
 * @property {string=} schemaPath   Codex-only: --output-schema file path.
 * @property {string=} outputPath   Codex-only: --output-last-message file path.
 */

/**
 * @typedef {Object} AgentBackend
 * @property {string} name
 * @property {(prompt: string, options: AgentOptions) => Promise<AgentResult>} execute
 */

/** @type {Record<string, { binary: string, envVar: string, build: (cliPath: string) => AgentBackend }>} */
const REGISTRY = {
  codex: {
    binary: "codex",
    envVar: "CODEX_BIN",
    build: (cliPath) => new CodexBackend(cliPath),
  },
  claude: {
    binary: "claude",
    envVar: "CLAUDE_BIN",
    build: (cliPath) => new ClaudeBackend(cliPath),
  },
  opencode: {
    binary: "opencode",
    envVar: "OPENCODE_BIN",
    build: (cliPath) => new OpenCodeBackend(cliPath),
  },
};

export const SUPPORTED_AGENTS = Object.keys(REGISTRY);

/**
 * Resolve the CLI path for a given agent type. Priority matches solo's
 * execPathOrDefault: explicit cfg path > <TYPE>_BIN env > default name.
 *
 * @param {string} type
 * @param {string=} explicitPath
 * @returns {string}
 */
export function resolveCliPath(type, explicitPath) {
  const entry = REGISTRY[type];
  if (!entry) throw new Error(`Unknown agent type: ${type}`);
  if (explicitPath) return explicitPath;
  const fromEnv = process.env[entry.envVar];
  if (fromEnv) return fromEnv;
  return entry.binary;
}

/**
 * @param {string} type
 * @param {string=} cliPath
 * @returns {AgentBackend}
 */
export function createBackend(type, cliPath) {
  const entry = REGISTRY[type];
  if (!entry) {
    throw new Error(
      `Unknown agent type: ${type} (supported: ${SUPPORTED_AGENTS.join(", ")})`,
    );
  }
  return entry.build(cliPath || resolveCliPath(type));
}

/**
 * Run an agent and return the accumulated assistant text. Throws on failure
 * with a message that includes the raw output when JSON parsing later fails
 * (so callers can surface "agent X 输出不是合法 JSON: <raw>").
 *
 * @param {string} type
 * @param {string} prompt
 * @param {AgentOptions} options
 * @returns {Promise<string>}
 */
export async function runAgent(type, prompt, options) {
  const backend = createBackend(type);
  const result = await backend.execute(prompt, options);
  if (result.status !== "completed") {
    const detail = result.error || result.output || "no output";
    throw new Error(
      `${backend.name} agent ${result.status}: ${detail.slice(0, 800)}`,
    );
  }
  return result.output;
}

export { CodexBackend, ClaudeBackend, OpenCodeBackend };
