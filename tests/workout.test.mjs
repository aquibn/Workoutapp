import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorkoutSession,
  startSession,
  startInterval,
  completeActiveInterval,
  skipActiveInterval,
  endSession,
  applyAdaptation,
  calculateRemainingSeconds,
  getRecapSummary,
  validateWorkoutSession,
  DEFAULT_PLANNED_SECONDS,
} from '../dist/shared/workout/session.js';
import { renderWorkoutProgram, extractProposal } from '../dist/shared/workout/openui-bridge.js';
import { mockTurn, parseTargetSeconds } from '../dist/server/mock.js';
import { createApp, readConfig } from '../dist/server/app.js';
import { parseWorkoutSnapshot, recordEffort, slotAwaitingEffort, suggest, dismissSuggestion } from '../dist/shared/workout/session.js';
import { extractSuggestion } from '../dist/shared/workout/openui-bridge.js';
import { validateProgram } from '../dist/shared/openui/validate.js';
import { OPENUI_LIBRARY } from '../dist/shared/openui/openui-library.js';

test('default workout session is exactly 720 planned seconds across opening, 8 slots and finish', () => {
  const session = createWorkoutSession();
  assert.equal(session.profile, 'steady');
  assert.equal(session.stage, 'welcome');
  assert.equal(session.revision, 1);

  // 1 opening + 8 * 2 (work+rest) + 1 finish = 18 intervals
  assert.equal(session.intervals.length, 18);
  assert.equal(session.intervals[0].kind, 'opening');
  assert.equal(session.intervals[0].durationSeconds, 120);

  assert.equal(session.intervals[1].activityLabel, 'Tempo squat');
  assert.equal(session.intervals[1].durationSeconds, 40);
  assert.equal(session.intervals[2].kind, 'recovery');
  assert.equal(session.intervals[2].durationSeconds, 20);

  assert.equal(session.intervals[3].activityLabel, 'Standing reach');
  assert.equal(session.intervals[3].durationSeconds, 40);

  assert.equal(session.intervals.at(-1).kind, 'finish');
  assert.equal(session.intervals.at(-1).durationSeconds, 120);

  const total = calculateRemainingSeconds(session);
  assert.equal(total, DEFAULT_PLANNED_SECONDS);
  assert.equal(total, 720);
});

test('interval lifecycle: start, complete, and skip advance revision and record status', () => {
  let session = createWorkoutSession();
  session = startSession(session);
  assert.equal(session.stage, 'preview');
  assert.equal(session.revision, 2);

  session = startInterval(session, 'opening');
  assert.equal(session.stage, 'active');
  assert.equal(session.activeIntervalId, 'opening');
  assert.equal(session.intervals[0].status, 'active');
  assert.equal(session.revision, 3);

  session = completeActiveInterval(session);
  assert.equal(session.activeIntervalId, null);
  assert.equal(session.intervals[0].status, 'completed');
  assert.equal(session.stage, 'checkin');
  assert.equal(session.revision, 4);

  session = startInterval(session, 'slot-1-work');
  assert.equal(session.activeIntervalId, 'slot-1-work');

  // Skipping a work slot still runs its recovery
  session = skipActiveInterval(session);
  assert.equal(session.intervals[1].status, 'skipped');
  assert.equal(session.activeIntervalId, 'slot-1-rest');
  assert.equal(session.stage, 'active');
});

test('adaptation "ease" changes pending slots to 25s/35s without altering completed history', () => {
  let session = createWorkoutSession();
  session = startInterval(session, 'opening');
  session = completeActiveInterval(session);

  assert.equal(session.intervals[0].status, 'completed');
  assert.equal(session.intervals[0].durationSeconds, 120);

  const result = applyAdaptation(session, { intent: 'ease', revision: session.revision });
  assert.equal(result.applied, true);
  session = result.session;

  assert.equal(session.intervals[1].durationSeconds, 25);
  assert.equal(session.intervals[2].durationSeconds, 35);

  assert.equal(session.intervals[1].durationSeconds + session.intervals[2].durationSeconds, 60);

  // Ease is idempotent
  const secondEase = applyAdaptation(session, { intent: 'ease', revision: session.revision });
  assert.equal(secondEase.applied, false);
});

