import type {
  ActivityLabel,
  AdaptationRecord,
  EnergyProfile,
  ProposalIntent,
  SuggestionIntent,
  WorkoutInterval,
  WorkoutProposal,
  WorkoutRecapSummary,
  WorkoutSession,
} from './types.js';

export const DEFAULT_PLANNED_SECONDS = 720;
const SLOTS = 8;
const PACE = { 'low-energy': { work: 25, rest: 35 }, steady: { work: 40, rest: 20 }, 'high-energy': { work: 50, rest: 10 } } as const;
const LEVELS: EnergyProfile[] = ['low-energy', 'steady', 'high-energy'];

type Change = { session: WorkoutSession; applied: boolean; summary: string };

export function createDefaultIntervals(profile: EnergyProfile = 'steady'): WorkoutInterval[] {
  const { work, rest } = PACE[profile];
  const intervals: WorkoutInterval[] = [
    { id: 'opening', kind: 'opening', label: 'Opening warm-up', durationSeconds: 120, status: 'pending' },
  ];
  for (let slot = 1; slot <= SLOTS; slot++) {
    const activity: ActivityLabel = slot % 2 ? 'Tempo squat' : 'Standing reach';
    intervals.push(
      { id: `slot-${slot}-work`, kind: 'activity', label: `Slot ${slot}: ${activity}`, activityLabel: activity, durationSeconds: work, status: 'pending' },
      { id: `slot-${slot}-rest`, kind: 'recovery', label: `Slot ${slot}: Recovery`, durationSeconds: rest, status: 'pending' },
    );
  }
  intervals.push({ id: 'finish', kind: 'finish', label: 'Finish & cool-down', durationSeconds: 120, status: 'pending' });
  return intervals;
}

