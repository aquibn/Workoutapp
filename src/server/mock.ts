import { serializeStatement } from '../shared/openui/serialize.js';
import type { RequestData, Turn } from '../shared/contracts.js';
import { ScreenDocument } from '../shared/openui/document.js';
import { applyAdaptation, createWorkoutSession, parseWorkoutSnapshot } from '../shared/workout/session.js';
import { renderWorkoutProgram } from '../shared/workout/openui-bridge.js';
import type { WorkoutSession } from '../shared/workout/types.js';

export function mockTurn(request: RequestData, fixture: string): Turn {
  const last=request.messages.at(-1)?.content.trim().toLowerCase() ?? '';
  const fence=(code:string)=>'```openui\n'+code+'\n```';
  if(last==='load wiring sample' || last==='/demo')return {reply:'Wiring fixture loaded. This is deterministic, not a model interpreting your skill.\n'+fence('root = Screens([])')+'\n'+fence(fixture)};
  const doc=new ScreenDocument();if(request.state.ui_state)doc.apply(fence(request.state.ui_state));
  const screens=doc.screens;const index=screens.findIndex(s=>s.key===doc.cursor);
  if(['next','back'].includes(last) && screens.length){const target=screens[Math.max(0,Math.min(screens.length-1,index+(last==='back'?-1:1)))];return {reply:'Fixture cursor moved.\n'+fence(`root = Screens([${screens.map(s=>s.key).join(', ')}], ${target.key})`)};}
  if(/^change value to (\d{1,2})$/.test(last) && doc.program.includes('count1 =')){const value=Number(last.match(/\d+/)![0]);return {reply:'Fixture values patched under their existing names.\n'+fence(serializeStatement('count1','Keyword',[String(value),'Sample value'])+'\n'+serializeStatement('count2','Keyword',[String(value),'Second sample value']))};}

  // The server has already rejected malformed snapshots; no snapshot means the session has not started.
  const session = (request.state.workout && parseWorkoutSnapshot(request.state.workout)) || createWorkoutSession();

  // Like a live model, the mock answers adaptation requests with a Proposal fence
  // and leaves applying it to the client.
  const say = (prose: string, shown: WorkoutSession = session, proposal = '') =>
    ({ reply: prose + '\n' + fence((proposal ? proposal + '\n' : '') + renderWorkoutProgram(shown)) });
  // An on-screen button applies its change before this turn and reports it here.
  const appliedByButton = request.state.client_events.filter(e => e.startsWith('Adaptation applied: ')).at(-1)?.slice(20);

  if (/\b(hurt|pain|injury|doctor|medical)\b/.test(last)) {
    return say('This is a simulated workout prototype, not medical advice. Please pause or end the session if you feel discomfort.');
  }

  if (/\b(easier|gentle|gentler|ease|slow down|lower intensity|too intense)\b/.test(last)) {
    const result = applyAdaptation(session, { intent: 'ease', revision: session.revision, sessionId: session.sessionId });
    if (result.applied) return say(`Giving upcoming slots more breathing room. ${result.summary}`, result.session, 'proposal1 = Proposal("ease")');
    if (appliedByButton?.startsWith('Activity')) return say(`Upcoming slots now have more breathing room. ${appliedByButton}`);
    return say(`No change needed. ${result.summary}`);
  }

  if (/\b(shorten|shorter|in a hurry|finish early|minutes? left|seconds? left|only have)\b/.test(last)) {
    const seconds = parseTargetSeconds(last);
    if (seconds === null) return say('How many minutes do you have left? I will trim the remaining slots to fit.');
    const result = applyAdaptation(session, { intent: 'shorten', seconds, revision: session.revision, sessionId: session.sessionId });
    if (result.applied) return say(`Trimming the plan to fit ${formatSeconds(seconds)}. ${result.summary}`, result.session, `proposal1 = Proposal("shorten", ${seconds})`);
    if (appliedByButton?.startsWith('Session adjusted')) return say(`Done. ${appliedByButton}`);
    return say(`The plan stays as it is. ${result.summary}`);
  }

  if (/\b(keep going|feels good|feeling good|steady)\b/.test(last)) {
    return say('Keeping the current pace. Continue when you are ready.', session, 'proposal1 = Proposal("keep")');
  }

  if (/^(start demo session|start opening|continue next slot|end session|restart demo session)$/.test(last)) return say(describe(session));
  return say('I am the offline demo coach: I follow the on-screen options plus requests like "make it easier", "I have 5 minutes left" or "keep going". Mock mode does not read your skill; choose a live provider for free-form coaching.');
}

// Lifecycle buttons have already been applied by the client, so describe the state
// as received rather than performing the action a second time.
function describe(session: WorkoutSession): string {
  const active = session.intervals.find(i => i.id === session.activeIntervalId);
  if (session.stage === 'welcome') return 'Ready when you are. Start the demo session to see the plan.';
  if (session.stage === 'preview') return "Here is your session plan: an opening warm-up, the main slots, then a cool-down. Start the opening when you're ready.";
  if (session.stage === 'checkin') return 'Interval complete in simulation. Continue when you are ready, or adjust the remaining plan.';
  if (session.stage === 'recap') return session.completionMode === 'ended-early' ? 'Session ended early in simulation. Here is your summary.' : 'Session complete in simulation. Here is your summary.';
  if (active?.kind === 'recovery') return `Work slot complete. ${active.label} has started.`;
  return `${active?.label ?? 'The interval'} is under way in the simulation.`;
}

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

// "5 minutes", "five min", "1.5 minutes", "300 seconds", "90s" -> whole seconds. Anything else,
// including negative amounts, gives null so the coach asks instead of guessing.
export function parseTargetSeconds(text: string): number | null {
  const match = text.match(/(?<![\w.-])(\d{1,4}(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)\s*(minutes?|mins?|seconds?|secs?|s)\b/);
  if (!match) return null;
  const amount = NUMBER_WORDS[match[1]] ?? Number(match[1]);
  const seconds = match[2].startsWith('m') ? amount * 60 : amount;
  return Number.isInteger(seconds) && seconds > 0 && seconds <= 3600 ? seconds : null;
}

const formatSeconds = (seconds: number) =>
  seconds % 60 === 0 ? `${seconds / 60} minute${seconds === 60 ? '' : 's'}` : `${seconds} seconds`;