test('ease modifies only wholly pending slot pairs and protects active slot recovery', () => {
  let session = createWorkoutSession();
  session = startInterval(session, 'opening');
  session = completeActiveInterval(session);
  session = startInterval(session, 'slot-1-work');
  assert.equal(session.activeIntervalId, 'slot-1-work');

  const result = applyAdaptation(session, { intent: 'ease', revision: session.revision }, 10);
  assert.equal(result.applied, true);

  // Slot 1 work (active) and slot 1 rest (pending) should NOT be modified because slot 1 is partially consumed
  assert.equal(result.session.intervals[1].durationSeconds, 40);
  assert.equal(result.session.intervals[2].durationSeconds, 20);

  assert.equal(result.session.intervals[3].durationSeconds, 25);
  assert.equal(result.session.intervals[4].durationSeconds, 35);
});

test('adaptation "shorten" trims upcoming slots to fit target limit while protecting active and finish', () => {
  let session = createWorkoutSession();
  session = startInterval(session, 'opening');
  session = completeActiveInterval(session);

  session = applyAdaptation(session, { intent: 'ease', revision: session.revision }).session;

  const result = applyAdaptation(session, { intent: 'shorten', seconds: 300, revision: session.revision });
  assert.equal(result.applied, true);
  session = result.session;

  const remaining = calculateRemainingSeconds(session);
  assert.equal(remaining, 300);

  const removed = session.intervals.filter(i => i.status === 'removed');
  assert(removed.length > 0);

  const finish = session.intervals.find(i => i.id === 'finish');
  assert.equal(finish.status, 'pending');
  assert(finish.durationSeconds >= 30);
});

test('shorten rejects impossible target budgets without corrupting state', () => {
  let session = createWorkoutSession();
  session = startInterval(session, 'opening'); // 120s active

  // Target 30s is impossible when 120s opening is active and protected
  const impossible = applyAdaptation(session, { intent: 'shorten', seconds: 30, revision: session.revision }, 120);
  assert.equal(impossible.applied, false);
  assert.match(impossible.summary, /Cannot shorten to 30s/);
  assert.equal(session.intervals.filter(i => i.status === 'removed').length, 0);

  const impossible60 = applyAdaptation(session, { intent: 'shorten', seconds: 60, revision: session.revision }, 120);
  assert.equal(impossible60.applied, false);

  const invalidNegative = applyAdaptation(session, { intent: 'shorten', seconds: -5, revision: session.revision });
  assert.equal(invalidNegative.applied, false);
});

test('proposal extraction rejects unfenced prose, malformed values, duplicate proposals, and extra seconds', () => {
  const proseReply = 'Here is an example: proposal = Proposal("ease")\nHave a good workout!';
  assert.equal(extractProposal(proseReply, 1), null);

  const negativeReply = '```openui\nproposal1 = Proposal("shorten", -5)\n```';
  assert.equal(extractProposal(negativeReply, 1), null);

  const fractionalReply = '```openui\nproposal1 = Proposal("shorten", 0.5)\n```';
  assert.equal(extractProposal(fractionalReply, 1), null);

  const easeWithSeconds = '```openui\nproposal1 = Proposal("ease", 100)\n```';
  assert.equal(extractProposal(easeWithSeconds, 1), null);

  const duplicateReply = '```openui\nproposal1 = Proposal("ease")\nproposal2 = Proposal("shorten", 300)\n```';
  assert.equal(extractProposal(duplicateReply, 1), null);

  const validReply = '```openui\nproposal1 = Proposal("ease")\n```';
  assert.deepEqual(extractProposal(validReply, 3, 'session-42'), {
    intent: 'ease',
    seconds: undefined,
    revision: 3,
    sessionId: 'session-42',
  });
});

test('stale revision and mismatched session ID are rejected by applyAdaptation', () => {
  const session = createWorkoutSession('steady', 'session-100');
  assert.equal(session.revision, 1);

  const staleRev = applyAdaptation(session, { intent: 'ease', revision: 5, sessionId: 'session-100' });
  assert.equal(staleRev.applied, false);
  assert.match(staleRev.summary, /Stale/);

  const staleId = applyAdaptation(session, { intent: 'ease', revision: 1, sessionId: 'session-999' });
  assert.equal(staleId.applied, false);
  assert.match(staleId.summary, /Stale/);
});

test('validateWorkoutSession decodes valid sessions and rejects malformed snapshots', () => {
  const valid = createWorkoutSession();
  assert.notEqual(validateWorkoutSession(valid), null);

  assert.equal(validateWorkoutSession(null), null);
  assert.equal(validateWorkoutSession('string'), null);

  assert.equal(validateWorkoutSession({ ...valid, intervals: [] }), null);

  const twoActive = {
    ...valid,
    intervals: valid.intervals.map((item, idx) => idx < 2 ? { ...item, status: 'active' } : item),
    activeIntervalId: 'opening',
  };
  assert.equal(validateWorkoutSession(twoActive), null);

  const mismatchActive = { ...valid, activeIntervalId: 'nonexistent' };
  assert.equal(validateWorkoutSession(mismatchActive), null);
});

