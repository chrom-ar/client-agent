import { IAgentRuntime, Goal, GoalStatus, stringToUuid } from '@elizaos/core';
import { EXAMPLE_CONFIGS } from './config';

export const createExampleMultiChainGoal = (runtime: IAgentRuntime, mode: string): Goal => {
  const config = EXAMPLE_CONFIGS[mode] || EXAMPLE_CONFIGS.find_best_yield;

  return {
    id: stringToUuid(`${runtime.character.id}-example-goal-${Date.now()}`),
    name: config.name,
    status: GoalStatus.IN_PROGRESS,
    roomId: runtime.character.id,
    userId: runtime.character.id,
    objectives: [
      {
        id: 'introduce-agent',
        description: "Introduce agent, with wallet data and chain preferences",
        completed: false
      },
      {
        id: 'present-operation',
        description: config.operation,
        completed: false
      },
      {
        id: 'confirm-intent',
        description: `Confirm user intent to proceed with operation (${config.operation})`,
        completed: false
      },
      {
        id: 'process-proposal',
        description: `Process transaction proposal (${config.operation})`,
        completed: false
      },
      {
        id: 'present-bridge-operation-chain-a',
        description: 'Bridge all USDC from Optimism Sepolia to Arbitrum Sepolia',
        completed: false
      },
      {
        id: 'confirm-intent-bridge-chain-a',
        description: "Confirm user intent to proceed with operation",
        completed: false
      },
      {
        id: 'process-proposal-bridge-chain-a',
        description: "Process transaction proposal",
        completed: false
      },
      {
        id: 'wait-for-chain-b-confirmation',
        description: "Wait for chain B confirmation",
        completed: false
      },
      {
        id: 'present-deposit-operation-chain-b',
        description: 'Deposit all USDC to Arbitrum Sepolia',
        completed: false
      },
      {
        id: 'confirm-intent-deposit-chain-b',
        description: "Confirm user intent to proceed with operation",
        completed: false
      },
      {
        id: 'process-proposal-deposit-chain-b',
        description: "Process transaction proposal",
        completed: false
      }
    ]
  };
};
