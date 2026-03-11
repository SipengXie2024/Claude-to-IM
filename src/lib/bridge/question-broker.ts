/**
 * Question Broker — handles AskUserQuestion interactive rendering for IM channels.
 *
 * When Claude calls AskUserQuestion, the broker:
 * 1. Renders each question as a message with inline keyboard buttons
 * 2. Tracks multi-select toggle state and free-text input
 * 3. Collects answers and resolves the pending permission with updatedInput
 */

import crypto from 'crypto';
import type { ChannelAddress, OutboundMessage } from './types.js';
import type { BaseChannelAdapter } from './channel-adapter.js';
import type { AskUserQuestionInfo } from './conversation-engine.js';
import { deliver } from './delivery-layer.js';
import { getBridgeContext } from './context.js';
import { escapeHtml } from './adapters/telegram-utils.js';

interface QuestionOption {
  label: string;
  description?: string;
}

interface Question {
  question: string;
  header?: string;
  options?: QuestionOption[];
  multiSelect?: boolean;
}

interface PendingQuestion {
  toolUseID: string;
  shortId: string;
  questions: Question[];
  answers: Record<string, string>;
  currentQuestionIdx: number;
  multiSelectState: Map<number, Set<number>>;
  chatId: string;
  channelType: string;
  messageIds: string[];
}

/** Map from shortId to PendingQuestion */
const pendingQuestions = new Map<string, PendingQuestion>();
/** Map from chatId to shortId for supersede-on-new-question cleanup */
const chatToPending = new Map<string, string>();

/**
 * Generate a 6-char short ID from a toolUseID for compact callback_data.
 */
function makeShortId(toolUseID: string): string {
  const hex = crypto.createHash('sha256').update(toolUseID).digest('hex');
  // Convert first 8 hex chars to base36 for a compact 6-char ID
  return parseInt(hex.slice(0, 8), 16).toString(36).padStart(6, '0').slice(0, 6);
}

/**
 * Render and send a single question as a message with inline buttons.
 */
async function sendQuestion(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  pq: PendingQuestion,
  qIdx: number,
): Promise<void> {
  const q = pq.questions[qIdx];
  const isMulti = q.multiSelect === true;

  // Build message text
  const lines: string[] = [];
  if (q.header) {
    lines.push(`<b>${escapeHtml(q.header)}</b>`);
  }
  lines.push(escapeHtml(q.question));
  lines.push('');
  lines.push(isMulti ? 'Select one or more:' : 'Choose one:');

  const text = lines.join('\n');

  // Build inline keyboard
  const buttons: Array<Array<{ text: string; callbackData: string }>> = [];

  if (q.options && q.options.length > 0) {
    const selected = pq.multiSelectState.get(qIdx) || new Set<number>();
    for (let i = 0; i < q.options.length; i++) {
      const opt = q.options[i];
      const prefix = isMulti ? (selected.has(i) ? '✅ ' : '') : '';
      const label = opt.description
        ? `${prefix}${opt.label} - ${opt.description}`
        : `${prefix}${opt.label}`;
      buttons.push([{ text: label, callbackData: `auq:${pq.shortId}:${qIdx}:opt${i}` }]);
    }
  }

  buttons.push([{ text: '💬 Chat about this', callbackData: `auq:${pq.shortId}:${qIdx}:chat` }]);

  if (isMulti) {
    buttons.push([{ text: '✅ Done', callbackData: `auq:${pq.shortId}:${qIdx}:done` }]);
  }

  const message: OutboundMessage = {
    address,
    text,
    parseMode: 'HTML',
    inlineButtons: buttons,
  };

  const result = await deliver(adapter, message);
  if (result.ok && result.messageId) {
    pq.messageIds.push(result.messageId);
  }
}

/**
 * Advance to the next question or resolve all answers.
 */
function advanceOrResolve(pq: PendingQuestion, adapter: BaseChannelAdapter, address: ChannelAddress): void {
  pq.currentQuestionIdx++;

  if (pq.currentQuestionIdx >= pq.questions.length) {
    // All questions answered — resolve
    resolveAllQuestions(pq);
  } else {
    // Send next question
    sendQuestion(adapter, address, pq, pq.currentQuestionIdx).catch((err) => {
      console.error('[question-broker] Failed to send next question:', err);
    });
  }
}

/**
 * Resolve the pending permission with collected answers.
 */
function resolveAllQuestions(pq: PendingQuestion): void {
  const { permissions } = getBridgeContext();
  pendingQuestions.delete(pq.shortId);
  chatToPending.delete(pq.chatId);

  permissions.resolvePendingPermission(pq.toolUseID, {
    behavior: 'allow',
    updatedInput: {
      questions: pq.questions,
      answers: pq.answers,
    },
  });
}

/**
 * Resolve as deny (for "Chat about this" flow).
 */
function resolveAsDeny(pq: PendingQuestion, message: string): void {
  const { permissions } = getBridgeContext();
  pendingQuestions.delete(pq.shortId);
  chatToPending.delete(pq.chatId);

  permissions.resolvePendingPermission(pq.toolUseID, {
    behavior: 'deny',
    message,
  });
}

// ── Public API ───────────────────────────────────────────────

/**
 * Forward an AskUserQuestion to the IM channel.
 * Sends the first question immediately; subsequent questions are sent
 * as the user answers each one.
 */