test('ended session enforces terminal state and rejects further interval start or adaptations', () => {
  let session = createWorkoutSession();
  session = startInterval(session, 'opening');
  session = endSession(session);
  assert.equal(session.stage, 'recap');
  assert.equal(session.activeIntervalId, null);

  const postEndStart = startInterval(session, 'slot-1-work');
  assert.equal(postEndStart.stage, 'recap');
  assert.equal(postEndStart.activeIntervalId, null);

  const postEndAdapt = applyAdaptation(session, { intent: 'ease', revision: session.revision });
  assert.equal(postEndAdapt.applied, false);
  assert.match(postEndAdapt.summary, /already ended/);
});

test('startInterval guards against multiple concurrent active intervals', () => {
  let session = createWorkoutSession();
  session = startInterval(session, 'opening');
  assert.equal(session.activeIntervalId, 'opening');

  const second = startInterval(session, 'slot-1-work');
  assert.equal(second.activeIntervalId, 'opening');
  assert.equal(second.intervals.filter(i => i.status === 'active').length, 1);
});

test('recap summary reconciles completed, skipped and removed counts accurately', () => {
  let session = createWorkoutSession();
  session = startInterval(session, 'opening');
  session = completeActiveInterval(session); // 1 completed (120s)

  session = startInterval(session, 'slot-1-work');
  session = skipActiveInterval(session); // 1 skipped

  session = applyAdaptation(session, { intent: 'shorten', seconds: 300, revision: session.revision }).session;

  const recap = getRecapSummary(session);
  assert.equal(recap.completedCount, 1);
  assert.equal(recap.simulatedSecondsCompleted, 120);
  assert.equal(recap.skippedCount, 1);
  assert(recap.removedCount > 0);
  assert.equal(recap.totalPlannedSeconds, 720);
});

test('openui bridge generates valid programs for all stages and extracts proposals', () => {
  let session = createWorkoutSession();

  const welcome = renderWorkoutProgram(session);
  assert.doesNotThrow(() => validateProgram(welcome, OPENUI_LIBRARY));

  session = startSession(session);
  const preview = renderWorkoutProgram(session);
  assert.doesNotThrow(() => validateProgram(preview, OPENUI_LIBRARY));

  session = startInterval(session, 'opening');
  const active = renderWorkoutProgram(session);
  assert.doesNotThrow(() => validateProgram(active, OPENUI_LIBRARY));

  session = completeActiveInterval(session);
  const checkin = renderWorkoutProgram(session);
  assert.doesNotThrow(() => validateProgram(checkin, OPENUI_LIBRARY));

  const replyWithEase = 'We will ease the pace.\n```openui\nproposal1 = Proposal("ease")\n```';
  const proposal = extractProposal(replyWithEase, 1);
  assert.deepEqual(proposal, { intent: 'ease', seconds: undefined, revision: 1 });

  const replyWithShorten = 'Shortening to 5 minutes.\n```openui\nproposal1 = Proposal("shorten", 300)\n```';
  const proposalShorten = extractProposal(replyWithShorten, 2);
  assert.deepEqual(proposalShorten, { intent: 'shorten', seconds: 300, revision: 2 });
});

test('finishing a work slot starts its recovery, then hands back at a check-in', () => {
  let session = startInterval(startSession(createWorkoutSession()), 'opening');
  session = completeActiveInterval(session);
  assert.equal(session.stage, 'checkin');

  session = startInterval(session, 'slot-1-work');
  session = completeActiveInterval(session);
  assert.equal(session.stage, 'active');
  assert.equal(session.activeIntervalId, 'slot-1-rest');
  assert.equal(session.intervals.find(i => i.id === 'slot-1-rest').status, 'active');

  session = completeActiveInterval(session);
  assert.equal(session.stage, 'checkin');
  assert.equal(session.activeIntervalId, null);
});

