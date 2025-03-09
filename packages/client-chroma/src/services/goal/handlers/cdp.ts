import { Goal, elizaLogger, generateText, ModelClass } from '@elizaos/core';
import { ChromaResponse, ChromaObjective } from '../../../types';
import { BaseGoalHandler } from './base';
import { generateOperationMessage, validateOperationResponse } from '../utils';
import { ChromaApiClient } from '../../../api';
import { ObjectiveStatus } from '../types';

export class CDPGoalHandler extends BaseGoalHandler {
  private apiClient?: ChromaApiClient;

  async initialize(runtime: any): Promise<void> {
    await super.initialize(runtime);
    const hostUrl = runtime.getSetting('CHROMA_HOST_URL');
    this.apiClient = new ChromaApiClient(hostUrl);
    await this.apiClient.initialize();
  }

  async supportsGoal(goal: Goal): Promise<boolean> {
    return goal.objectives.some(obj => obj.id === 'ask-for-wallet');
  }

  async processObjective(goal: Goal): Promise<void> {
    if (!goal.id) return;

    try {
      const pendingObjective = goal.objectives.find(obj => !obj.completed);
      if (!pendingObjective) {
        elizaLogger.info(`No pending objectives for goal ${goal.id}`);
        await this.completeGoal(goal);
        return;
      }

      elizaLogger.info(`Processing objective: ${pendingObjective.id} for goal: ${goal.name}`);

      let objectiveStatus = ObjectiveStatus.PENDING;
      switch (pendingObjective.id) {
        case 'ask-for-wallet':
          await this.handleAskForWallet(goal);
          objectiveStatus = this.getObjectiveStatus(goal, 'ask-for-wallet');
          break;
        case 'present-operation':
          await this.handleOperation(goal);
          objectiveStatus = this.getObjectiveStatus(goal, 'present-operation');
          break;
        case 'confirm-intent':
          await this.handleIntent(goal);
          objectiveStatus = this.getObjectiveStatus(goal, 'confirm-intent');
          break;
        case 'confirm-proposal':
          await this.handleConfirmProposal(goal);
          objectiveStatus = this.getObjectiveStatus(goal, 'confirm-proposal');
          break;
        default:
          elizaLogger.warn(`Unknown objective: ${pendingObjective.id}`);
          return;
      }

      // Only proceed to next objective if current one was completed
      if (objectiveStatus === ObjectiveStatus.COMPLETED) {
        const nextObjective = goal.objectives.find(obj => !obj.completed);
        if (nextObjective) {
          elizaLogger.info(`Moving to next objective: ${nextObjective.id}`);
          await this.processObjective(goal);
        }
      } else if (objectiveStatus === ObjectiveStatus.ABORTED) {
        elizaLogger.warn(`Objective ${pendingObjective.id} was aborted, stopping here`);
      } else {
        elizaLogger.info(`Objective ${pendingObjective.id} is still pending`);
      }
    } catch (error) {
      elizaLogger.error(`Error in processCryptoGoal for ${goal.id}:`, error);
      await this.failGoal(goal);
      throw error;
    }
  }

  private getObjectiveStatus(goal: Goal, objectiveId: string): ObjectiveStatus {
    const objective = goal.objectives.find(obj => obj.id === objectiveId) as ChromaObjective;
    if (!objective) return ObjectiveStatus.PENDING;

    if (objective.completed) return ObjectiveStatus.COMPLETED;
    if (objective.status === ObjectiveStatus.ABORTED) return ObjectiveStatus.ABORTED;
    return ObjectiveStatus.PENDING;
  }

  private async handleAskForWallet(goal: Goal): Promise<void> {
    elizaLogger.info('🔄 Starting wallet request sequence...');

    const result = await this.retryWithBackoff(
      async () => {
        const message = "Can you create me a wallet?";
        elizaLogger.info('🤖 Agent says:', message);

        const response = await this.sendMessage(message);
        elizaLogger.info('💬 Chroma replies:', response);

        // Time for faucet to get the funds
        await new Promise(resolve => setTimeout(resolve, 10000));

        // Look for an EVM address in the response
        const evmAddressRegex = /0x[a-fA-F0-9]{40}/;
        const hasEvmAddress = response.some(r => evmAddressRegex.test(r.text));

        if (hasEvmAddress) {
          elizaLogger.info('✅ Received wallet address');
          await this.completeObjective(goal, 'ask-for-wallet');

          await (new Promise(resolve => setTimeout(resolve, 10000)));
          return true;
        } else {
          throw new Error('No wallet address received in response');
        }
      },
      'Failed to get wallet address after multiple attempts'
    );

    if (!result) {
      const objective = goal.objectives.find(obj => obj.id === 'ask-for-wallet') as ChromaObjective;
      if (objective) {
        objective.status = ObjectiveStatus.ABORTED;
        await this.runtime?.databaseAdapter.updateGoal(goal);
      }
    }
  }