export function createWorkoutSession(profile: EnergyProfile = 'steady', id?: string): WorkoutSession {
  return {
    sessionId: id ?? `session-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    revision: 1,
    profile,
    stage: 'welcome',
    intervals: createDefaultIntervals(profile),
    activeIntervalId: null,
    adaptationHistory: [],
    actionHistory: [],
    startedAt: null,
    endedAt: null,
  };
}

const now = () => new Date().toISOString();
// Every change bumps the revision and drops a pending suggestion, which only makes sense at the moment it was offered.
const bump = (session: WorkoutSession, patch: Partial<WorkoutSession>): WorkoutSession =>
  ({ ...session, suggestion: undefined, ...patch, revision: session.revision + 1 });
const replaceAt = (intervals: WorkoutInterval[], index: number, patch: Partial<WorkoutInterval>) =>
  intervals.map((item, i) => (i === index ? { ...item, ...patch } : item));

export function startSession(session: WorkoutSession): WorkoutSession {
  if (session.stage !== 'welcome' && session.stage !== 'preview') return session;
  return bump(session, { stage: 'preview', startedAt: session.startedAt ?? now() });
}

export function startInterval(session: WorkoutSession, intervalId?: string): WorkoutSession {
  if (session.stage === 'recap' || session.activeIntervalId) return session;
  const index = intervalId
    ? session.intervals.findIndex(i => i.id === intervalId)
    : session.intervals.findIndex(i => i.status === 'pending');
  if (session.intervals[index]?.status !== 'pending') return session;
  return bump(session, {
    intervals: replaceAt(session.intervals, index, { status: 'active', startedAt: Date.now() }),
    activeIntervalId: session.intervals[index].id,
    stage: 'active',
  });
}

// A work slot runs straight into its recovery; anything else hands back to the
// user at a check-in. So the 'active' stage always has an active interval.
function closeActive(session: WorkoutSession, patch: Partial<WorkoutInterval>): WorkoutSession {
  if (session.stage === 'recap' || !session.activeIntervalId) return session;
  const index = session.intervals.findIndex(i => i.id === session.activeIntervalId);
  if (index === -1) return session;

  const intervals = replaceAt(session.intervals, index, patch);
  const nextIndex = intervals.findIndex(i => i.status === 'pending');
  if (nextIndex === -1) {
    return bump(session, {
      intervals, activeIntervalId: null, stage: 'recap',
      completionMode: session.completionMode ?? 'completed',
      endedAt: session.endedAt ?? now(),
    });
  }
  if (intervals[index].kind === 'activity' && intervals[nextIndex].kind === 'recovery') {
    return bump(session, {
      intervals: replaceAt(intervals, nextIndex, { status: 'active', startedAt: Date.now() }),
      activeIntervalId: intervals[nextIndex].id,
      stage: 'active',
    });
  }
  return bump(session, { intervals, activeIntervalId: null, stage: 'checkin' });
}

export const completeActiveInterval = (session: WorkoutSession) =>
  closeActive(session, { status: 'completed', completedAt: Date.now() });

export const skipActiveInterval = (session: WorkoutSession) =>
  closeActive(session, { status: 'skipped' });

export function endSession(session: WorkoutSession): WorkoutSession {
  if (session.stage === 'recap') return session;
  return bump(session, {
    intervals: session.intervals.map(i => (i.status === 'active' ? { ...i, status: 'skipped' } : i)),
    activeIntervalId: null,
    stage: 'recap',
    completionMode: 'ended-early',
    endedAt: session.endedAt ?? now(),
  });
}

// activeTimerRemaining lets the caller count the running interval by its live clock.
export function calculateRemainingSeconds(session: WorkoutSession, activeTimerRemaining?: number): number {
  return session.intervals.reduce((total, i) => {
    if (i.status === 'active') return total + Math.max(0, Math.ceil(activeTimerRemaining ?? i.durationSeconds));
    return i.status === 'pending' ? total + i.durationSeconds : total;
  }, 0);
}

// Work/rest index pairs for slots that have not started. A slot whose work is
// done or running is left alone, so adaptations never rewrite history.
function untouchedSlots(intervals: WorkoutInterval[]): [number, number][] {
  const pairs: [number, number][] = [];
  for (let slot = 1; slot <= SLOTS; slot++) {
    const work = intervals.findIndex(i => i.id === `slot-${slot}-work`);
    const rest = intervals.findIndex(i => i.id === `slot-${slot}-rest`);
    if (work !== -1 && rest !== -1 && intervals[work].status === 'pending' && intervals[rest].status === 'pending') pairs.push([work, rest]);
  }
  return pairs;
}

function adapted(session: WorkoutSession, intent: ProposalIntent, intervals: WorkoutInterval[], summary: string, patch: Partial<WorkoutSession> = {}): Change {
  const record: AdaptationRecord = { intent, summary, appliedAt: now(), revision: session.revision + 1 };
  return { session: bump(session, { ...patch, intervals, adaptationHistory: [...session.adaptationHistory, record] }), applied: true, summary };
}

// Ease and push move the untouched slots one pace level down or up. Every level keeps a
// slot at 60 seconds, so the session length does not change.
function shift(session: WorkoutSession, intent: SuggestionIntent): Change {
  const level = LEVELS.indexOf(session.profile) + (intent === 'ease' ? -1 : 1);
  const target = LEVELS[level];
  const limit = intent === 'ease' ? 'Upcoming slots are already on the gentle profile or cannot be adapted.' : 'Upcoming slots are already at the strongest pace or cannot be adapted.';
  if (!target) return { session, applied: false, summary: limit };
  const from = PACE[session.profile], to = PACE[target];
  const intervals = [...session.intervals];
  const slots = untouchedSlots(intervals);
  for (const [w, r] of slots) {
    intervals[w] = { ...intervals[w], durationSeconds: to.work };
    intervals[r] = { ...intervals[r], durationSeconds: to.rest };
  }
  if (!slots.length) return { session, applied: false, summary: limit };
  return adapted(session, intent, intervals, `Activity ${from.work} → ${to.work} seconds. Recovery ${from.rest} → ${to.rest} seconds.`, { profile: target });
}

// The slot whose recovery just finished, if the user is at that check-in and has not rated it yet.
export function slotAwaitingEffort(session: WorkoutSession): number | null {
  if (session.stage !== 'checkin') return null;
  const last = session.intervals.filter(i => i.status === 'completed' || i.status === 'skipped').at(-1);
  if (last?.kind !== 'recovery') return null;
  const slot = Number(last.id.split('-')[1]);
  return session.efforts?.some(e => e.slot === slot) ? null : slot;
}

export function recordEffort(session: WorkoutSession, score: number): WorkoutSession {
  const slot = slotAwaitingEffort(session);
  if (slot === null || !Number.isInteger(score) || score < 1 || score > 5) return session;
  return bump(session, { efforts: [...(session.efforts ?? []), { slot, score, at: now() }] });
}

// Offered only at a check-in, and only if accepting it would actually change something.
export function suggest(session: WorkoutSession, intent: SuggestionIntent): WorkoutSession {
  if (session.stage !== 'checkin' || !shift(session, intent).applied) return session;
  return bump(session, { suggestion: { intent } });
}

export const dismissSuggestion = (session: WorkoutSession) => (session.suggestion ? bump(session, {}) : session);

// One pass over the untouched slots, last first, then the finish (never below 30s).
// With overshoot off, a slot is dropped only if the plan stays at or above the target.
function trim(session: WorkoutSession, start: number, target: number, overshoot: boolean) {
  const intervals = [...session.intervals];
  let remaining = start;
  let removed = 0;
  for (const [w, r] of untouchedSlots(intervals).reverse()) {
    const length = intervals[w].durationSeconds + intervals[r].durationSeconds;
    if (remaining <= target) break;
    if (!overshoot && remaining - length < target) continue;
    intervals[w] = { ...intervals[w], status: 'removed' };
    intervals[r] = { ...intervals[r], status: 'removed' };
    remaining -= length;
    removed++;
  }
  const finish = intervals.findIndex(i => i.id === 'finish');
  if (remaining > target && intervals[finish]?.status === 'pending') {
    const trimmed = Math.max(30, intervals[finish].durationSeconds - (remaining - target));
    remaining -= intervals[finish].durationSeconds - trimmed;
    intervals[finish] = { ...intervals[finish], durationSeconds: trimmed };
  }
  return { intervals, remaining, removed };
}

// The target is an upper bound. Prefer an exact fit that keeps as much work as possible;
// if none exists, drop whole slots until the plan fits. The active interval is never cut.
function shorten(session: WorkoutSession, target: number, activeTimerRemaining?: number): Change {
  if (!Number.isInteger(target) || target <= 0 || target > 3600) return { session, applied: false, summary: 'Invalid shorten target duration.' };
  const before = calculateRemainingSeconds(session, activeTimerRemaining);
  if (before <= target) return { session, applied: false, summary: `Session remaining time (${before}s) is already within the ${target}s limit.` };

  let result = trim(session, before, target, false);
  if (result.remaining > target) result = trim(session, before, target, true);
  const { intervals, remaining, removed } = result;

  if (remaining > target) {
    return { session, applied: false, summary: `Cannot shorten to ${target}s without clipping protected work (${remaining}s minimum required). Consider ending the session instead.` };
  }
  return adapted(session, 'shorten', intervals, `Session adjusted to fit remaining limit: ${remaining} seconds remaining (${removed} slots trimmed).`);
}

export function applyAdaptation(session: WorkoutSession, proposal: WorkoutProposal, activeTimerRemaining?: number): Change {
  if (session.stage === 'recap') return { session, applied: false, summary: 'Session has already ended.' };
  if (proposal.sessionId && proposal.sessionId !== session.sessionId) return { session, applied: false, summary: 'Stale session identifier.' };
  if (proposal.revision !== undefined && proposal.revision !== session.revision) return { session, applied: false, summary: 'Stale proposal revision.' };
  if (proposal.intent === 'ease' || proposal.intent === 'push') return shift(session, proposal.intent);
  if (proposal.intent === 'shorten') return shorten(session, proposal.seconds ?? 300, activeTimerRemaining);
  return { session, applied: false, summary: 'Pace kept steady.' };
}

const STAGES = ['welcome', 'preview', 'active', 'checkin', 'recap'];
const STATUSES = ['pending', 'active', 'completed', 'skipped', 'removed'];

// The session round-trips through the browser and request body, so check its
// shape before trusting it.
export function validateWorkoutSession(raw: unknown): WorkoutSession | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.sessionId !== 'string' || !s.sessionId.trim()) return null;
  if (!Number.isInteger(s.revision) || (s.revision as number) < 1) return null;
  if (!LEVELS.includes(s.profile as EnergyProfile)) return null;
  if (!STAGES.includes(s.stage as string)) return null;
  if (!Array.isArray(s.intervals) || s.intervals.length !== 2 * SLOTS + 2) return null;

  const intervals = s.intervals as Record<string, unknown>[];
  const expected = createDefaultIntervals();
  const wellFormed = intervals.every((i, n) => typeof i === 'object' && i !== null
    && i.id === expected[n].id && i.kind === expected[n].kind
    && typeof i.label === 'string' && i.label !== ''
    && Number.isInteger(i.durationSeconds) && (i.durationSeconds as number) > 0 && (i.durationSeconds as number) <= 3600
    && STATUSES.includes(i.status as string));
  if (!wellFormed) return null;

  const history = s.adaptationHistory;
  if (!Array.isArray(history) || !history.every(a => typeof a === 'object' && a !== null && ['keep', 'ease', 'push', 'shorten'].includes(a.intent) && typeof a.summary === 'string')) return null;
  if (s.actionHistory !== undefined && !Array.isArray(s.actionHistory)) return null;
  if (s.efforts !== undefined && !(Array.isArray(s.efforts) && s.efforts.every(e => typeof e === 'object' && e !== null
    && Number.isInteger(e.slot) && e.slot >= 1 && e.slot <= SLOTS && Number.isInteger(e.score) && e.score >= 1 && e.score <= 5))) return null;
  if (s.suggestion !== undefined && !['ease', 'push'].includes((s.suggestion as { intent?: string } | null)?.intent ?? '')) return null;

  // Exactly one active interval in the 'active' stage, and none in any other.
  const active = intervals.filter(i => i.status === 'active');
  if (s.stage === 'active' ? active.length !== 1 || active[0].id !== s.activeIntervalId : active.length !== 0 || s.activeIntervalId !== null) return null;
  return raw as WorkoutSession;
}

export function parseWorkoutSnapshot(json: string): WorkoutSession | null {
  try { return validateWorkoutSession(JSON.parse(json)); } catch { return null; }
}

export function getRecapSummary(session: WorkoutSession): WorkoutRecapSummary {
  const count = (status: WorkoutInterval['status']) => session.intervals.filter(i => i.status === status).length;
  return {
    totalPlannedSeconds: DEFAULT_PLANNED_SECONDS,
    simulatedSecondsCompleted: session.intervals.filter(i => i.status === 'completed').reduce((sum, i) => sum + i.durationSeconds, 0),
    completedCount: count('completed'),
    skippedCount: count('skipped'),
    removedCount: count('removed'),
    totalIntervals: session.intervals.length,
    adaptationsApplied: session.adaptationHistory.map(a => a.summary),
  };
}
