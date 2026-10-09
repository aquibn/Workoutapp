import { serializeStatement } from '../shared/openui/serialize.js';
import type { RequestData, Turn } from '../shared/contracts.js';
import { ScreenDocument } from '../shared/openui/document.js';
import {
  applyAdaptation,
  completeActiveInterval,
  createWorkoutSession,
  endSession,
  startInterval,
  startSession,
  validateWorkoutSession,
} from '../shared/workout/session.js';
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

  let session = createWorkoutSession();
  try {
    if (request.state.workout) session = validateWorkoutSession(JSON.parse(request.state.workout)) ?? session;
  } catch { /* unreadable snapshot: start fresh */ }

  // Like a live model, the mock answers adaptation requests with a Proposal fence
  // and leaves applying it to the client.
  const say = (prose: string, shown: WorkoutSession = session, proposal = '') =>
    ({ reply: prose + '\n' + fence((proposal ? proposal + '\n' : '') + renderWorkoutProgram(shown)) });

  if (/\b(hurt|pain|injury|doctor|medical)\b/.test(last)) {
    return say('This is a simulated workout prototype, not medical advice. Please pause or end the session if you feel discomfort.');
  }

  if (/\b(easier|gentle|gentler|ease|slow down|lower intensity|too intense)\b/.test(last)) {
    const result = applyAdaptation(session, { intent: 'ease', revision: session.revision, sessionId: session.sessionId });
    // An on-screen button may already have applied it before this turn.
    const earlier = session.adaptationHistory.findLast(a => a.intent === 'ease');
    const prose = result.applied ? `Giving upcoming slots more breathing room. ${result.summary}`
      : earlier ? `Upcoming slots now have more breathing room. ${earlier.summary}`
      : `No change needed. ${result.summary}`;
    return say(prose, result.session, 'proposal1 = Proposal("ease")');
  }

  if (/\b(shorten|shorter|in a hurry|finish early|minutes? left|seconds? left|only have)\b/.test(last)) {
    const seconds = parseTargetSeconds(last);
    if (seconds === null) return say('How many minutes do you have left? I will trim the remaining slots to fit.');
    const result = applyAdaptation(session, { intent: 'shorten', seconds, revision: session.revision, sessionId: session.sessionId });
    const latest = session.adaptationHistory.at(-1);
    const prose = result.applied ? `Trimming the plan to fit ${formatSeconds(seconds)}. ${result.summary}`
      : latest?.intent === 'shorten' ? `The plan is now trimmed to fit. ${latest.summary}`
      : `The plan stays as it is. ${result.summary}`;
    return say(prose, result.session, `proposal1 = Proposal("shorten", ${seconds})`);
  }

  if (/\b(keep going|feels good|feeling good|steady)\b/.test(last)) {
    return say('Keeping the current pace. Continue when you are ready.', session, 'proposal1 = Proposal("keep")');
  }
  if (last.includes('restart')) return say("Restarting demo session. Let's find your pace.", createWorkoutSession());
  if (last.includes('start demo session') || last.includes('start workout') || last === 'start') {
    return say("Here is your 12-minute session plan. We'll start with an opening warm-up and eight short main slots.", startSession(session));
  }
  if (last.includes('start opening')) return say('Starting the opening warm-up in simulation.', startInterval(session, 'opening'));
  if (last.includes('simulate interval finish') || last.includes('finish interval')) {
    const next = completeActiveInterval(session);
    const prose = next.stage === 'recap' ? 'Final interval complete in simulation. Here is your summary.'
      : next.stage === 'active' ? 'Work slot complete in simulation. Recovery has started.'
      : 'Interval complete in simulation. Ready for the next slot when you are.';
    return say(prose, next);
  }
  if (last.includes('continue')) return say('Moving to the next interval in simulation.', startInterval(session));
  if (last.includes('end session') || last.includes('stop workout')) {
    return say('Session ended early in simulation. Here is your summary.', endSession(session));
  }

  return say('I am the offline demo coach: I follow the on-screen options plus requests like "make it easier", "I have 5 minutes left" or "keep going". Mock mode does not read your skill; choose a live provider for free-form coaching.');
}

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

// "5 minutes", "five min", "300 seconds", "90s" -> seconds; null when no usable duration is given.
export function parseTargetSeconds(text: string): number | null {
  const match = text.match(/\b(\d{1,4}|one|two|three|four|five|six|seven|eight|nine|ten)\s*(minutes?|mins?|seconds?|secs?|s)\b/);
  if (!match) return null;
  const amount = NUMBER_WORDS[match[1]] ?? Number(match[1]);
  const seconds = match[2].startsWith('m') ? amount * 60 : amount;
  return seconds > 0 && seconds <= 3600 ? seconds : null;
}

const formatSeconds = (seconds: number) =>
  seconds % 60 === 0 ? `${seconds / 60} minute${seconds === 60 ? '' : 's'}` : `${seconds} seconds`;
