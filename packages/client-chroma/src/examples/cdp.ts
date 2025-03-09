import { IAgentRuntime, Goal, GoalStatus, stringToUuid } from '@elizaos/core';
import { EXAMPLE_CONFIGS } from './config';

export const createExampleCDPGoal = (runtime: IAgentRuntime, mode: string): Goal => {
  const config = EXAMPLE_CONFIGS[mode] || EXAMPLE_CONFIGS.transfer;

  return {
    id: stringToUuid(`${runtime.character.id}-example-goal-${Date.now()}`),
    name: config.name,
    status: GoalStatus.IN_PROGRESS,
    roomId: runtime.character.id,
    userId: runtime.character.id,
    objectives: [
      {
        id: 'ask-for-wallet',
        description: "Ask the agent for a new wallet",
        completed: false
      },
      {
        id: 'present-operation',
        description: config.operation,
        completed: false
      },
      {
        id: 'confirm-intent',
        description: "Confirm user intent to proceed with transfer",
        completed: false
      },
      {
        id: 'confirm-proposal',
        description: "Confirm the transaction proposal",
        completed: false
      }
    ]
  };
};
