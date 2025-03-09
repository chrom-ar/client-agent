import { Client, IAgentRuntime, elizaLogger, GoalStatus } from '@elizaos/core';
import { createGoalAction } from './actions';
import { ChromaService } from './services';
import { getExampleGoalName, registerExampleGoal } from './examples';

export class ChromaClientImpl {
  private runtime: IAgentRuntime;
  private chromaService: ChromaService;

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
    this.chromaService = new ChromaService();
  }

  async start() {
    // Register actions
    this.runtime.registerAction(createGoalAction);

    await this.chromaService.initialize(this.runtime);

    this.runtime.registerService(this.chromaService);
  }

  async stop() {
    elizaLogger.warn('ChromaClient stop is not yet implemented');
  }
}

export const ChromaClient: Client = {
  name: 'ChromaClient',
  start: async (runtime: IAgentRuntime) => {
    elizaLogger.log('Starting Chroma client...');

    const client = new ChromaClientImpl(runtime);
    await client.start();

    if (runtime.getSetting('CHROMA_EXAMPLE_MODE')) {
      const exampleMode = runtime.getSetting('CHROMA_EXAMPLE_MODE');
      const goals = await runtime.databaseAdapter?.getGoals({
        agentId: runtime.agentId,
        roomId: runtime.agentId,
        onlyInProgress: true
      });

      const isInProgressGoals = goals.filter(goal => goal.status === GoalStatus.IN_PROGRESS);
      const hasMatchingGoal = isInProgressGoals.some(goal => goal.name.includes(getExampleGoalName(exampleMode)));

      if (!isInProgressGoals.length || !hasMatchingGoal) {
        await registerExampleGoal(runtime, exampleMode);
      }
    }

    elizaLogger.success(
      `✅ Chroma client successfully started for character ${runtime.character.name}`
    );
    return client;
  },
};