  private async handleOperation(goal: Goal): Promise<void> {
    elizaLogger.info('🔄 Starting operation presentation...');

    const operationMessage = await generateOperationMessage(goal, '', this.runtime);
    if (!operationMessage) return;

    const result = await this.retryWithBackoff(
      async () => {
        elizaLogger.info('🤖 Agent says:', operationMessage);
        const response = await this.sendMessage(operationMessage);
        elizaLogger.info('💬 Chroma replies:', response);

        const responseWithIntent = response.find(r => r.intent);
        if (!responseWithIntent) {
          throw new Error('No intent found in response');
        }

        const isValidIntent = await validateOperationResponse(goal, responseWithIntent, '', this.runtime);
        if (!isValidIntent) {
          throw new Error('Invalid intent received');
        }

        await this.storeResponse(goal, responseWithIntent);
        elizaLogger.info('✅ Operation presented successfully');
        await this.completeObjective(goal, 'present-operation');
        return true;
      },
      'Failed to complete operation after multiple attempts'
    );

    if (!result) {
      const objective = goal.objectives.find(obj => obj.id === 'present-operation') as ChromaObjective;
      if (objective) {
        objective.status = ObjectiveStatus.ABORTED;
        await this.runtime?.databaseAdapter.updateGoal(goal);
      }
    }
  }

  private async handleIntent(goal: Goal): Promise<void> {
    elizaLogger.info('🔄 Checking intent confirmation status...');

    const storedResponse = await this.getLatestResponse(goal);
    if (!storedResponse?.intent) {
      elizaLogger.warn('❌ No intent found in stored response');
      return;
    }

    const confirmContext = `# TASK: Generate a confirmation message for the intent.
Intent: ${JSON.stringify(storedResponse.intent, null, 2)}
Goal: ${goal.name}
Operation: ${goal.objectives.find(obj => obj.id === 'present-operation')?.description}
Objective: ${goal.objectives.find(obj => obj.id === 'confirm-intent')?.description}

Create a brief confirmation message that:
1. Confirms we want to proceed with this intent
2. Is direct and positive
3. Uses few words, preferably just "confirm" or "confirm intent"
4. Does not include additional explanations
5. Be lenient, if the operation is roughly correct, just confirm it

Generate only the confirmation message text.`;

    const confirmMessage = await generateText({
      runtime: this.runtime,
      context: confirmContext,
      modelClass: ModelClass.SMALL
    });

    const result = await this.retryWithBackoff(
      async () => {
        elizaLogger.info('🤖 Agent says:', confirmMessage);
        const response = await this.sendMessage(confirmMessage);
        elizaLogger.info('💬 Chroma replies:', response);

        const responseWithProposal = response.find(r => r.proposals);
        if (responseWithProposal) {
          await this.storeResponse(goal, responseWithProposal);
          elizaLogger.info('✅ Intent confirmed');
          await this.completeObjective(goal, 'confirm-intent');
          return true;
        } else {
          throw new Error('No proposals received in response');
        }
      },
      'Failed to confirm intent after multiple attempts'
    );

    if (!result) {
      const objective = goal.objectives.find(obj => obj.id === 'confirm-intent') as ChromaObjective;
      if (objective) {
        objective.status = ObjectiveStatus.ABORTED;
        await this.runtime?.databaseAdapter.updateGoal(goal);
      }
    }
  }

  private async handleConfirmProposal(goal: Goal): Promise<void> {
    elizaLogger.info('🔄 Starting proposal confirmation...');

    const result = await this.retryWithBackoff(
      async () => {
        const storedResponse = await this.getLatestResponse(goal);

        if (!storedResponse?.proposals) {
          elizaLogger.info('⏳ No proposals found, asking for one...');
          const message = "Can you show me the proposal options?";
          const responses = await this.sendMessage(message);
          elizaLogger.info('💬 Chroma replies:', responses);

          // Find first response with proposals and store it
          const responseWithProposal = responses.find(r => r.proposals);
          if (responseWithProposal) {
            await this.storeResponse(goal, responseWithProposal);
          } else {
            throw new Error('No proposals received in any response');
          }
        }

        // Always select the first proposal for now
        const message = "Yes, confirm proposal number 1";
        elizaLogger.info('🤖 Agent says:', message);

        const responses = await this.sendMessage(message);
        elizaLogger.info('💬 Chroma replies:', responses);

        // Store only responses that have a proposal or indicate success
        const lastMeaningfulResponse = responses.reverse().find(r =>
          r.proposals ||
          r.text.toLowerCase().includes('confirmed') ||
          r.text.toLowerCase().includes('success') ||
          r.text.toLowerCase().includes('completed')
        );

        if (lastMeaningfulResponse) {
          await this.storeResponse(goal, lastMeaningfulResponse);
        }

        // Check if any response indicates success
        const isSuccess = responses.some(r =>
          r.text.toLowerCase().includes('confirmed') ||
          r.text.toLowerCase().includes('success') ||
          r.text.toLowerCase().includes('completed')
        );

        if (isSuccess) {
          elizaLogger.info('✅ Proposal confirmed successfully');
          await this.completeObjective(goal, 'confirm-proposal');
          await this.completeGoal(goal);
          return true;
        } else {
          throw new Error('Proposal confirmation failed');
        }
      },
      'Failed to confirm proposal after multiple attempts'
    );

    if (!result) {
      const objective = goal.objectives.find(obj => obj.id === 'confirm-proposal') as ChromaObjective;
      if (objective) {
        objective.status = ObjectiveStatus.ABORTED;
        await this.runtime?.databaseAdapter.updateGoal(goal);
      }
    }
  }

  private async sendMessage(text: string): Promise<ChromaResponse[]> {
    if (!this.apiClient) {
      throw new Error('Service not initialized');
    }

    const responses = await this.apiClient.sendMessage(text);
    return responses;
  }
}