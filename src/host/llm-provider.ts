/**
 * LLM Provider using @anthropic-ai/claude-agent-sdk query() function.
 *
 * Converts SDK stream events into the SSE format expected by
 * the claude-to-im bridge conversation engine.
 */

import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { LLMProvider, StreamChatParams, FileAttachment } from '../lib/bridge/host.js';
import type { PendingPermissions } from './permission-gateway.js';

import path from 'node:path';
import { sseEvent } from './sse-utils.js';

// ── Environment isolation ──

/** Env vars always passed through to the CLI subprocess. */
const ENV_WHITELIST = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL',
  'LANG', 'LC_ALL', 'LC_CTYPE',
  'TMPDIR', 'TEMP', 'TMP',
  'TERM', 'COLORTERM',
  'NODE_PATH', 'NODE_EXTRA_CA_CERTS',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'SSH_AUTH_SOCK',
]);

/** Prefixes that are always stripped (even in inherit mode). */
const ENV_ALWAYS_STRIP = ['CLAUDECODE'];

/**
 * Build a clean env for the CLI subprocess.
 *
 * CTI_ENV_ISOLATION (default "strict"):
 *   "strict"  — only whitelist + CTI_* + ANTHROPIC_* from config.env
 *   "inherit" — full parent env minus CLAUDECODE
 */
export function buildSubprocessEnv(): Record<string, string> {
  const mode = process.env.CTI_ENV_ISOLATION || 'strict';
  const out: Record<string, string> = {};

  if (mode === 'inherit') {
    // Pass everything except always-stripped vars
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (ENV_ALWAYS_STRIP.includes(k)) continue;
      out[k] = v;
    }
  } else {
    // Strict: whitelist only
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (ENV_WHITELIST.has(k)) { out[k] = v; continue; }
      // Pass through CTI_* so skill config is available
      if (k.startsWith('CTI_')) { out[k] = v; continue; }
    }
    // ANTHROPIC_* should come from config.env, not parent process.
    // Only pass them if CTI_ANTHROPIC_PASSTHROUGH is explicitly set.
    if (process.env.CTI_ANTHROPIC_PASSTHROUGH === 'true') {
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && k.startsWith('ANTHROPIC_')) out[k] = v;
      }
    }

    // In codex/auto mode, pass through OPENAI_* / CODEX_* env vars
    const runtime = process.env.CTI_RUNTIME || 'claude';
    if (runtime === 'codex' || runtime === 'auto') {
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && (k.startsWith('OPENAI_') || k.startsWith('CODEX_'))) out[k] = v;
      }
    }
  }

  return out;
}

// ── Claude CLI path resolution ──

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the path to the `claude` CLI executable.
 * Priority: CTI_CLAUDE_CODE_EXECUTABLE env → which/where command → common install paths.
 */
