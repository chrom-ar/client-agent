import { IAgentRuntime, Goal } from '@elizaos/core';
import { EXAMPLE_CONFIGS } from './config';
import { createExampleCDPGoal } from './cdp';
import { createExampleSingleChainGoal } from './singleChain';
import { createExampleMultiChainGoal } from './multiChain';

export const registerExampleGoal = async (runtime: IAgentRuntime, mode: string): Promise<void> => {
  const config = EXAMPLE_CONFIGS[mode];
  let goal: Goal;

  if (config.type === 'cdp') {
    goal = createExampleCDPGoal(runtime, mode);
  } else if (config.type === 'multi') {
    goal = createExampleMultiChainGoal(runtime, mode);
  } else {
    goal = createExampleSingleChainGoal(runtime, mode);
  }

  await runtime.databaseAdapter?.createGoal(goal);
};

export const getExampleGoalName = (mode: string): string => {
  return EXAMPLE_CONFIGS[mode]?.name || EXAMPLE_CONFIGS.transfer.name;
};
