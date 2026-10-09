import type {
  ActivityLabel,
  AdaptationRecord,
  EnergyProfile,
  ProposalIntent,
  WorkoutInterval,
  WorkoutProposal,
  WorkoutRecapSummary,
  WorkoutSession,
} from './types.js';

export const DEFAULT_PLANNED_SECONDS = 720;
const SLOTS = 8;
const PACE = { steady: { work: 40, rest: 20 }, 'low-energy': { work: 25, rest: 35 } } as const;

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
const bump = (session: WorkoutSession, patch: Partial<WorkoutSession>): WorkoutSession =>
  ({ ...session, ...patch, revision: session.revision + 1 });
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

function ease(session: WorkoutSession): Change {
  const { work, rest } = PACE['low-energy'];
  const intervals = [...session.intervals];
  let changed = 0;
  for (const [w, r] of untouchedSlots(intervals)) {
    if (intervals[w].durationSeconds === work && intervals[r].durationSeconds === rest) continue;
    intervals[w] = { ...intervals[w], durationSeconds: work };
    intervals[r] = { ...intervals[r], durationSeconds: rest };
    changed++;
  }
  if (!changed) return { session, applied: false, summary: 'Upcoming slots are already on the gentle profile or cannot be adapted.' };
  return adapted(session, 'ease', intervals, 'Activity 40 → 25 seconds. Recovery 20 → 35 seconds.', { profile: 'low-energy' });
}

// Drop whole untouched slots from the end first, then trim the finish (never
// below 30s). The active interval is never cut.
function shorten(session: WorkoutSession, target: number, activeTimerRemaining?: number): Change {
  if (!Number.isInteger(target) || target <= 0 || target > 3600) return { session, applied: false, summary: 'Invalid shorten target duration.' };
  const before = calculateRemainingSeconds(session, activeTimerRemaining);
  if (before <= target) return { session, applied: false, summary: `Session remaining time (${before}s) is already within the ${target}s limit.` };

  const intervals = [...session.intervals];
  let remaining = before;
  let removed = 0;
  for (const [w, r] of untouchedSlots(intervals).reverse()) {
    const length = intervals[w].durationSeconds + intervals[r].durationSeconds;
    if (remaining - length < target) continue;
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

  if (remaining > target) {
    return { session, applied: false, summary: `Cannot shorten to ${target}s without clipping protected work (${remaining}s minimum required). Consider ending the session instead.` };
  }
  if (remaining === before) return { session, applied: false, summary: 'Cannot shorten further without clipping protected active intervals.' };
  return adapted(session, 'shorten', intervals, `Session adjusted to fit remaining limit: ${remaining} seconds remaining (${removed} slots trimmed).`);
}

export function applyAdaptation(session: WorkoutSession, proposal: WorkoutProposal, activeTimerRemaining?: number): Change {
  if (session.stage === 'recap') return { session, applied: false, summary: 'Session has already ended.' };
  if (proposal.sessionId && proposal.sessionId !== session.sessionId) return { session, applied: false, summary: 'Stale session identifier.' };
  if (proposal.revision !== undefined && proposal.revision !== session.revision) return { session, applied: false, summary: 'Stale proposal revision.' };
  if (proposal.intent === 'ease') return ease(session);
  if (proposal.intent === 'shorten') return shorten(session, proposal.seconds ?? 300, activeTimerRemaining);
  return { session, applied: false, summary: 'Pace kept steady.' };
}

const STAGES = ['welcome', 'preview', 'active', 'checkin', 'recap'];
const KINDS = ['opening', 'activity', 'recovery', 'finish'];
const STATUSES = ['pending', 'active', 'completed', 'skipped', 'removed'];

// The session round-trips through the browser and request body, so check its
// shape before trusting it.
export function validateWorkoutSession(raw: unknown): WorkoutSession | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.sessionId !== 'string' || !s.sessionId.trim()) return null;
  if (!Number.isInteger(s.revision) || (s.revision as number) < 1) return null;
  if (s.profile !== 'steady' && s.profile !== 'low-energy') return null;
  if (!STAGES.includes(s.stage as string)) return null;
  if (!Array.isArray(s.intervals) || s.intervals.length !== 2 * SLOTS + 2) return null;

  const intervals = s.intervals as Record<string, unknown>[];
  const wellFormed = intervals.every(i => typeof i === 'object' && i !== null
    && typeof i.id === 'string' && i.id !== ''
    && KINDS.includes(i.kind as string)
    && typeof i.label === 'string' && i.label !== ''
    && typeof i.durationSeconds === 'number' && i.durationSeconds > 0
    && STATUSES.includes(i.status as string));
  if (!wellFormed) return null;

  const active = intervals.filter(i => i.status === 'active');
  if (active.length > 1) return null;
  if (s.activeIntervalId !== null && typeof s.activeIntervalId !== 'string') return null;
  if (s.activeIntervalId === null ? active.length !== 0 : active[0]?.id !== s.activeIntervalId) return null;
  return raw as WorkoutSession;
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
