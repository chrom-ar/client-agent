import { Goal, IAgentRuntime, elizaLogger, GoalStatus } from '@elizaos/core';
import { ChromaResponse } from '../../../types';
import { GoalHandlerInterface, GoalState } from '../types';
import { CONSTANTS, retryWithBackoff } from '../utils';

export abstract class BaseGoalHandler implements GoalHandlerInterface {
  protected runtime: IAgentRuntime;
  protected state: GoalState = {
    processingGoals: new Set(),
    goalResponses: new Map(),
    cryptoGoalCache: new Map()
  };

  constructor() {
    this.state = {
      processingGoals: new Set(),
      goalResponses: new Map(),
      cryptoGoalCache: new Map()
    };
  }

  async initialize(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
  }

  abstract processObjective(goal: Goal): Promise<void>;
  abstract supportsGoal(goal: Goal): Promise<boolean>;

  getLatestResponse(goal: Goal): ChromaResponse | undefined {
    if (!goal.id) return undefined;
    return this.state.goalResponses.get(goal.id);
  }

  storeResponse(goal: Goal, response: ChromaResponse): void {
    if (!goal.id) return;
    elizaLogger.info(`💾 Storing response for goal ${goal.id}:`, response);
    this.state.goalResponses.set(goal.id, response);
  }

  clearState(goalId: string): void {
    elizaLogger.info(`🧹 Clearing processing state for goal ${goalId}`);
    this.state.processingGoals.delete(goalId);
    this.state.goalResponses.delete(goalId);
    this.state.cryptoGoalCache.delete(goalId);
  }

  protected async completeObjective(goal: Goal, objectiveId: string): Promise<void> {
    const objective = goal.objectives.find(o => o.id === objectiveId);
    if (objective) {
      objective.completed = true;
      await this.runtime?.databaseAdapter.updateGoal(goal);
      elizaLogger.info(`✅ Completed objective: ${objectiveId}`);
    }
  }

  protected async completeGoal(goal: Goal): Promise<void> {
    if (!goal.id) return;

    this.state.goalResponses.delete(goal.id);
    elizaLogger.debug(`🧹 Cleaned up stored response for goal ${goal.id}`);

    await this.runtime?.databaseAdapter.updateGoalStatus({
      goalId: goal.id,
      status: GoalStatus.DONE
    });
  }

  protected async failGoal(goal: Goal): Promise<void> {
    if (!goal.id) return;

    this.state.goalResponses.delete(goal.id);
    elizaLogger.debug(`🧹 Cleaned up stored response for goal ${goal.id}`);

    await this.runtime?.databaseAdapter.updateGoalStatus({
      goalId: goal.id,
      status: GoalStatus.FAILED
    });
  }

  protected async retryWithBackoff<T>(
    operation: () => Promise<T>,
    errorMessage: string
  ): Promise<T | null> {
    return retryWithBackoff(
      operation,
      { maxRetries: CONSTANTS.MAX_RETRIES, currentAttempt: 0 },
      errorMessage,
      this.runtime
    );
  }
}