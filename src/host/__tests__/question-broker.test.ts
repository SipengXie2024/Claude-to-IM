/**
 * Unit tests for bridge question-broker (AskUserQuestion).
 *
 * Tests cover:
 * - forwardAskUserQuestion: sends question messages with buttons
 * - handleQuestionCallback: single-select, multi-select toggle, done, chat
 * - handleFreeTextAnswer: chat deny
 * - hasPendingQuestion: state tracking
 * - Edge cases: superseded questions, empty multi-select, wrong chatId
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { initBridgeContext } from '../../lib/bridge/context.js';
import {
  forwardAskUserQuestion,
  handleQuestionCallback,
  handleFreeTextAnswer,
  hasPendingQuestion,
} from '../../lib/bridge/question-broker.js';
import type { PermissionResolution } from '../../lib/bridge/host.js';
import type { OutboundMessage, SendResult } from '../../lib/bridge/types.js';

// ── Shared test state ────────────────────────────────────────

interface ResolvedEntry { id: string; resolution: PermissionResolution }

const resolved: ResolvedEntry[] = [];
const sent: OutboundMessage[] = [];
const editedButtons: Array<{ chatId: string; messageId: string; buttons: unknown[][] }> = [];
let messageCounter = 100;

// Initialize context once at module scope
delete (globalThis as Record<string, unknown>)['__bridge_context__'];
initBridgeContext({
  store: {
    getSetting: () => null, checkDedup: () => false, insertDedup: () => {},
    cleanupExpiredDedup: () => {}, insertAuditLog: () => {}, insertOutboundRef: () => {},
    getChannelOffset: () => '0', setChannelOffset: () => {},
    getChannelBinding: () => null, upsertChannelBinding: () => ({}) as any,
    updateChannelBinding: () => {}, listChannelBindings: () => [],
    getSession: () => null,
    createSession: () => ({ id: '1', working_directory: '', model: '' }),
    updateSessionProviderId: () => {}, addMessage: () => {},
    getMessages: () => ({ messages: [] }), acquireSessionLock: () => true,
    renewSessionLock: () => {}, releaseSessionLock: () => {},
    setSessionRuntimeStatus: () => {}, updateSdkSessionId: () => {},
    updateSessionModel: () => {}, syncSdkTasks: () => {},
    getProvider: () => undefined, getDefaultProviderId: () => null,
    insertPermissionLink: () => {}, getPermissionLink: () => null,
    markPermissionLinkResolved: () => false,
  } as any,
  llm: { streamChat: () => new ReadableStream() },
  permissions: {
    resolvePendingPermission(id: string, resolution: PermissionResolution) {
      resolved.push({ id, resolution });
      return true;
    },
  },
  lifecycle: {},
});

const adapter = {
  channelType: 'telegram',
  send: async (msg: OutboundMessage): Promise<SendResult> => {
    sent.push(msg);
    return { ok: true, messageId: String(++messageCounter) };
  },
  editMessageButtons: async (
    chatId: string,
    messageId: string,
    buttons: unknown[][],
  ) => {
    editedButtons.push({ chatId, messageId, buttons });
  },
} as any;

function reset() {
  resolved.length = 0;
  sent.length = 0;
  editedButtons.length = 0;
}

function getShortId(): string {
  return sent[0].inlineButtons![0][0].callbackData.split(':')[1];
}

// Each test uses a unique chatId to avoid cross-test state leakage
// from the module-level Maps in question-broker.

// ── Tests ────────────────────────────────────────────────────

describe('question-broker', () => {

  describe('forwardAskUserQuestion', () => {
    it('sends single-select question with correct buttons', async () => {
      reset();
      await forwardAskUserQuestion(adapter, { channelType: 'telegram', chatId: 'c1' }, {
        toolUseID: 'fwd-1',
        questions: [{
          question: 'Pick a color',
          header: 'Color Choice',
          options: [
            { label: 'Red', description: 'A warm color' },
            { label: 'Blue' },
          ],
        }],
      });

      assert.equal(sent.length, 1);
      assert.ok(sent[0].text.includes('Color Choice'));
      assert.ok(sent[0].text.includes('Pick a color'));
      // 2 options + Chat = 3 rows
      assert.equal(sent[0].inlineButtons!.length, 3);
      assert.ok(sent[0].inlineButtons![0][0].text.includes('Red'));
      assert.ok(sent[0].inlineButtons![0][0].callbackData.startsWith('auq:'));
      // Clean up by resolving
      handleQuestionCallback(adapter, `auq:${getShortId()}:0:opt0`, 'c1');
    });

    it('sends multi-select question with Done button', async () => {
      reset();
      await forwardAskUserQuestion(adapter, { channelType: 'telegram', chatId: 'c2' }, {
        toolUseID: 'fwd-2',
        questions: [{
          question: 'Pick languages',
          multiSelect: true,
          options: [{ label: 'TypeScript' }, { label: 'Rust' }],
        }],
      });

      // 2 options + Chat + Done = 4 rows
      assert.equal(sent[0].inlineButtons!.length, 4);
      assert.ok(sent[0].inlineButtons![3][0].text.includes('Done'));
      // Clean up
      handleQuestionCallback(adapter, `auq:${getShortId()}:0:opt0`, 'c2', '101');
      handleQuestionCallback(adapter, `auq:${getShortId()}:0:done`, 'c2');
    });
  });

  describe('single select', () => {
    it('records answer and resolves', async () => {
      reset();
      await forwardAskUserQuestion(adapter, { channelType: 'telegram', chatId: 'c3' }, {
        toolUseID: 'ss-1',
        questions: [{
          question: 'Pick a color',
          options: [{ label: 'Red' }, { label: 'Blue' }],
        }],
      });

      const shortId = getShortId();
      const handled = handleQuestionCallback(adapter, `auq:${shortId}:0:opt1`, 'c3');

      assert.ok(handled);
      assert.equal(resolved.length, 1);
      assert.equal(resolved[0].resolution.behavior, 'allow');
      assert.equal((resolved[0].resolution as any).updatedInput.answers['Pick a color'], 'Blue');
    });
  });

  describe('multi select', () => {
    it('toggles selection and resolves on done', async () => {
      reset();
      await forwardAskUserQuestion(adapter, { channelType: 'telegram', chatId: 'c4' }, {
        toolUseID: 'ms-1',
        questions: [{
          question: 'Pick languages',
          multiSelect: true,
          options: [{ label: 'TypeScript' }, { label: 'Rust' }, { label: 'Go' }],
        }],
      });

      const shortId = getShortId();

      handleQuestionCallback(adapter, `auq:${shortId}:0:opt0`, 'c4', '101');
      assert.equal(editedButtons.length, 1);

      handleQuestionCallback(adapter, `auq:${shortId}:0:opt2`, 'c4', '101');
      assert.equal(editedButtons.length, 2);

      handleQuestionCallback(adapter, `auq:${shortId}:0:done`, 'c4');

      assert.equal(resolved.length, 1);
      assert.equal((resolved[0].resolution as any).updatedInput.answers['Pick languages'], 'TypeScript, Go');
    });

    it('rejects empty multi-select done', async () => {
      reset();
      await forwardAskUserQuestion(adapter, { channelType: 'telegram', chatId: 'c5' }, {
        toolUseID: 'ms-2',
        questions: [{
          question: 'Pick languages',
          multiSelect: true,
          options: [{ label: 'TypeScript' }],
        }],
      });

      const shortId = getShortId();
      handleQuestionCallback(adapter, `auq:${shortId}:0:done`, 'c5');

      // Should NOT resolve — sends a hint instead
      assert.equal(resolved.length, 0);
      // Wait for async deliver of hint message
      await new Promise(r => setTimeout(r, 50));
      assert.ok(sent.length >= 2, `Expected >=2 sent messages, got ${sent.length}`);

      // Clean up: select and submit so the pending question is resolved
      handleQuestionCallback(adapter, `auq:${shortId}:0:opt0`, 'c5', '101');
      handleQuestionCallback(adapter, `auq:${shortId}:0:done`, 'c5');
    });
  });

  describe('other action removed', () => {
    it('returns false for other callback', async () => {
      reset();
      await forwardAskUserQuestion(adapter, { channelType: 'telegram', chatId: 'c6' }, {
        toolUseID: 'other-1',
        questions: [{
          question: 'Pick a color',
          options: [{ label: 'Red' }],
        }],
      });

      const shortId = getShortId();
      // 'other' action should not be handled anymore
      assert.equal(handleQuestionCallback(adapter, `auq:${shortId}:0:other`, 'c6'), false);
      assert.equal(resolved.length, 0);

      // Clean up
      handleQuestionCallback(adapter, `auq:${shortId}:0:opt0`, 'c6');
    });
  });

  describe('chat about this', () => {
    it('resolves as deny with user feedback', async () => {
      reset();
      await forwardAskUserQuestion(adapter, { channelType: 'telegram', chatId: 'c7' }, {
        toolUseID: 'chat-1',
        questions: [{
          question: 'Pick a color',
          options: [{ label: 'Red' }],
        }],
      });

      const shortId = getShortId();
      handleQuestionCallback(adapter, `auq:${shortId}:0:chat`, 'c7');
      assert.ok(hasPendingQuestion('c7'));

      handleFreeTextAnswer(adapter, 'c7', 'I want more options');

      assert.equal(resolved.length, 1);
      assert.equal(resolved[0].resolution.behavior, 'deny');
      assert.equal(resolved[0].resolution.message, 'I want more options');
    });
  });

  describe('multi-question flow', () => {
    it('advances through multiple questions', async () => {
      reset();
      await forwardAskUserQuestion(adapter, { channelType: 'telegram', chatId: 'c8' }, {
        toolUseID: 'mq-1',
        questions: [
          { question: 'Pick a color', options: [{ label: 'Red' }, { label: 'Blue' }] },
          { question: 'Pick a size', options: [{ label: 'Small' }, { label: 'Large' }] },
        ],
      });

      assert.equal(sent.length, 1);
      const shortId = getShortId();

      // Answer first question
      handleQuestionCallback(adapter, `auq:${shortId}:0:opt0`, 'c8');
      // Wait for async sendQuestion
      await new Promise(r => setTimeout(r, 50));
      assert.equal(sent.length, 2);

      // Answer second question
      handleQuestionCallback(adapter, `auq:${shortId}:1:opt1`, 'c8');

      assert.equal(resolved.length, 1);
      const answers = (resolved[0].resolution as any).updatedInput.answers;
      assert.equal(answers['Pick a color'], 'Red');
      assert.equal(answers['Pick a size'], 'Large');
    });
  });

  describe('hasPendingQuestion', () => {
    it('returns false when no question pending', () => {
      assert.equal(hasPendingQuestion('no-such-chat'), false);
    });

    it('returns true only when awaitingFreeText', async () => {
      reset();
      await forwardAskUserQuestion(adapter, { channelType: 'telegram', chatId: 'c9' }, {
        toolUseID: 'hpq-1',
        questions: [{ question: 'Q', options: [{ label: 'A' }] }],
      });

      assert.equal(hasPendingQuestion('c9'), false);

      const shortId = getShortId();
      handleQuestionCallback(adapter, `auq:${shortId}:0:chat`, 'c9');
      assert.equal(hasPendingQuestion('c9'), true);

      // Clean up
      handleFreeTextAnswer(adapter, 'c9', 'feedback');
    });
  });

  describe('edge cases', () => {
    it('returns false for wrong chatId', async () => {
      reset();
      await forwardAskUserQuestion(adapter, { channelType: 'telegram', chatId: 'c10' }, {
        toolUseID: 'edge-1',
        questions: [{ question: 'Q', options: [{ label: 'A' }] }],
      });

      const shortId = getShortId();
      assert.equal(handleQuestionCallback(adapter, `auq:${shortId}:0:opt0`, 'wrong-chat'), false);
      // Clean up
      handleQuestionCallback(adapter, `auq:${shortId}:0:opt0`, 'c10');
    });

    it('returns false for unknown shortId', () => {
      assert.equal(handleQuestionCallback(adapter, 'auq:xxxxxx:0:opt0', 'c11'), false);
    });

    it('superseding question denies the previous one', async () => {
      reset();
      await forwardAskUserQuestion(adapter, { channelType: 'telegram', chatId: 'c12' }, {
        toolUseID: 'sup-1',
        questions: [{ question: 'Q1', options: [{ label: 'A' }] }],
      });

      await forwardAskUserQuestion(adapter, { channelType: 'telegram', chatId: 'c12' }, {
        toolUseID: 'sup-2',
        questions: [{ question: 'Q2', options: [{ label: 'B' }] }],
      });

      assert.equal(resolved.length, 1);
      assert.equal(resolved[0].id, 'sup-1');
      assert.equal(resolved[0].resolution.behavior, 'deny');

      // Clean up the second one
      const shortId = sent[sent.length - 1].inlineButtons![0][0].callbackData.split(':')[1];
      handleQuestionCallback(adapter, `auq:${shortId}:0:opt0`, 'c12');
    });
  });
});
