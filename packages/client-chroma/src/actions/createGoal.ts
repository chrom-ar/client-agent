import { Action } from '@elizaos/core';
import { elizaLogger } from '@elizaos/core';
import { Goal, GoalStatus } from '@elizaos/core';
import { stringToUuid } from '@elizaos/core';

export const createGoalAction: Action = {
  name: 'CREATE_CHROMA_GOAL',
  similes: ['START_CHROMA', 'BEGIN_CHROMA'],
  description: 'Creates a new goal for a Chroma operation',
  handler: async (runtime, message, state) => {
    elizaLogger.log('Creating Chroma goal...');

    try {
      const goal: Goal = {
        id: stringToUuid(`${message.id}-chroma-goal-${Date.now()}`),
        name: "Chroma Operation",
        status: GoalStatus.IN_PROGRESS,
        roomId: message.userId,
        userId: message.userId,
        objectives: [
          {
            id: 'introduce-agent',
            description: "Introduce agent, with wallet data and chain preferences",
            completed: false
          },
          {
            id: 'present-operation',
            description: message.content.text,
            completed: false
          },
          {
            id: 'confirm-intent',
            description: "Confirm user intent to proceed with transfer",
            completed: false
          },
          {
            id: 'process-proposal',
            description: "Process transaction proposal",
            completed: false
          }
        ]
      };

      await runtime.databaseAdapter?.createGoal(goal);
      elizaLogger.success('Successfully created Chroma goal');
      return true;
    } catch (error) {
      elizaLogger.error(`Error creating Chroma goal: ${error}`);
      return false;
    }
  },
  validate: async (runtime) => {
    const hostUrl = runtime.getSetting('CHROMA_HOST_URL');
    return !!hostUrl;
  },
  examples: [
    [
      {
        user: '{{user1}}',
        content: {
          text: 'I want to transfer 0.5 ETH to 0x742d35Cc6634C0532925a3b844Bc454e4438f44e'
        }
      },
      {
        user: '{{agent}}',
        content: {
          text: 'I understand you want to transfer ETH. Let me help you with that.',
          action: 'CREATE_CHROMA_GOAL'
        }
      }
    ],
    [
      {
        user: '{{user1}}',
        content: {
          text: 'Can you help me swap 2 ETH for USDC on Uniswap?'
        }
      },
      {
        user: '{{agent}}',
        content: {
          text: 'I can help you swap ETH for USDC. Let me assist you with that.',
          action: 'CREATE_CHROMA_GOAL'
        }
      }
    ],
    [
      {
        user: '{{user1}}',
        content: {
          text: 'How is it going?'
        }
      },
      {
        user: '{{agent}}',
        content: {
          text: 'Great! What can I help you with?'
        }
      }
    ]
  ]
};