test('the on-screen actions alone reach the recap, and every active screen has an active interval', () => {
  let session = startSession(createWorkoutSession());
  let steps = 0;
  while (session.stage !== 'recap' && steps++ < 100) {
    if (session.stage === 'active') {
      assert.ok(session.activeIntervalId, 'active stage must have an active interval');
      session = completeActiveInterval(session); // the timer's "Simulate finish"
    } else {
      session = startInterval(session); // "Start opening" / "Continue next slot"
    }
  }
  assert.equal(session.stage, 'recap');
  assert.equal(session.completionMode, 'completed');
  assert.equal(getRecapSummary(session).completedCount, 18);
});

test('recap list items are serialized safely', () => {
  let session = startInterval(startSession(createWorkoutSession()), 'opening');
  session = completeActiveInterval(session);
  session = applyAdaptation(session, { intent: 'ease', revision: session.revision }).session;
  session = endSession(session);
  const program = renderWorkoutProgram(session);
  assert.match(program, /adaptItem0 = ListItem\("Activity 40 → 25 seconds\. Recovery 20 → 35 seconds\.", "bullet"\)/);
  assert.doesNotThrow(() => validateProgram(program, OPENUI_LIBRARY));
});

test('mock parses time targets and asks when a shorten request has none', () => {
  assert.equal(parseTargetSeconds('i have 5 minutes left'), 300);
  assert.equal(parseTargetSeconds('only have three min'), 180);
  assert.equal(parseTargetSeconds('shorten to 90s'), 90);
  assert.equal(parseTargetSeconds('shorten it'), null);
  assert.equal(parseTargetSeconds('9999 minutes'), null);

  const started = startSession(createWorkoutSession());
  const turn = text => mockTurn({ messages: [{ role: 'user', content: text }], state: { ui_state: '', client_events: [], workout: JSON.stringify(started) } }, '');

  const ask = turn('Can you shorten it?');
  assert.match(ask.reply, /How many minutes/);
  assert.equal(extractProposal(ask.reply, started.revision), null);

  const four = turn('I only have 4 minutes left');
  assert.deepEqual(extractProposal(four.reply, started.revision), { intent: 'shorten', seconds: 240, revision: started.revision });

  const keep = turn('This feels good, keep going');
  assert.equal(extractProposal(keep.reply, started.revision).intent, 'keep');
});

test('mock ease reply does not claim a change that was not applied', () => {
  const eased = applyAdaptation(startSession(createWorkoutSession()), { intent: 'ease', revision: 2 }).session;
  const ask = events => mockTurn({ messages: [{ role: 'user', content: 'make it easier' }], state: { ui_state: '', client_events: events, workout: JSON.stringify(eased) } }, '').reply;
  // Acknowledged only when the button's change is reported in this turn's events.
  assert.match(ask(['Adaptation applied: Activity 40 → 25 seconds. Recovery 20 → 35 seconds.']), /^Upcoming slots now have more breathing room\./);
  assert.match(ask([]), /^No change needed\./);

  const finished = endSession(startSession(createWorkoutSession()));
  const ended = mockTurn({ messages: [{ role: 'user', content: 'make it easier' }], state: { ui_state: '', client_events: [], workout: JSON.stringify(finished) } }, '');
  assert.match(ended.reply, /^No change needed\. Session has already ended\./);
});

test('active heading counts only the slots still in the plan', () => {
  let session = startInterval(startSession(createWorkoutSession()), 'opening');
  session = completeActiveInterval(session);
  assert.match(renderWorkoutProgram(startInterval(session, 'slot-1-work')), /Main slot 1 of 8 · Work/);
  session = applyAdaptation(session, { intent: 'shorten', seconds: 240, revision: session.revision }).session;
  const remaining = session.intervals.filter(i => i.kind === 'activity' && i.status === 'pending').length;
  assert.match(renderWorkoutProgram(startInterval(session, 'slot-1-work')), new RegExp(`Main slot 1 of ${remaining} · Work`));
});

test('recap counts are pluralised and active cues describe the simulation without instructing movement', () => {
  let session = startInterval(startSession(createWorkoutSession()), 'opening');
  assert.match(renderWorkoutProgram(session), /Simulated warm-up in progress/);
  session = completeActiveInterval(session);
  session = startInterval(session, 'slot-1-work');
  const active = renderWorkoutProgram(session);
  assert.match(active, /Simulated work slot in progress/);
  assert.doesNotMatch(active, /Maintain/);
  const recap = renderWorkoutProgram(endSession(session));
  assert.match(recap, /"1 interval completed \(2:00 simulated\)"/);
  assert.match(recap, /"1 interval skipped"/);
});

