import { serializeStatement } from '../openui/serialize.js';
import { callArgsOf } from '../openui/parse-document.js';
import { splitReply } from '../openui/document.js';
import type { ProposalIntent, SuggestionIntent, WorkoutInterval, WorkoutProposal, WorkoutSession } from './types.js';
import { calculateRemainingSeconds, getRecapSummary, slotAwaitingEffort } from './session.js';

// Screens are rendered from session state on every change; the model never draws them.

export const intervalTimerKey = (id: string) => 'timer_' + id.replace(/[^A-Za-z0-9_]/g, '_');

export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
type Part = [key: string, statement: string];
const part = (key: string, component: string, args: unknown[]): Part => [key, serializeStatement(key, component, args)];
// A List refers to its items by name, so the items go after the screen's own parts.
const list = (key: string, items: [key: string, text: string, style: string][]): Part[] => [
  [key, `${key} = List([${items.map(([k]) => k).join(', ')}])`],
  ...items.map(([k, text, style]) => [k, serializeStatement(k, 'ListItem', [text, style])] as Part),
];
const screen = (name: string, parts: Part[], listItems: Part[] = []) => [
  `root = Screens([${name}])`,
  `${name} = Screen([${parts.map(([key]) => key).join(', ')}])`,
  ...parts.map(([, statement]) => statement),
  ...listItems.map(([, statement]) => statement),
].join('\n');

export const EFFORT_LABELS = ['Effort 1 · very easy', 'Effort 2', 'Effort 3 · about right', 'Effort 4', 'Effort 5 · very hard'];
const PACES = { 'low-energy': '25s work / 35s rest', steady: '40s work / 20s rest', 'high-energy': '50s work / 10s rest' };
const SUGGESTIONS: Record<SuggestionIntent, string> = {
  ease: 'Coach suggests more recovery in the slots ahead.',
  push: 'Coach suggests a stronger pace in the slots ahead.',
};

const CUES: Record<WorkoutInterval['kind'], string> = {
  opening: 'Simulated warm-up in progress. Your first main slot follows.',
  activity: 'Simulated work slot in progress. Recovery follows.',
  recovery: 'Simulated recovery in progress. A check-in follows.',
  finish: 'Simulated cool-down in progress. Your recap follows.',
};

// Slots are numbered among those still in the plan, so a trimmed session reads "1 of 2", not "1 of 8".
function heading(session: WorkoutSession, interval: WorkoutInterval): string {
  if (interval.kind === 'opening') return 'Warm-up';
  if (interval.kind === 'finish') return 'Cool-down';
  const slots = session.intervals.filter(i => i.kind === 'activity' && i.status !== 'removed').map(i => i.id.split('-')[1]);
  const slot = interval.id.split('-')[1];
  return `Main slot ${slots.indexOf(slot) + 1} of ${slots.length} · ${interval.kind === 'activity' ? 'Work' : 'Recovery'}`;
}

