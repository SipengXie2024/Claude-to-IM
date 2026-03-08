/**
 * Question Broker — renders AskUserQuestion prompts as interactive TG messages
 * with inline buttons, handles single-select, multi-select, and free-text answers.
 *
 * Flow:
 * 1. forwardAskUserQuestion() sends a message with option buttons + "Chat about this"
 * 2. User clicks an option → handleQuestionCallback() records the answer
 *    - Single-select: immediately resolves (or advances to next question)
 *    - Multi-select: toggles selection, waits for "Done"
 *    - Chat: sets awaitingFreeText, next user message goes to handleFreeTextAnswer()
 * 3. When all questions answered → resolves via permissions gateway with updatedInput
 *
 * Callback data format: auq:{shortId}:{questionIndex}:{action}
 *   action = opt0, opt1, ... | chat | done | other (removed)
 */

import type { ChannelAddress, OutboundMessage } from './types.js';
import type { BaseChannelAdapter } from './channel-adapter.js';
import { deliver } from './delivery-layer.js';
import { getBridgeContext } from './context.js';
import { escapeHtml } from './adapters/telegram-utils.js';
import crypto from 'crypto';

// ── Types ──

interface QuestionOption {
  label: string;
  description?: string;
  preview?: string;
}

interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: QuestionOption[];
}

interface AskUserQuestionPayload {
  toolUseID: string;
  questions: Question[];
}

interface PendingQuestion {
  toolUseID: string;
  shortId: string;
  questions: Question[];
  currentIndex: number;
  answers: Record<string, string>;
  /** For multi-select: currently toggled option indices per question index */
  multiSelectState: Map<number, Set<number>>;
  chatId: string;
  adapter: BaseChannelAdapter;
  address: ChannelAddress;
  awaitingFreeText: boolean;
  messageId?: string;
}

// ── State ──

/** Map chatId → pending question state. Only one active question per chat. */
const pendingQuestions = new Map<string, PendingQuestion>();
/** Map shortId → chatId for reverse lookup from callbacks */
const shortIdToChat = new Map<string, string>();

// ── Public API ──

/**
 * Forward an AskUserQuestion to the IM channel with interactive buttons.
 * If there's already a pending question in this chat, the old one is denied (superseded).
 */
export async function forwardAskUserQuestion(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  payload: AskUserQuestionPayload,
): Promise<void> {
  const chatId = address.chatId;

  // Supersede any existing pending question in this chat
  const existing = pendingQuestions.get(chatId);
  if (existing) {
    const { permissions } = getBridgeContext();
    permissions.resolvePendingPermission(existing.toolUseID, {
      behavior: 'deny',
      message: 'Superseded by new question',
    });
    shortIdToChat.delete(existing.shortId);
    pendingQuestions.delete(chatId);
  }

  const shortId = crypto.randomBytes(3).toString('hex');
  const state: PendingQuestion = {
    toolUseID: payload.toolUseID,
    shortId,
    questions: payload.questions,
    currentIndex: 0,
    answers: {},
    multiSelectState: new Map(),
    chatId,
    adapter,
    address,
    awaitingFreeText: false,
  };

  pendingQuestions.set(chatId, state);
  shortIdToChat.set(shortId, chatId);

  await sendQuestion(state, 0);
}

/**
 * Handle a callback query from an AskUserQuestion inline button.
 * Returns true if the callback was recognized and handled.
 */
export function handleQuestionCallback(
  adapter: BaseChannelAdapter,
  callbackData: string,
  callbackChatId: string,
  callbackMessageId?: string,
): boolean {
  // Parse: auq:{shortId}:{questionIndex}:{action}
  const parts = callbackData.split(':');
  if (parts.length < 4 || parts[0] !== 'auq') return false;

  const shortId = parts[1];
  const questionIndex = parseInt(parts[2], 10);
  const action = parts[3];

  const chatId = shortIdToChat.get(shortId);
  if (!chatId) return false;

  const state = pendingQuestions.get(chatId);
  if (!state || state.shortId !== shortId) return false;

  // Security: verify callback comes from the same chat
  if (callbackChatId !== state.chatId) return false;

  const question = state.questions[questionIndex];
  if (!question) return false;

  if (action === 'chat') {
    state.awaitingFreeText = true;
    return true;
  }

  if (action === 'done') {
    // Multi-select done
    const selected = state.multiSelectState.get(questionIndex);
    if (!selected || selected.size === 0) {
      // Reject empty multi-select — send hint
      deliver(adapter, {
        address: state.address,
        text: 'Please select at least one option before pressing Done.',
        parseMode: 'plain',
      }).catch(() => {});
      return true;
    }

    // Build comma-separated answer from selected options
    const labels = [...selected]
      .sort((a, b) => a - b)
      .map(i => question.options[i]?.label)
      .filter(Boolean);
    state.answers[question.question] = labels.join(', ');

    advanceOrResolve(state);
    return true;
  }

  // Option selection: optN
  const optMatch = action.match(/^opt(\d+)$/);
  if (!optMatch) return false;

  const optIndex = parseInt(optMatch[1], 10);
  if (optIndex >= question.options.length) return false;

  if (question.multiSelect) {
    // Toggle selection
    if (!state.multiSelectState.has(questionIndex)) {
      state.multiSelectState.set(questionIndex, new Set());
    }
    const selected = state.multiSelectState.get(questionIndex)!;
    if (selected.has(optIndex)) {
      selected.delete(optIndex);
    } else {
      selected.add(optIndex);
    }
    // Update button labels to show selection state
    updateMultiSelectButtons(state, questionIndex);
    return true;
  }

  // Single-select: record answer immediately
  state.answers[question.question] = question.options[optIndex].label;
  advanceOrResolve(state);
  return true;
}