export async function forwardAskUserQuestion(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  info: AskUserQuestionInfo,
): Promise<void> {
  const shortId = makeShortId(info.toolUseID);

  // Cancel any existing question session for this chat
  const existingShortId = chatToPending.get(address.chatId);
  if (existingShortId) {
    const existing = pendingQuestions.get(existingShortId);
    if (existing) {
      resolveAsDeny(existing, 'Superseded by new question');
    }
  }

  const pq: PendingQuestion = {
    toolUseID: info.toolUseID,
    shortId,
    questions: info.questions as Question[],
    answers: {},
    currentQuestionIdx: 0,
    multiSelectState: new Map(),
    chatId: address.chatId,
    channelType: address.channelType,
    messageIds: [],
  };

  // Initialize multi-select state
  for (let i = 0; i < pq.questions.length; i++) {
    if (pq.questions[i].multiSelect) {
      pq.multiSelectState.set(i, new Set());
    }
  }

  pendingQuestions.set(shortId, pq);
  chatToPending.set(address.chatId, shortId);

  // Send the first question
  await sendQuestion(adapter, address, pq, 0);
}

/**
 * Handle a callback query from an AskUserQuestion inline button.
 * Returns true if the callback was recognized and handled.
 */
export function handleQuestionCallback(
  adapter: BaseChannelAdapter,
  callbackData: string,
  chatId: string,
  callbackMessageId?: string,
): boolean {
  // Parse: auq:<shortId>:<qIdx>:<action>
  const parts = callbackData.split(':');
  if (parts.length < 4 || parts[0] !== 'auq') return false;

  const shortId = parts[1];
  const qIdx = parseInt(parts[2], 10);
  const action = parts[3];

  const pq = pendingQuestions.get(shortId);
  if (!pq) return false;
  if (pq.chatId !== chatId) return false;

  const q = pq.questions[qIdx];
  if (!q) return false;

  const address: ChannelAddress = {
    channelType: pq.channelType,
    chatId: pq.chatId,
  };

  if (action.startsWith('opt')) {
    const optIdx = parseInt(action.slice(3), 10);
    if (!q.options || optIdx >= q.options.length) return false;

    if (q.multiSelect) {
      // Toggle selection
      const selected = pq.multiSelectState.get(qIdx) || new Set<number>();
      if (selected.has(optIdx)) {
        selected.delete(optIdx);
      } else {
        selected.add(optIdx);
      }
      pq.multiSelectState.set(qIdx, selected);

      // Update buttons via editMessageReplyMarkup
      editQuestionButtons(adapter, chatId, callbackMessageId, pq, qIdx);
    } else {
      // Single select — record answer and advance
      pq.answers[q.question] = q.options[optIdx].label;
      advanceOrResolve(pq, adapter, address);
    }
    return true;
  }

  if (action === 'chat') {
    // Immediately deny with clarification message (matches official Claude Code CLI behavior).
    // Claude will receive this as a rejection with context and respond conversationally.
    const clarification = buildClarificationMessage(pq);
    resolveAsDeny(pq, clarification);
    return true;
  }

  if (action === 'done') {
    if (!q.multiSelect) return false;
    // Collect selected labels
    const selected = pq.multiSelectState.get(qIdx) || new Set<number>();
    if (selected.size === 0 && q.options && q.options.length > 0) {
      // No selection — send hint
      deliver(adapter, {
        address,
        text: 'Please select at least one option.',
        parseMode: 'plain',
      }).catch(() => {});
      return true;
    }
    const labels = q.options
      ? Array.from(selected).sort((a, b) => a - b).map(i => q.options![i].label)
      : [];
    pq.answers[q.question] = labels.join(', ');
    advanceOrResolve(pq, adapter, address);
    return true;
  }

  return false;
}

/**
 * Build a clarification message matching official Claude Code CLI behavior.
 * Includes the questions asked and any answers already provided.
 */
function buildClarificationMessage(pq: PendingQuestion): string {
  const lines: string[] = [
    'The user wants to clarify these questions.',
    'This means they may have additional information, context or questions for you.',
    'Take their response into account and then reformulate the questions if appropriate.',
    'Start by asking them what they would like to clarify.',
    'Questions asked:',
  ];
  for (const q of pq.questions) {
    const answer = pq.answers[q.question];
    if (answer) {
      lines.push(`- "${q.question}"\n  Answer: ${answer}`);
    } else {
      lines.push(`- "${q.question}"\n  (No answer provided)`);
    }
  }
  return lines.join('\n');
}

/**
 * Update inline keyboard buttons for a multi-select question (toggle checkboxes).
 */
function editQuestionButtons(
  adapter: BaseChannelAdapter,
  chatId: string,
  messageId: string | undefined,
  pq: PendingQuestion,
  qIdx: number,
): void {
  if (!messageId) return;
  if (!adapter.editMessageButtons) return;

  const q = pq.questions[qIdx];
  if (!q || !q.options) return;

  const selected = pq.multiSelectState.get(qIdx) || new Set<number>();
  const buttons: Array<Array<{ text: string; callbackData: string }>> = [];

  for (let i = 0; i < q.options.length; i++) {
    const opt = q.options[i];
    const prefix = selected.has(i) ? '✅ ' : '';
    const label = opt.description
      ? `${prefix}${opt.label} - ${opt.description}`
      : `${prefix}${opt.label}`;
    buttons.push([{ text: label, callbackData: `auq:${pq.shortId}:${qIdx}:opt${i}` }]);
  }

  buttons.push([{ text: '💬 Chat about this', callbackData: `auq:${pq.shortId}:${qIdx}:chat` }]);
  buttons.push([{ text: '✅ Done', callbackData: `auq:${pq.shortId}:${qIdx}:done` }]);

  adapter.editMessageButtons(chatId, messageId, buttons).catch((err) => {
    console.error('[question-broker] Failed to edit buttons:', err);
  });
}