export function resolveClaudeCliPath(): string | undefined {
  // 1. Explicit env var
  const fromEnv = process.env.CTI_CLAUDE_CODE_EXECUTABLE;
  if (fromEnv && isExecutable(fromEnv)) return fromEnv;

  // 2. Platform-specific command (which for Unix, where for Windows)
  const isWindows = process.platform === 'win32';
  const cmd = isWindows ? 'where claude' : 'which claude';
  try {
    const resolved = execSync(cmd, { encoding: 'utf-8', timeout: 3000 }).trim().split('\n')[0];
    if (resolved && isExecutable(resolved)) return resolved;
  } catch {
    // not found in PATH
  }

  // 3. Common install locations
  const candidates = isWindows
    ? [
        process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Programs\\claude\\claude.exe` : '',
        'C:\\Program Files\\claude\\claude.exe',
      ].filter(Boolean)
    : [
        '/usr/local/bin/claude',
        '/opt/homebrew/bin/claude',
        `${process.env.HOME}/.npm-global/bin/claude`,
        `${process.env.HOME}/.local/bin/claude`,
      ];
  for (const p of candidates) {
    if (p && isExecutable(p)) return p;
  }

  return undefined;
}

// ── Multi-modal prompt builder ──

type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

const SUPPORTED_IMAGE_TYPES = new Set<string>([
  'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp',
]);

/**
 * Build a prompt for query(). When files are present, returns an async
 * iterable that yields a single SDKUserMessage with multi-modal content
 * (image blocks + text). Otherwise returns the plain text string.
 */
function buildPrompt(
  text: string,
  files?: FileAttachment[],
): string | AsyncIterable<{ type: 'user'; message: { role: 'user'; content: unknown[] }; parent_tool_use_id: null; session_id: string }> {
  const imageFiles = files?.filter(f => SUPPORTED_IMAGE_TYPES.has(f.type));
  if (!imageFiles || imageFiles.length === 0) return text;

  const contentBlocks: unknown[] = [];

  for (const file of imageFiles) {
    contentBlocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: (file.type === 'image/jpg' ? 'image/jpeg' : file.type) as ImageMediaType,
        data: file.data,
      },
    });
  }

  if (text.trim()) {
    contentBlocks.push({ type: 'text', text });
  }

  const msg = {
    type: 'user' as const,
    message: { role: 'user' as const, content: contentBlocks },
    parent_tool_use_id: null,
    session_id: '',
  };

  return (async function* () { yield msg; })();
}

// ── Daemon lifecycle protection ──

/** Patterns that indicate a Bash command would stop/restart the daemon (i.e. kill this session). */
const DAEMON_LIFECYCLE_PATTERNS = [
  /daemon\.sh\s+(stop|restart)/i,
  /claude-to-im\s+(stop|restart)/i,
  /kill\s+.*\bnode\b.*daemon/i,
  /systemctl\s+(stop|restart).*claude/i,
  /pkill.*daemon/i,
];

/**
 * Collect PIDs of all running daemon instances by scanning runtime dirs.
 * Cached for 30s to avoid repeated FS reads.
 */
let daemonPidCache: { pids: Set<string>; expiry: number } | null = null;
const DAEMON_PID_CACHE_TTL_MS = 30_000;

function getDaemonPids(): Set<string> {
  if (daemonPidCache && Date.now() < daemonPidCache.expiry) return daemonPidCache.pids;

  const pids = new Set<string>();
  const homeDir = process.env.HOME || '/root';
  // Scan known CTI_HOME directories for PID files
  const ctiHomes = [
    path.join(homeDir, '.claude-to-im'),
    path.join(homeDir, '.claude-to-im-2'),
  ];
  // Also check CTI_HOME env var
  if (process.env.CTI_HOME) ctiHomes.push(process.env.CTI_HOME);

  for (const dir of ctiHomes) {
    try {
      const pidFile = path.join(dir, 'runtime', 'bridge.pid');
      const pid = fs.readFileSync(pidFile, 'utf-8').trim();
      if (/^\d+$/.test(pid)) pids.add(pid);
    } catch { /* file doesn't exist or unreadable */ }
  }

  daemonPidCache = { pids, expiry: Date.now() + DAEMON_PID_CACHE_TTL_MS };
  return pids;
}

/** Check if a Bash tool input contains a command that would stop/restart the daemon. */
function isDaemonLifecycleCommand(input: Record<string, unknown>): boolean {
  const command = typeof input.command === 'string' ? input.command : '';

  // Check static patterns first
  if (DAEMON_LIFECYCLE_PATTERNS.some(p => p.test(command))) return true;

  // Check if command contains `kill` targeting a known daemon PID
  if (/\bkill\b/.test(command)) {
    const pids = getDaemonPids();
    if (pids.size > 0) {
      // Extract all numbers from the kill command that could be PIDs
      const numbers = command.match(/\b\d{4,}\b/g) || [];
      for (const num of numbers) {
        if (pids.has(num)) return true;
      }
    }
  }

  return false;
}

// ── Claude2IM system prompt ──

/**
 * Appended to Claude Code's default system prompt so the LLM is aware
 * it is running inside the Claude2IM bridge, not a terminal.
 */
const CLAUDE2IM_SYSTEM_PROMPT_APPEND = `
You are running inside Claude2IM, a bridge that connects Claude Code to instant messaging platforms (Telegram, Discord, Feishu, QQ).

Key context about your environment:
- You are NOT in a terminal. The user is interacting with you through an IM app.
- Your responses are rendered as IM messages with platform-specific formatting. Keep responses concise when possible — very long outputs are harder to read in IM.
- Interactive terminal tools (AskUserQuestion) appear as inline buttons or prompts in the IM interface. They may time out if the user doesn't respond promptly.
- Permission requests for tool usage also appear as IM buttons — the user taps Allow/Deny in their chat app.
- NEVER attempt to stop, restart, or kill the daemon process (e.g. daemon.sh stop, kill the bridge PID, systemctl stop). This would terminate your own session and break the conversation.
- If the daemon is gracefully restarted (SIGUSR2), your session can be resumed automatically via sdkSessionId on the next message.
- The user may be on a mobile device with limited screen space. Prefer structured, scannable responses over walls of text.
`.trim();

// ── Plugin discovery ──

/** Cached plugin list with TTL to avoid per-message filesystem reads. */
let pluginCache: { result: Array<{ type: 'local'; path: string }>; expiry: number } | null = null;
const PLUGIN_CACHE_TTL_MS = 60_000;

/**
 * Discover enabled plugins by reading installed_plugins.json and
 * filtering against enabledPlugins in settings.json.
 * Results are cached for 60s to avoid blocking FS reads on every message.
 * Returns an array of { type: 'local', path: string } for the SDK.
 */
function discoverEnabledPlugins(): Array<{ type: 'local'; path: string }> {
  if (pluginCache && Date.now() < pluginCache.expiry) return pluginCache.result;

  const homeDir = process.env.HOME || '/root';
  const claudeDir = path.join(homeDir, '.claude');

  // Read settings to get enabled plugins (prefer settings.local.json)
  let enabledPlugins: Record<string, boolean> = {};
  const settingsPaths = [
    path.join(claudeDir, 'settings.local.json'),
    path.join(claudeDir, 'settings.json'),
  ];
  for (const p of settingsPaths) {
    try {
      const settings = JSON.parse(fs.readFileSync(p, 'utf-8'));
      enabledPlugins = settings.enabledPlugins || {};
      break;
    } catch { /* try next */ }
  }

  // Read installed plugins registry
  let installedPlugins: Record<string, Array<{ installPath: string }>> = {};
  try {
    const registryPath = path.join(claudeDir, 'plugins', 'installed_plugins.json');
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    installedPlugins = registry.plugins || {};
  } catch {
    pluginCache = { result: [], expiry: Date.now() + PLUGIN_CACHE_TTL_MS };
    return [];
  }

  const result: Array<{ type: 'local'; path: string }> = [];
  for (const [pluginKey, enabled] of Object.entries(enabledPlugins)) {
    if (!enabled) continue;
    const entries = installedPlugins[pluginKey];
    if (!entries || entries.length === 0) continue;
    const installPath = entries[0].installPath;
    if (installPath) {
      result.push({ type: 'local', path: installPath });
    }
  }

  pluginCache = { result, expiry: Date.now() + PLUGIN_CACHE_TTL_MS };
  return result;
}

export class SDKLLMProvider implements LLMProvider {
  private cliPath: string | undefined;
  private autoApprove: boolean;

  constructor(private pendingPerms: PendingPermissions, cliPath?: string, autoApprove = false) {
    this.cliPath = cliPath;
    this.autoApprove = autoApprove;
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const pendingPerms = this.pendingPerms;
    const cliPath = this.cliPath;
    const autoApprove = this.autoApprove;
    const isBypass = params.permissionMode === 'bypass';

    return new ReadableStream({
      start(controller) {
        (async () => {
          try {
            const cleanEnv = buildSubprocessEnv();
            const plugins = discoverEnabledPlugins();

            const queryOptions: Record<string, unknown> = {
              plugins: plugins.length > 0 ? plugins : undefined,
              cwd: params.workingDirectory,
              model: params.model,
              resume: params.sdkSessionId || undefined,
              abortController: params.abortController,
              permissionMode: (isBypass ? 'acceptEdits' : params.permissionMode as 'default' | 'acceptEdits' | 'plan') || undefined,
              includePartialMessages: true,
              env: cleanEnv,
              // Inject Claude2IM context so the LLM knows it's in an IM bridge
              systemPrompt: {
                type: 'preset',
                preset: 'claude_code',
                append: CLAUDE2IM_SYSTEM_PROMPT_APPEND,
              },
              canUseTool: async (
                  toolName: string,
                  input: Record<string, unknown>,
                  opts: { toolUseID: string; suggestions?: string[] },
                ): Promise<PermissionResult> => {
                  // Auto-approve if configured (useful for channels without
                  // interactive permission UI, e.g. Feishu WebSocket mode).
                  // Certain tools always require human decision:
                  //  - AskUserQuestion / ExitPlanMode: interactive by nature
                  //  - Bash commands that stop/restart the daemon: self-destructive
                  const needsHumanApproval =
                    toolName === 'AskUserQuestion' ||
                    toolName === 'ExitPlanMode' ||
                    (toolName === 'Bash' && isDaemonLifecycleCommand(input));

                  if ((autoApprove || isBypass) && !needsHumanApproval) {
                      return { behavior: 'allow' as const, updatedInput: input };
                  }

                  // AskUserQuestion: emit dedicated SSE event for interactive UI
                  if (toolName === 'AskUserQuestion') {
                    controller.enqueue(
                      sseEvent('ask_user_question', {
                        toolUseID: opts.toolUseID,
                        questions: (input as { questions?: unknown[] }).questions || [],
                      }),
                    );
                    const result = await pendingPerms.waitFor(opts.toolUseID);
                    if (result.behavior === 'allow') {
                      return { behavior: 'allow' as const, updatedInput: result.updatedInput ?? input };
                    }
                    return { behavior: 'deny' as const, message: result.message || 'Denied via IM' };
                  }

                  // Emit permission_request SSE event for the bridge
                  controller.enqueue(
                    sseEvent('permission_request', {
                      permissionRequestId: opts.toolUseID,
                      toolName,
                      toolInput: input,
                      suggestions: opts.suggestions || [],
                    }),
                  );

                  // Block until IM user responds
                  const result = await pendingPerms.waitFor(opts.toolUseID);

                  if (result.behavior === 'allow') {
                    return { behavior: 'allow' as const, updatedInput: input };
                  }
                  return {
                    behavior: 'deny' as const,
                    message: result.message || 'Denied by user',
                  };
                },
            };
            if (cliPath) {
              queryOptions.pathToClaudeCodeExecutable = cliPath;
            }

            const prompt = buildPrompt(params.prompt, params.files);
            const q = query({
              prompt: prompt as Parameters<typeof query>[0]['prompt'],
              options: queryOptions as Parameters<typeof query>[0]['options'],
            });

            for await (const msg of q) {
              handleMessage(msg, controller);
            }

            controller.close();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // Log full error (including stack) to bridge log for debugging
            console.error('[llm-provider] SDK query error:', err instanceof Error ? err.stack || err.message : err);
            // Send simplified but actionable summary to IM
            controller.enqueue(sseEvent('error', message));
            controller.close();
          }
        })();
      },
    });
  }
}

function handleMessage(
  msg: SDKMessage,
  controller: ReadableStreamDefaultController<string>,
): void {
  switch (msg.type) {
    case 'stream_event': {
      const event = msg.event;
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        // Emit delta text — the bridge accumulates on its side
        controller.enqueue(sseEvent('text', event.delta.text));
      }
      if (
        event.type === 'content_block_start' &&
        event.content_block.type === 'thinking'
      ) {
        controller.enqueue(sseEvent('thinking', 'start'));
      }
      if (
        event.type === 'content_block_start' &&
        event.content_block.type === 'tool_use'
      ) {
        controller.enqueue(
          sseEvent('tool_use', {
            id: event.content_block.id,
            name: event.content_block.name,
            input: {},
          }),
        );
      }
      break;
    }

    case 'assistant': {
      // Full assistant message — extract content blocks
      // Text deltas are already handled by stream_event; this handles
      // any tool_use blocks not caught by partial streaming.
      if (msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_use') {
            controller.enqueue(
              sseEvent('tool_use', {
                id: block.id,
                name: block.name,
                input: block.input,
              }),
            );
          }
        }
      }
      break;
    }

    case 'user': {
      // User messages contain tool_result blocks from completed tool calls
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'tool_result') {
            const rb = block as { tool_use_id: string; content?: unknown; is_error?: boolean };
            const text = typeof rb.content === 'string'
              ? rb.content
              : JSON.stringify(rb.content ?? '');
            controller.enqueue(
              sseEvent('tool_result', {
                tool_use_id: rb.tool_use_id,
                content: text,
                is_error: rb.is_error || false,
              }),
            );
          }
        }
      }
      break;
    }

    case 'result': {
      if (msg.subtype === 'success') {
        controller.enqueue(
          sseEvent('result', {
            session_id: msg.session_id,
            is_error: msg.is_error,
            usage: {
              input_tokens: msg.usage.input_tokens,
              output_tokens: msg.usage.output_tokens,
              cache_read_input_tokens: msg.usage.cache_read_input_tokens ?? 0,
              cache_creation_input_tokens: msg.usage.cache_creation_input_tokens ?? 0,
              cost_usd: msg.total_cost_usd,
            },
          }),
        );
      } else {
        // Error result
        const errors =
          'errors' in msg && Array.isArray(msg.errors)
            ? msg.errors.join('; ')
            : 'Unknown error';
        controller.enqueue(sseEvent('error', errors));
      }
      break;
    }

    case 'system': {
      if (msg.subtype === 'init') {
        controller.enqueue(
          sseEvent('status', {
            session_id: msg.session_id,
            model: msg.model,
          }),
        );
      }
      break;
    }

    default:
      // Ignore other message types (auth_status, task_notification, etc.)
      break;
  }
}
