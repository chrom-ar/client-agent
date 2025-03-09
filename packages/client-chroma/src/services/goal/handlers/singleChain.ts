import { Goal, elizaLogger, generateText, ModelClass } from '@elizaos/core';
import { ChromaResponse, TransactionProposal, ChromaObjective } from '../../../types';
import { BaseGoalHandler } from './base';
import { generateOperationMessage, validateOperationResponse, validateIntroResponse } from '../utils';
import { ChromaApiClient } from '../../../api';
import { SignatureHandlerInterface } from '../../signatures/types';
import { EVMSignatureHandler } from '../../signatures/evm';
import { SolanaSignatureHandler } from '../../signatures/solana';
import { ChainAccount } from '../../signatures/types';
import { ObjectiveStatus } from '../types';

export class SingleChainGoalHandler extends BaseGoalHandler {
  private apiClient?: ChromaApiClient;
  private signatureHandlers: SignatureHandlerInterface[] = [];

  async initialize(runtime: any): Promise<void> {
    await super.initialize(runtime);
    const hostUrl = runtime.getSetting('CHROMA_HOST_URL');
    this.apiClient = new ChromaApiClient(hostUrl);
    await this.apiClient.initialize();

    // Initialize signature handlers
    const evmHandler = new EVMSignatureHandler(runtime);
    const solanaHandler = new SolanaSignatureHandler(runtime);

    await evmHandler.initialize(runtime);
    await solanaHandler.initialize(runtime);

    this.signatureHandlers = [evmHandler, solanaHandler];
  }

