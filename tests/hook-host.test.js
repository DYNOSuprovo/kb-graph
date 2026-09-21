import './helpers/tmp-kb.js';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT } from '../src/process-ancestry.js';
import {
  HOOK_DECLINE_REASON,
  hookPayloadHost,
  validateHookHost,
} from '../src/hook-host.js';
import {
  SESSION_CAPTURE_LOG, SESSION_CAPTURE_QUEUE_DIR,
  enqueueSessionCapture,
} from '../src/session-capture.js';

const HOOK_HELPER = join(import.meta.dirname, 'helpers', 'run-hook.mjs');

function fixture(name) {
  const path = join(import.meta.dirname, 'fixtures', name);
  return JSON.parse(readFileSync(path, 'utf8'));
}

afterEach(() => {
  rmSync(SESSION_CAPTURE_QUEUE_DIR, { recursive: true, force: true });
  rmSync(SESSION_CAPTURE_LOG, { force: true });
});

test('detects versioned Cursor payloads by fields and event casing', () => {
  const input = fixture('posttool-cursor.json');
  assert.deepEqual(hookPayloadHost(input), { agent: AGENT.CURSOR, reason: null });
  assert.deepEqual(validateHookHost(input, AGENT.CURSOR), { ok: true, reason: null });
  assert.deepEqual(
    hookPayloadHost({ cursor_version: '3.21.16', hook_event_name: 'workspaceOpen' }),
    { agent: AGENT.CURSOR, reason: null },
  );
});

test('does not misclassify real Claude or Codex fixtures as Cursor', () => {
  assert.deepEqual(
    hookPayloadHost(fixture('posttool-claude.json')),
    { agent: null, reason: null },
  );
  assert.deepEqual(
    hookPayloadHost(fixture('posttool-codex.json')),
    { agent: AGENT.CODEX, reason: null },
  );
  assert.deepEqual(
    validateHookHost(fixture('posttool-claude.json'), AGENT.CLAUDE),
    { ok: true, reason: null },
  );
  assert.deepEqual(
    validateHookHost(fixture('posttool-codex.json'), AGENT.CODEX),
    { ok: true, reason: null },
  );
});

test('declines a definitive host mismatch with one bounded reason', () => {
  const input = fixture('posttool-cursor.json');
  assert.deepEqual(
    validateHookHost(input, AGENT.CLAUDE),
    { ok: false, reason: HOOK_DECLINE_REASON.HOST_MISMATCH },
  );
  const result = enqueueSessionCapture({
    hookInput: input,
    agent: AGENT.CLAUDE,
    reason: 'activity',
  });
  assert.deepEqual(result, {
    output: null,
    plan: null,
    queued: false,
    reason: HOOK_DECLINE_REASON.HOST_MISMATCH,
  });
  assert.equal(existsSync(SESSION_CAPTURE_QUEUE_DIR), false);
  assert.equal(existsSync(SESSION_CAPTURE_LOG), false);
});

test('wakeup declines imported Cursor payloads before briefing or attribution', () => {
  const stdout = execFileSync(process.execPath, [HOOK_HELPER, 'wakeup-hook'], {
    input: JSON.stringify({
      cursor_version: '3.21.16',
      conversation_id: 'cursor-conversation-fixture',
      hook_event_name: 'sessionStart',
    }),
    env: process.env,
    encoding: 'utf8',
  });
  assert.equal(stdout, '');
});

test('declines malformed Cursor contracts without echoing payload fields', () => {
  const malformed = [
    { cursor_version: 'future', conversation_id: 'private-id', hook_event_name: 'stop' },
    { conversation_id: 'private-id', hook_event_name: 'stop' },
    { cursor_version: '3.21.16', conversation_id: 'private-id', hook_event_name: 'Stop' },
  ];
  for (const input of malformed) {
    assert.deepEqual(validateHookHost(input, AGENT.CURSOR), {
      ok: false,
      reason: HOOK_DECLINE_REASON.UNSUPPORTED_PAYLOAD,
    });
  }
});

test('preserves legacy payloads that do not carry a definitive host signature', () => {
  const input = { session_id: 'legacy', hook_event_name: 'SessionStart' };
  assert.deepEqual(hookPayloadHost(input), { agent: null, reason: null });
  assert.deepEqual(validateHookHost(input, AGENT.CLAUDE), { ok: true, reason: null });
  assert.deepEqual(validateHookHost(input, AGENT.CODEX), { ok: true, reason: null });
  assert.deepEqual(
    hookPayloadHost({ thread_id: 'thread', turn_id: 'turn', hook_event_name: 'postToolUse' }),
    { agent: null, reason: null },
  );
});

test('session capture help lists Cursor as a supported agent flag', () => {
  const result = spawnSync(
    process.execPath,
    [HOOK_HELPER, 'session-capture-hook', '--agent', 'unsupported'],
    { input: '{}', env: process.env, encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage: kb session-capture-hook \[--agent <claude\|codex\|cursor>\]/);
});
