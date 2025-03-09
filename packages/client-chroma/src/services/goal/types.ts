import { Goal, IAgentRuntime } from '@elizaos/core';
import { ChromaResponse, TransactionProposal } from '../../types';

export interface RetryOptions {
  maxRetries: number;
  currentAttempt: number;
}

export enum ObjectiveStatus {
  PENDING = 'pending',
  COMPLETED = 'completed',
  ABORTED = 'aborted'
}

export interface GoalHandlerInterface {
  initialize(runtime: IAgentRuntime): Promise<void>;
  processObjective(goal: Goal): Promise<void>;
  supportsGoal(goal: Goal): Promise<boolean>;
  getLatestResponse(goal: Goal): ChromaResponse | undefined;
  storeResponse(goal: Goal, response: ChromaResponse): void;
  clearState(goalId: string): void;
}

export interface GoalState {
  processingGoals: Set<string>;
  goalResponses: Map<string, ChromaResponse>;
  cryptoGoalCache: Map<string, boolean>;
}

export interface GoalConstants {
  MAX_RETRIES: number;
  RETRY_DELAY_MS: number;
  INTENT_CONFIRMATION_TIMEOUT: number;
  GOAL_CHECK_INTERVAL: number;
}

export interface SignedTransactionResult {
  hash: string;
  proposals?: TransactionProposal[];
}