export function renderWorkoutProgram(session: WorkoutSession, activeTimerRemaining?: number): string {
  const strip = part('planStrip', 'PlanStrip', [session.intervals.map(i => `${i.kind}:${i.status}:${i.durationSeconds}`)]);
  const remaining = formatClock(calculateRemainingSeconds(session, activeTimerRemaining));
  const pace = PACES[session.profile];
  const next = session.intervals.find(i => i.status === 'pending');
  const active = session.intervals.find(i => i.id === session.activeIntervalId);

  if (session.stage === 'welcome') {
    return screen('welcomeScreen', [
      part('welcomeTitle', 'Text', ['AiRA · Find your pace', 'title']),
      part('welcomeSubtitle', 'Text', ['A simulated workout session that adapts when your needs change.', 'subtitle']),
      part('durationStat', 'Keyword', ['12 min', 'Planned duration']),
      part('roundsStat', 'Keyword', ['8 rounds', pace]),
      part('welcomeActions', 'FollowUps', [['Start demo session', 'Make it easier']]),
      part('welcomeCue', 'Cue', ["Let's find a pace that fits today. Start steady, or choose a gentler session."]),
    ]);
  }

  if (session.stage === 'preview') {
    const seconds = (id: string) => session.intervals.find(i => i.id === id)!.durationSeconds;
    const slots = session.intervals.filter(i => i.kind === 'activity' && i.status === 'pending').length;
    const [plan, ...planItems] = list('previewPlan', [
      ['planItem1', `Opening warm-up (${seconds('opening')}s)`, 'numbered'],
      ['planItem2', `${plural(slots, 'main slot')}: alternating Tempo squat & Standing reach (${pace})`, 'numbered'],
      ['planItem3', `Finish & cool-down (${seconds('finish')}s)`, 'numbered'],
    ]);
    return screen('previewScreen', [
      part('previewTitle', 'Text', [`Session preview (${remaining})`, 'title']),
      strip,
      plan,
      part('remainingStat', 'Keyword', [remaining, 'Total planned time']),
      part('previewActions', 'FollowUps', [['Start opening', 'Make it easier', 'Make it harder', 'I have 5 minutes left']]),
      part('previewCue', 'Cue', ['This demo has an opening, main slots, and a finish. You can ease the pace or shorten it along the way.']),
    ], planItems);
  }

  if (session.stage === 'active' && active) {
    return screen('activeScreen', [
      part('activeTitle', 'Text', [heading(session, active), 'subtitle']),
      strip,
      part(intervalTimerKey(active.id), 'Timer', [active.label, active.durationSeconds]),
      part('nextNotice', 'Text', [next ? `Up next: ${next.label} (${next.durationSeconds}s)` : 'Final interval in progress', 'description']),
      part('remainingStat', 'Keyword', [remaining, 'Remaining planned time']),
      part('activeActions', 'FollowUps', [['Make it easier', 'Make it harder', 'I have 5 minutes left', 'End session']]),
      part('activeCue', 'Cue', [CUES[active.kind]]),
    ]);
  }

  if (session.stage !== 'recap') {
    // After a recovery the check-in asks for an effort rating first; a coach suggestion,
    // if there is one, waits for the user's answer instead of applying itself.
    const rateSlot = slotAwaitingEffort(session);
    const prompt: Part[] = rateSlot !== null
      ? [part('effortQuestion', 'Text', [`How hard was slot ${rateSlot}?`, 'description']), part('effortOptions', 'FollowUps', [EFFORT_LABELS])]
      : session.suggestion
        ? [part('suggestionText', 'Text', [SUGGESTIONS[session.suggestion.intent], 'description']), part('suggestionOptions', 'FollowUps', [['Apply suggestion', 'Not now']])]
        : [];
    return screen('checkinScreen', [
      part('checkinTitle', 'Text', ['How does this pace fit?', 'title']),
      strip,
      ...prompt,
      part('nextNotice', 'Text', [next ? `Ready for: ${next.label} (${next.durationSeconds}s)` : 'Ready to finish', 'description']),
      part('remainingStat', 'Keyword', [remaining, 'Remaining planned time']),
      part('checkinActions', 'FollowUps', [['Continue next slot', 'Make it easier', 'Make it harder', 'I have 5 minutes left', 'End session']]),
      part('checkinCue', 'Cue', ['The previous slot is complete in the simulation. Continue when you are ready, or adjust the remaining plan.']),
    ]);
  }

  const recap = getRecapSummary(session);
  const endedEarly = session.completionMode === 'ended-early';
  const lines: [string, string, string][] = [
    ['completedItem', `${plural(recap.completedCount, 'interval')} completed (${formatClock(recap.simulatedSecondsCompleted)} simulated)`, 'plus'],
  ];
  if (recap.skippedCount) lines.push(['skippedItem', `${plural(recap.skippedCount, 'interval')} skipped`, 'minus']);
  if (recap.removedCount) lines.push(['removedItem', `${plural(recap.removedCount, 'interval')} removed by adaptation`, 'bullet']);
  recap.adaptationsApplied.forEach((summary, i) => lines.push([`adaptItem${i}`, summary, 'bullet']));
  if (session.efforts?.length) lines.push(['effortItem', `Effort ratings by slot: ${session.efforts.map(e => `${e.slot}: ${e.score}/5`).join(', ')}`, 'bullet']);
  const [summary, ...summaryItems] = list('summaryList', lines);

  let subtitle = endedEarly ? 'Partial session summary.'
    : recap.adaptationsApplied.length ? 'You adjusted the session to fit your time.' : 'You completed the planned session.';
  if (session.completionMode === 'batch-simulated') subtitle += ' The remaining intervals were fast-forwarded in the simulation.';

  return screen('recapScreen', [
    part('recapTitle', 'Text', [endedEarly ? 'Session ended early' : 'Session complete', 'title']),
    part('recapSubtitle', 'Text', [subtitle, 'subtitle']),
    part('completedStat', 'Keyword', [formatClock(recap.simulatedSecondsCompleted), 'Simulated time completed']),
    summary,
    part('recapActions', 'FollowUps', [['Restart demo session']]),
    part('recapCue', 'Cue', [endedEarly
      ? 'Session ended early in simulation. Summary reflects completed intervals.'
      : 'Great job completing the simulation. Every total here is verified from local session state.']),
  ], summaryItems);
}

// Returns the one Proposal in the reply's fences, or null if there is none,
// more than one, or any malformed one. Prose that merely mentions Proposal is ignored.
export function extractProposal(reply: string, expectedRevision?: number, expectedSessionId?: string): WorkoutProposal | null {
  let fences: string[];
  try { fences = splitReply(reply).fences; } catch { return null; }

  const found: WorkoutProposal[] = [];
  for (const line of fences.flatMap(fence => fence.split('\n'))) {
    const call = callArgsOf(line.trim());
    if (call?.name !== 'Proposal') continue;
    const [intent, seconds] = call.args;
    if (intent?.k !== 'str' || !['keep', 'ease', 'push', 'shorten'].includes(intent.v)) return null;
    let target: number | undefined;
    if (intent.v === 'shorten') {
      if (seconds?.k !== 'num' || !Number.isInteger(seconds.v) || seconds.v <= 0 || seconds.v > 3600) return null;
      target = seconds.v;
    } else if (seconds !== undefined) return null;

    const proposal: WorkoutProposal = { intent: intent.v as ProposalIntent, seconds: target, revision: expectedRevision ?? 1 };
    if (expectedSessionId !== undefined) proposal.sessionId = expectedSessionId;
    found.push(proposal);
  }
  return found.length === 1 ? found[0] : null;
}

// The coach's optional Suggest("ease" | "push") after an effort rating. Like a Proposal it
// must be the only one in the reply's fences; unlike a Proposal it waits for the user.
export function extractSuggestion(reply: string): SuggestionIntent | null {
  let fences: string[];
  try { fences = splitReply(reply).fences; } catch { return null; }
  const found = fences.flatMap(fence => fence.split('\n')).map(line => callArgsOf(line.trim())).filter(call => call?.name === 'Suggest');
  if (found.length !== 1) return null;
  const [intent, extra] = found[0]!.args;
  return intent?.k === 'str' && (intent.v === 'ease' || intent.v === 'push') && extra === undefined ? intent.v : null;
}
