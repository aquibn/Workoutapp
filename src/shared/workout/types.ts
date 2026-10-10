export type WorkoutStage = 'welcome' | 'preview' | 'active' | 'checkin' | 'recap';
export type IntervalKind = 'opening' | 'activity' | 'recovery' | 'finish';
export type IntervalStatus = 'pending' | 'active' | 'completed' | 'skipped' | 'removed';
export type EnergyProfile = 'low-energy' | 'steady' | 'high-energy';
export type ActivityLabel = 'Tempo squat' | 'Standing reach';

export interface WorkoutInterval {
  id: string;
  kind: IntervalKind;
  label: string;
  activityLabel?: ActivityLabel;
  durationSeconds: number;
  status: IntervalStatus;
  startedAt?: number;
  completedAt?: number;
}

export type ProposalIntent = 'keep' | 'ease' | 'push' | 'shorten';
export type SuggestionIntent = 'ease' | 'push';

export interface WorkoutProposal {
  intent: ProposalIntent;
  seconds?: number;
  revision: number;
  sessionId?: string;
}

export type WorkoutActionKind =
  | 'start-session'
  | 'start-interval'
  | 'complete-interval'
  | 'skip-interval'
  | 'end-session'
  | 'restart'
  | 'adaptation'
  | 'effort'
  | 'suggestion';

export interface WorkoutActionRecord {
  action: WorkoutActionKind;
  intervalId?: string;
  source: 'user' | 'timer' | 'auto' | 'batch' | 'model';
  at: string;
  details?: string;
}

export interface AdaptationRecord {
  intent: ProposalIntent;
  summary: string;
  appliedAt: string;
  revision: number;
}

// A 1-5 rating of how hard a main slot felt, given at the check-in after its recovery.
export interface EffortRecord {
  slot: number;
  score: number;
  at: string;
}

export interface WorkoutSession {
  sessionId: string;
  revision: number;
  profile: EnergyProfile;
  stage: WorkoutStage;
  intervals: WorkoutInterval[];
  activeIntervalId: string | null;
  adaptationHistory: AdaptationRecord[];
  actionHistory?: WorkoutActionRecord[];
  completionMode?: 'completed' | 'batch-simulated' | 'ended-early';
  efforts?: EffortRecord[];
  // A change the coach suggested at a check-in; it applies only if the user accepts it.
  suggestion?: { intent: SuggestionIntent };
  startedAt: string | null;
  endedAt: string | null;
}

export interface WorkoutRecapSummary {
  totalPlannedSeconds: number;
  simulatedSecondsCompleted: number;
  completedCount: number;
  skippedCount: number;
  removedCount: number;
  totalIntervals: number;
  adaptationsApplied: string[];
}