  async supportsGoal(goal: Goal): Promise<boolean> {
    return goal.objectives.some(obj => obj.id === 'introduce-agent' && !goal.objectives.some(obj => obj.id.includes('chain')));
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
        case 'introduce-agent':
          await this.handleIntroduction(goal);
          objectiveStatus = this.getObjectiveStatus(goal, 'introduce-agent');
          break;
        case 'present-operation':
          await this.handleOperation(goal);
          objectiveStatus = this.getObjectiveStatus(goal, 'present-operation');
          break;
        case 'confirm-intent':
          await this.handleIntent(goal);
          objectiveStatus = this.getObjectiveStatus(goal, 'confirm-intent');
          break;
        case 'process-proposal':
          await this.handleProposal(goal);
          objectiveStatus = this.getObjectiveStatus(goal, 'process-proposal');
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

  private async handleIntroduction(goal: Goal): Promise<void> {
    elizaLogger.info('🔄 Starting introduction sequence...');

    const result = await this.retryWithBackoff(
      async () => {
        const accounts = await this.getAvailableAccounts();
        const chainDetailsText = this.getChainDetailsText(accounts);

        const introContext = `# TASK: You need to perform a crypto operation. Generate an introduction message for this.
${chainDetailsText}

The message should:
1. Be concise and clear
2. Specify the available wallet address(es)
3. Specify the preferred chain(s), putting the word "chain" in the message
4. Be concise and clear, use only plain text, express in as few words as possible
5. Do not put any "recommendations" like "be sure your wallet is connected" or "be sure you have enough funds"
6. Talk in first person, you are the one who needs to perform the operation
7. If both chains are available, mention both addresses but keep it concise

Generate only the message text, no additional formatting.`;

        const introMessage = await generateText({
          runtime: this.runtime,
          context: introContext,
          modelClass: ModelClass.SMALL
        });

        elizaLogger.info('🤖 Agent says:', introMessage);
        const response = await this.sendMessage(introMessage);
        elizaLogger.info('💬 Chroma replies:', response);

        elizaLogger.info('🔄 Validating introduction response...');
        const isIntroductionValid = await validateIntroResponse(response, this.runtime);
        elizaLogger.info(`🔄 Introduction validation result: ${isIntroductionValid}`);

        if (isIntroductionValid) {
          elizaLogger.info('✅ Introduction successful');
          await this.completeObjective(goal, 'introduce-agent');
          return true;
        } else {
          elizaLogger.warn('❌ Introduction validation failed');
          throw new Error('Introduction validation failed');
        }
      },
      'Failed to complete introduction after multiple attempts'
    );

    if (!result) {
      const objective = goal.objectives.find(obj => obj.id === 'introduce-agent') as ChromaObjective;
      if (objective) {
        objective.status = ObjectiveStatus.ABORTED;
        await this.runtime?.databaseAdapter.updateGoal(goal);
      }
    }
  }

  private async handleOperation(goal: Goal): Promise<void> {
    elizaLogger.info('🔄 Starting operation presentation...');

    const result = await this.retryWithBackoff(
      async () => {
        const accounts = await this.getAvailableAccounts();
        const chainDetailsText = this.getChainDetailsText(accounts);
        const operationMessage = await generateOperationMessage(goal, chainDetailsText, this.runtime);
        if (!operationMessage) return false;

        elizaLogger.info('🤖 Agent says:', operationMessage);
        const response = await this.sendMessage(operationMessage);
        elizaLogger.info('💬 Chroma replies:', response);

        const responseWithIntent = response.find(r => r.intent);
        if (!responseWithIntent) {
          throw new Error('No intent found in response');
        }

        const isValidIntent = await validateOperationResponse(goal, responseWithIntent, chainDetailsText, this.runtime);
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
Objective: ${goal.objectives.find(obj => obj.id === 'confirm-intent')?.description}

Create a brief confirmation message that:
1. Confirms we want to proceed with this intent, preferably using the word "confirm"
2. Is direct and positive
3. Uses very few words (less than 5 preferred), something like "confirm" or "confirm intent"
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

        const responseWithProposal = response.find(r => {
          // Check for multiple proposals
          return Array.isArray(r.proposals) && r.proposals.length > 0;
        });

        if (responseWithProposal) {
          await this.storeResponse(goal, responseWithProposal);
          elizaLogger.info('✅ Intent confirmed and received proposal');
          await this.completeObjective(goal, 'confirm-intent');
          return true;
        } else {
          elizaLogger.warn('❌ No proposal received after confirmation');
          throw new Error('No proposal received after confirmation');
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

  private async handleProposal(goal: Goal): Promise<void> {
    elizaLogger.info('🔄 Starting proposal processing...');

    const storedResponse = await this.getLatestResponse(goal);
    if (!storedResponse?.proposals) {
      elizaLogger.warn('❌ No stored proposal found');
      return;
    }

    const result = await this.retryWithBackoff(
      async () => {
        elizaLogger.info(`Processing proposal: ${JSON.stringify(storedResponse.proposals)}`);
        // TODO: Handle multiple proposals
        const result = await this.signProposal(storedResponse.proposals[0]);
        if (Array.isArray(result)) {
          elizaLogger.success(`Multiple transactions confirmed with hashes: ${result.join(', ')}`);
        } else {
          elizaLogger.success(`Transaction confirmed with hash: ${result}`);
        }

        elizaLogger.info('✅ All transactions processed successfully');
        await this.completeObjective(goal, 'process-proposal');
        await this.completeGoal(goal);
        return true;
      },
      'Failed to process transactions'
    );

    if (!result) {
      const objective = goal.objectives.find(obj => obj.id === 'process-proposal') as ChromaObjective;
      if (objective) {
        objective.status = ObjectiveStatus.ABORTED;
        await this.runtime?.databaseAdapter.updateGoal(goal);
      }
    }
  }

  private ensureChainId(proposal: TransactionProposal): TransactionProposal {
    const chainIds = {
      'evm': 1,
      'solana': 1,
      'eth-sepolia': 11155111,
      'sepolia': 11155111,
      'optimism-sepolia': 11155420,
      'opt-sepolia': 11155420,
      'arbitrum-sepolia': 421614,
      'arb-sepolia': 421614,
      'base-sepolia': 84532,
      'ethereum': 1,
      'optimism': 10,
      'arbitrum': 42161,
      'base': 8453
    };

    if (proposal.chainId) {
      return proposal;
    }

    // TODO: Handle this in a better way
    // @ts-ignore
    if (proposal.fromChain) {
      // @ts-ignore
      proposal.chainId = chainIds[proposal.fromChain];
    } else if (proposal.transactions) {
      // @ts-ignore
      proposal.chainId = proposal.transactions[0]?.chainId;
    }

    return proposal;
  }

  private async signProposal(proposal: TransactionProposal): Promise<string | string[]> {
    const handler = this.getSignatureHandler(proposal);
    return handler.signProposal(this.ensureChainId(proposal));
  }

  private getSignatureHandler(proposal: TransactionProposal): SignatureHandlerInterface {
    const handler = this.signatureHandlers.find(h => h.supportsChain(proposal));
    if (!handler) {
      throw new Error('No signature handler found for chain');
    }
    return handler;
  }

  private async getAvailableAccounts(): Promise<{ evmAccount?: ChainAccount; solanaAccount?: ChainAccount }> {
    let evmAccount: ChainAccount | undefined;
    let solanaAccount: ChainAccount | undefined;

    try {
      const evmHandler = this.signatureHandlers.find(h => h instanceof EVMSignatureHandler) as EVMSignatureHandler;
      if (evmHandler) {
        evmAccount = await evmHandler.getAccount('evm');
      }
    } catch (error) {
      elizaLogger.debug('EVM account not available:', error);
    }

    try {
      const solanaHandler = this.signatureHandlers.find(h => h instanceof SolanaSignatureHandler);
      if (solanaHandler) {
        solanaAccount = await solanaHandler.getAccount('solana');
      }
    } catch (error) {
      elizaLogger.debug('Solana account not available:', error);
    }

    return { evmAccount, solanaAccount };
  }

  private getChainDetailsText(accounts: { evmAccount?: ChainAccount; solanaAccount?: ChainAccount }): string {
    return `Available chains and addresses (use only what's needed for the operation):
${accounts.evmAccount ? `- Option 1: ${accounts.evmAccount.chains.join(', ')} with address ${accounts.evmAccount.address}` : ''}
${accounts.solanaAccount ? `- Option 2: Solana with address ${accounts.solanaAccount.address}` : ''}

- Select the appropriate chain based on the operation requirements.
- Do not mention chains or addresses that aren't relevant to the specific operation.
- Use ethereum if no chain is mentioned and seems an evm chain operation.
`;
  }

  private async sendMessage(text: string): Promise<ChromaResponse[]> {
    if (!this.apiClient) {
      throw new Error('Service not initialized');
    }

    const responses = await this.apiClient.sendMessage(text);
    return responses;
  }
}
