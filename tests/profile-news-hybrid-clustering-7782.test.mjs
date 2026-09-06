import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FRAME_BUDGET_MS,
  LONG_TASK_MS,
  isGateCase,
  summarize,
} from '../scripts/profile-news-hybrid-clustering-7782.mjs';

describe('hybrid clustering measurement gate (#7782)', () => {
  it('does not treat the pathological shared-token case as a go signal', () => {
    assert.equal(isGateCase('representative-digest'), true);
    assert.equal(isGateCase('high-diversity-1500'), true);
    assert.equal(isGateCase('high-diversity-1000'), true);
    assert.equal(isGateCase('shared-token-stress-1500'), false);
  });

  it('uses frame and long-task budgets from the issue', () => {
    assert.equal(FRAME_BUDGET_MS, 16.7);
    assert.equal(LONG_TASK_MS, 50);
  });

  it('summarizes an odd sample set without claiming a frame miss under 16.7ms', () => {
    const stats = summarize([14.5, 14.1, 16.0, 13.2, 14.7, 15.1, 14.4, 14.8, 15.0]);
    assert.equal(stats.n, 9);
    assert.ok(stats.median < FRAME_BUDGET_MS);
    assert.ok(stats.max < LONG_TASK_MS);
  });
});