test('preview shows the finish as trimmed by shorten, not the default 120s', () => {
  const preview = startSession(createWorkoutSession());
  const { session, applied } = applyAdaptation(preview, { intent: 'shorten', seconds: 200, revision: preview.revision });
  assert.equal(applied, true);
  const program = renderWorkoutProgram(session);
  assert.match(program, /Finish & cool-down \(80s\)/);
  assert.match(program, /0 main slots/);
  assert.doesNotThrow(() => validateProgram(program, OPENUI_LIBRARY));
});

test('shorten treats the target as an upper bound when shortening twice', () => {
  let session = completeActiveInterval(startInterval(startSession(createWorkoutSession()), 'opening'));
  session = applyAdaptation(session, { intent: 'shorten', seconds: 250, revision: session.revision }).session;
  assert.equal(calculateRemainingSeconds(session), 250);
  const second = applyAdaptation(session, { intent: 'shorten', seconds: 200, revision: session.revision });
  assert.equal(second.applied, true);
  assert.ok(calculateRemainingSeconds(second.session) <= 200);
  assert.equal(second.session.intervals[0].status, 'completed');
  assert.ok(second.session.intervals.at(-1).durationSeconds >= 30);

  const fresh = startSession(createWorkoutSession());
  const canonical = applyAdaptation(fresh, { intent: 'shorten', seconds: 300, revision: fresh.revision });
  assert.equal(calculateRemainingSeconds(canonical.session), 300);
});

test('a rejected shorten is not answered with an earlier success', () => {
  let session = completeActiveInterval(startInterval(startSession(createWorkoutSession()), 'opening'));
  session = applyAdaptation(session, { intent: 'shorten', seconds: 250, revision: session.revision }).session;
  const reply = mockTurn({ messages: [{ role: 'user', content: 'i have 10 seconds left' }], state: { ui_state: '', client_events: [], workout: JSON.stringify(session) } }, '').reply;
  assert.match(reply, /^The plan stays as it is\. Cannot shorten to 10s/);
});

test('mock describes the state it is given instead of repeating a button action', () => {
  const session = startInterval(startSession(createWorkoutSession()), 'opening');
  const reply = mockTurn({ messages: [{ role: 'user', content: 'Start opening' }], state: { ui_state: '', client_events: [], workout: JSON.stringify(session) } }, '').reply;
  assert.match(reply, /^Opening warm-up is under way in the simulation\./);
  assert.match(reply, /timer_opening = Timer\("Opening warm-up", 120\)/);
});

test('duration parser takes whole tokens and never turns a negative into a budget', () => {
  assert.equal(parseTargetSeconds('i have 1.5 minutes left'), 90);
  assert.equal(parseTargetSeconds('i have -5 minutes left'), null);
  assert.equal(parseTargetSeconds('i have 2.25 seconds'), null);
  assert.equal(parseTargetSeconds('ten minutes'), 600);
});

test('snapshot decoder rejects malformed sessions', () => {
  const good = startInterval(startSession(createWorkoutSession()), 'opening');
  const variant = change => JSON.stringify(change(structuredClone(good)));
  assert.ok(parseWorkoutSnapshot(JSON.stringify(good)));
  assert.equal(parseWorkoutSnapshot('not json'), null);
  assert.equal(parseWorkoutSnapshot(variant(s => { delete s.adaptationHistory; return s; })), null);
  assert.equal(parseWorkoutSnapshot(variant(s => { s.intervals[2].id = s.intervals[1].id; return s; })), null);
  assert.equal(parseWorkoutSnapshot(variant(s => { s.intervals[1].durationSeconds = 12.5; return s; })), null);
  assert.equal(parseWorkoutSnapshot(variant(s => { s.intervals[0].status = 'completed'; s.activeIntervalId = null; return s; })), null);
});