/**
 * Handle a free-text message as an answer to a "Chat about this" action.
 */
export function handleFreeTextAnswer(
  adapter: BaseChannelAdapter,
  chatId: string,
  text: string,
): void {
  const state = pendingQuestions.get(chatId);
  if (!state || !state.awaitingFreeText) return;

  // Resolve as deny with user's feedback text
  const { permissions } = getBridgeContext();
  permissions.resolvePendingPermission(state.toolUseID, {
    behavior: 'deny',
    message: text,
  });

  cleanup(state);
}

/**
 * Check if a chat has a pending question awaiting free-text input.
 */
export function hasPendingQuestion(chatId: string): boolean {
  const state = pendingQuestions.get(chatId);
  return state?.awaitingFreeText === true;
}

// ── Internal helpers ──

async function sendQuestion(state: PendingQuestion, index: number): Promise<void> {
  state.currentIndex = index;
  const question = state.questions[index];

  // Build header
  const header = question.header
    ? `<b>${escapeHtml(question.header)}</b>\n\n`
    : '';

  // Build description lines for options
  const optionDescriptions = question.options
    .map((opt, i) => {
      const desc = opt.description ? ` — ${opt.description}` : '';
      return `${i + 1}. <b>${escapeHtml(opt.label)}</b>${escapeHtml(desc)}`;
    })
    .join('\n');

  const text = `${header}${escapeHtml(question.question)}\n\n${optionDescriptions}`;

  // Build inline buttons
  const buttons: Array<Array<{ text: string; callbackData: string }>> = [];

  for (let i = 0; i < question.options.length; i++) {
    buttons.push([{
      text: question.options[i].label,
      callbackData: `auq:${state.shortId}:${index}:opt${i}`,
    }]);
  }

  // Chat about this button
  buttons.push([{
    text: '💬 Chat about this',
    callbackData: `auq:${state.shortId}:${index}:chat`,
  }]);

  // Done button for multi-select
  if (question.multiSelect) {
    buttons.push([{
      text: '✅ Done',
      callbackData: `auq:${state.shortId}:${index}:done`,
    }]);
  }

  const message: OutboundMessage = {
    address: state.address,
    text,
    parseMode: 'HTML',
    inlineButtons: buttons,
  };

  const result = await deliver(state.adapter, message);
  if (result.ok && result.messageId) {
    state.messageId = result.messageId;
  }
}

function advanceOrResolve(state: PendingQuestion): void {
  const nextIndex = state.currentIndex + 1;

  if (nextIndex < state.questions.length) {
    // Send next question
    sendQuestion(state, nextIndex).catch((err) => {
      console.error('[question-broker] Failed to send next question:', err);
    });
    return;
  }

  // All questions answered — resolve
  const { permissions } = getBridgeContext();
  permissions.resolvePendingPermission(state.toolUseID, {
    behavior: 'allow',
    updatedInput: {
      questions: state.questions,
      answers: state.answers,
    },
  });

  cleanup(state);
}

function updateMultiSelectButtons(state: PendingQuestion, questionIndex: number): void {
  const question = state.questions[questionIndex];
  const selected = state.multiSelectState.get(questionIndex) || new Set();

  const buttons: Array<Array<{ text: string; callbackData: string }>> = [];

  for (let i = 0; i < question.options.length; i++) {
    const isSelected = selected.has(i);
    buttons.push([{
      text: `${isSelected ? '✅ ' : ''}${question.options[i].label}`,
      callbackData: `auq:${state.shortId}:${questionIndex}:opt${i}`,
    }]);
  }

  buttons.push([{
    text: '💬 Chat about this',
    callbackData: `auq:${state.shortId}:${questionIndex}:chat`,
  }]);

  buttons.push([{
    text: '✅ Done',
    callbackData: `auq:${state.shortId}:${questionIndex}:done`,
  }]);

  // Edit existing message buttons
  if (state.messageId && state.adapter.editMessageButtons) {
    state.adapter.editMessageButtons(state.chatId, state.messageId, buttons).catch(() => {});
  }
}

function cleanup(state: PendingQuestion): void {
  shortIdToChat.delete(state.shortId);
  pendingQuestions.delete(state.chatId);
}
