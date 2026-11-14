'use strict';

/**
 * Explicit job state machine. Every persisted status change must be a legal
 * transition, so a job can never jump from FAILED straight to COMPLETED (R7)
 * and a COMPLETED job can never be modified again (R8).
 */
const TRANSITIONS = {
  DISCOVERED:        ['PENDING', 'SKIPPED'],
  PENDING:           ['PREPARING', 'SKIPPED'],
  PREPARING:         ['UPLOADING', 'FAILED', 'PAUSED'],
  UPLOADING:         ['UPLOADED', 'FAILED', 'PAUSED'],
  UPLOADED:          ['PROMPT_SUBMITTED', 'FAILED'],
  PROMPT_SUBMITTED:  ['GENERATING', 'FAILED'],
  GENERATING:        ['GENERATED', 'FAILED', 'PAUSED'],
  GENERATED:         ['DOWNLOADING', 'FAILED'],
  DOWNLOADING:       ['VERIFYING', 'FAILED'],
  VERIFYING:         ['COMPLETED', 'FAILED'],
  COMPLETED:         [],
  FAILED:            ['PENDING', 'SKIPPED'],
  SKIPPED:           ['PENDING'],
  PAUSED:            ['PENDING', 'SKIPPED']
};

function assertTransition(from, to) {
  if (!TRANSITIONS[from]) {
    throw new Error(`Unknown state: ${from}`);
  }
  if (!TRANSITIONS[from].includes(to)) {
    throw new Error(`Illegal transition: ${from} → ${to}`);
  }
}

function isTerminal(status) {
  return status === 'COMPLETED' || status === 'SKIPPED';
}

function isTransient(status) {
  return ['PREPARING', 'UPLOADING', 'UPLOADED', 'PROMPT_SUBMITTED', 'GENERATING',
    'GENERATED', 'DOWNLOADING', 'VERIFYING', 'PAUSED'].includes(status);
}

module.exports = { TRANSITIONS, assertTransition, isTerminal, isTransient };