test('server rejects a malformed workout snapshot before calling any provider', async () => {
  let providerCalls = 0;
  const server = createApp(readConfig({ ALLOW_LIVE_API: 'true', OPENAI_API_KEY: 'fake' }, process.cwd()), async () => { providerCalls++; return new Response('{}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  try {
    const { token } = await (await fetch(url + '/api/config')).json();
    for (const provider of ['mock', 'openai-api']) {
      const response = await fetch(url + '/api/turn', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Token': token },
        body: JSON.stringify({ provider, consent: true, fault: 'none', messages: [{ role: 'user', content: 'hi' }], state: { ui_state: '', client_events: [], workout: 'not json' } }),
      });
      assert.equal(response.status, 400);
    }
    assert.equal(providerCalls, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('ease and push move untouched slots one pace level and keep 60-second slots', () => {
  const fresh = startSession(createWorkoutSession());
  const pushed = applyAdaptation(fresh, { intent: 'push', revision: fresh.revision });
  assert.equal(pushed.summary, 'Activity 40 → 50 seconds. Recovery 20 → 10 seconds.');
  assert.equal(pushed.session.profile, 'high-energy');
  assert.equal(applyAdaptation(pushed.session, { intent: 'push', revision: pushed.session.revision }).applied, false);
  const back = applyAdaptation(pushed.session, { intent: 'ease', revision: pushed.session.revision });
  assert.equal(back.summary, 'Activity 50 → 40 seconds. Recovery 10 → 20 seconds.');
  assert.equal(back.session.profile, 'steady');
  assert.equal(calculateRemainingSeconds(back.session), 720);
});

test('an effort rating is taken once per slot, only at the check-in after its recovery', () => {
  let session = completeActiveInterval(startInterval(startSession(createWorkoutSession()), 'opening'));
  assert.equal(slotAwaitingEffort(session), null);
  assert.equal(recordEffort(session, 4), session);
  session = completeActiveInterval(startInterval(session, 'slot-1-work'));
  session = completeActiveInterval(session);
  assert.equal(slotAwaitingEffort(session), 1);
  assert.equal(recordEffort(session, 0), session);
  session = recordEffort(session, 4);
  assert.deepEqual(session.efforts.map(e => [e.slot, e.score]), [[1, 4]]);
  assert.equal(slotAwaitingEffort(session), null);
  assert.equal(recordEffort(session, 2), session);
  assert.ok(parseWorkoutSnapshot(JSON.stringify(session)));
});

test('a suggestion waits at the check-in and disappears with any other change', () => {
  let session = completeActiveInterval(startInterval(startSession(createWorkoutSession()), 'opening'));
  session = suggest(session, 'ease');
  assert.deepEqual(session.suggestion, { intent: 'ease' });
  assert.equal(session.profile, 'steady');
  assert.equal(dismissSuggestion(session).suggestion, undefined);
  assert.equal(startInterval(session).suggestion, undefined);
  const gentle = applyAdaptation(session, { intent: 'ease', revision: session.revision }).session;
  assert.equal(suggest(gentle, 'ease'), gentle);
  const running = startInterval(gentle);
  assert.equal(suggest(running, 'push'), running);
});

test('extractSuggestion takes exactly one well-formed Suggest', () => {
  assert.equal(extractSuggestion('Your call.\n```openui\nsuggestion1 = Suggest("ease")\n```'), 'ease');
  assert.equal(extractSuggestion('Suggest("ease") in prose only'), null);
  assert.equal(extractSuggestion('```openui\nsuggestion1 = Suggest("shorten")\n```'), null);
  assert.equal(extractSuggestion('```openui\na = Suggest("ease")\nb = Suggest("push")\n```'), null);
});

test('mock answers an effort rating with a suggestion, never a change', () => {
  let session = completeActiveInterval(startInterval(startSession(createWorkoutSession()), 'opening'));
  session = completeActiveInterval(completeActiveInterval(startInterval(session, 'slot-1-work')));
  const rate = (s, text) => mockTurn({ messages: [{ role: 'user', content: text }], state: { ui_state: '', client_events: [], workout: JSON.stringify(s) } }, '').reply;
  const hard = rate(recordEffort(session, 5), 'Effort 5 · very hard');
  assert.equal(extractSuggestion(hard), 'ease');
  assert.equal(extractProposal(hard, session.revision), null);
  assert.equal(extractSuggestion(rate(recordEffort(session, 3), 'Effort 3 · about right')), null);
  const strong = applyAdaptation(session, { intent: 'push', revision: session.revision }).session;
  assert.equal(extractSuggestion(rate(strong, 'Effort 1 · very easy')), null);
});

test('session screens carry a valid plan strip and the recap lists effort ratings', () => {
  let session = completeActiveInterval(startInterval(startSession(createWorkoutSession()), 'opening'));
  session = recordEffort(completeActiveInterval(completeActiveInterval(startInterval(session, 'slot-1-work'))), 2);
  const checkin = renderWorkoutProgram(session);
  assert.match(checkin, /planStrip = PlanStrip\(\["opening:completed:120","activity:completed:40","recovery:completed:20","activity:pending:40"/);
  assert.doesNotThrow(() => validateProgram(checkin, OPENUI_LIBRARY));
  const recap = renderWorkoutProgram(endSession(session));
  assert.match(recap, /Effort ratings by slot: 1: 2\/5/);
});
