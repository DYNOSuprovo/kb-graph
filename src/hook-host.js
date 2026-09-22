import { AGENT } from './process-ancestry.js';

export const HOOK_DECLINE_REASON = Object.freeze({
  HOST_MISMATCH: 'host_mismatch',
  UNSUPPORTED_PAYLOAD: 'unsupported_payload',
});

const CURSOR_EVENTS = new Set([
  'afterAgentResponse',
  'afterAgentThought',
  'afterFileEdit',
  'afterMCPExecution',
  'afterShellExecution',
  'afterTabFileEdit',
  'beforeMCPExecution',
  'beforeReadFile',
  'beforeShellExecution',
  'beforeSubmitPrompt',
  'beforeTabFileRead',
  'postToolUse',
  'postToolUseFailure',
  'preCompact',
  'preToolUse',
  'sessionEnd',
  'sessionStart',
  'stop',
  'subagentStart',
  'subagentStop',
  'workspaceOpen',
]);

const PASCAL_EVENT = /^[A-Z][A-Za-z]+$/;
const CURSOR_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function hasCursorSignature(hookInput) {
  return Object.hasOwn(hookInput, 'cursor_version')
    || Object.hasOwn(hookInput, 'conversation_id');
}

function isSupportedCursorPayload(hookInput, event) {
  return typeof hookInput.cursor_version === 'string'
    && CURSOR_VERSION.test(hookInput.cursor_version)
    && CURSOR_EVENTS.has(event);
}

export function hookPayloadHost(hookInput = {}) {
  const input = hookInput && typeof hookInput === 'object' ? hookInput : {};
  const event = input.hook_event_name;
  if (hasCursorSignature(input)) {
    if (!isSupportedCursorPayload(input, event)) {
      return { agent: null, reason: HOOK_DECLINE_REASON.UNSUPPORTED_PAYLOAD };
    }
    return { agent: AGENT.CURSOR, reason: null };
  }

  if (typeof event !== 'string' || !PASCAL_EVENT.test(event)) {
    return { agent: null, reason: null };
  }
  if (
    typeof input.thread_id === 'string'
    && typeof input.turn_id === 'string'
  ) return { agent: AGENT.CODEX, reason: null };
  return { agent: null, reason: null };
}

export function validateHookHost(hookInput, configuredAgent) {
  const detected = hookPayloadHost(hookInput);
  if (detected.reason) return { ok: false, reason: detected.reason };
  if (detected.agent && detected.agent !== configuredAgent) {
    return { ok: false, reason: HOOK_DECLINE_REASON.HOST_MISMATCH };
  }
  return { ok: true, reason: null };
}
