import {
    elizaLogger,
    Goal,
    generateText,
    generateObject,
    generateTrueOrFalse,
    ModelClass
} from '@elizaos/core';
import { z } from 'zod';
import { ChromaResponse, TransactionProposal, ChromaObjective } from '../../../types';
import { BaseGoalHandler } from './base';
import { validateOperationResponse } from '../utils';
import { EVMSignatureHandler } from '../../signatures/evm';
import { SolanaSignatureHandler } from '../../signatures/solana';
import { ChainAccount } from '../../signatures/types';
import { ObjectiveStatus } from '../types';
import { generateOperationMessage, validateIntroResponse } from '../utils';
import { ChromaApiClient } from '../../../api';
import { SignatureHandlerInterface } from '../../signatures/types';

export class MultiChainGoalHandler extends BaseGoalHandler {
  private apiClient?: ChromaApiClient;
  private signatureHandlers: SignatureHandlerInterface[] = [];
  private MAX_BRIDGE_WAIT_TIME_MS = 40 * 60 * 1000; // 40 minutes
  private BRIDGE_INITIAL_CHECK_INTERVAL_MS = 10 * 1000; // 10 seconds

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
    return goal.objectives.some(obj => obj.id === 'introduce-agent' && goal.objectives.some(obj => obj.id.includes('chain')));
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
          await this.handleIntent(goal, 'confirm-intent');
          objectiveStatus = this.getObjectiveStatus(goal, 'confirm-intent');
          break;
        case 'process-proposal':
          await this.handleProposal(goal, 'process-proposal');
          objectiveStatus = this.getObjectiveStatus(goal, 'process-proposal');
          break;
        case 'present-bridge-operation-chain-a':
          await this.handleBridgeOperation(goal);
          objectiveStatus = this.getObjectiveStatus(goal, 'present-bridge-operation-chain-a');
          break;
        case 'confirm-intent-bridge-chain-a':
          await this.handleIntent(goal, 'confirm-intent-bridge-chain-a');
          objectiveStatus = this.getObjectiveStatus(goal, 'confirm-intent-bridge-chain-a');
          break;
        case 'process-proposal-bridge-chain-a':
          await this.handleProposal(goal, 'process-proposal-bridge-chain-a');
          objectiveStatus = this.getObjectiveStatus(goal, 'process-proposal-bridge-chain-a');
          break;
        case 'wait-for-chain-b-confirmation':
          await this.handleBridgeConfirmation(goal);
          objectiveStatus = this.getObjectiveStatus(goal, 'wait-for-chain-b-confirmation');
          break;
        case 'present-deposit-operation-chain-b':
          await this.handleDepositOperation(goal);
          objectiveStatus = this.getObjectiveStatus(goal, 'present-deposit-operation-chain-b');
          break;
        case 'confirm-intent-deposit-chain-b':
          await this.handleIntent(goal, 'confirm-intent-deposit-chain-b');
          objectiveStatus = this.getObjectiveStatus(goal, 'confirm-intent-deposit-chain-b');
          break;
        case 'process-proposal-deposit-chain-b':
          await this.handleProposal(goal, 'process-proposal-deposit-chain-b');
          objectiveStatus = this.getObjectiveStatus(goal, 'process-proposal-deposit-chain-b');
          break;
        default:
          elizaLogger.warn(`Unsupported objective: ${pendingObjective.id}`);
          objectiveStatus = ObjectiveStatus.ABORTED;
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
    elizaLogger.info('🔄 Starting find best yield operation...');

    const result = await this.retryWithBackoff(
      async () => {
        const accounts = await this.getAvailableAccounts();
        const chainDetailsText = this.getChainDetailsText(accounts);
        const operationMessage = await generateOperationMessage(goal, chainDetailsText, this.runtime);
        if (!operationMessage) return false;

        elizaLogger.info('🤖 Agent says:', operationMessage);
        const response = await this.sendMessage(operationMessage);
        elizaLogger.info('💬 Chroma replies:', response);

        // Check for intent in the response
        const responseWithIntent = response.find(r => r.intent);
        if (responseWithIntent) {
          await this.storeResponse(goal, responseWithIntent);
          elizaLogger.info('✅ Operation presented successfully with intent');
          await this.completeObjective(goal, 'present-operation');
          return true;
        }

        // Store the text response if no intent
        const responseWithText = response.find(r => r.text);
        if (responseWithText) {
          await this.storeResponse(goal, responseWithText);
        }

        // Check if current yield is the best
        const shouldSkipRemaining = await this.shouldSkipRemainingObjectives(response);

        if (shouldSkipRemaining) {
          // Mark all remaining objectives as completed
          elizaLogger.info('✅ Current yield is already the best, skipping remaining objectives');
          for (const objective of goal.objectives) {
            if (!objective.completed) {
              objective.completed = true;
            }
          }
          await this.runtime?.databaseAdapter.updateGoal(goal);
          return true;
        } else {
          // Continue with the normal flow
          elizaLogger.info('✅ Operation presented successfully, continuing with flow');
          await this.completeObjective(goal, 'present-operation');
          return true;
        }
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

  private async shouldSkipRemainingObjectives(response: ChromaResponse[]): Promise<boolean> {
    const responseText = response.map(r => r.text).join('\n');

    const decisionPrompt = `# TASK: Determine if we should continue with the multi-chain operation.

The agent response to our request to find the best yield is:
"""
${responseText}
"""

Based on this response, determine if we should proceed with moving funds between chains:

1. If ALL funds are ALREADY on the chain with the best yield rate, answer "true" to skip remaining objectives.
2. If funds are SPLIT across MULTIPLE chains and there's a suggestion to move/consolidate funds, answer "false" to continue with the objectives.
3. If ANY funds exist on a chain with LOWER yield than another chain, answer "false" to continue with the objectives.
4. If the response explicitly suggests moving funds from one chain to another, answer "false" to continue with the objectives.
5. If funds exist on multiple chains, but are NOT on the chain with the best yield, answer "false" to continue with the objectives.

Look carefully for phrases like:
- "Consider moving all your funds to X"
- "You have funds in X with lower rates"
- "You currently have funds deposited here" appearing multiple times
- Any comparison showing different yield rates across chains where your funds are deposited

Answer with "true" ONLY if no action is needed because all funds are already on the chain with the highest yield rate.
Answer with "false" if ANY action is suggested or if funds should be moved between chains.`;

    return generateTrueOrFalse({
      runtime: this.runtime,
      context: decisionPrompt,
      modelClass: ModelClass.SMALL
    });
  }

  private async handleBridgeOperation(goal: Goal): Promise<void> {
    elizaLogger.info('🔄 Starting bridge operation...');

    const result = await this.retryWithBackoff(
      async () => {
        let response: ChromaResponse[] = [];

        // Check balance on Optimism Sepolia
        const balanceQuery = "What's my balance on Optimism Sepolia?";
        elizaLogger.info('🤖 Agent says:', balanceQuery);
        const balanceResponse = await this.sendMessage(balanceQuery);
        elizaLogger.info('💬 Chroma replies balance:', balanceResponse);

        // Extract token amounts from the balance response
        const tokenAmounts = await this.extractTokenAmounts(balanceResponse);
        const usdcAmount = tokenAmounts.tokenAmount;

        if (!usdcAmount) {
          throw new Error('Failed to extract USDC amount from balance response');
        }

        // Generate bridge operation message with extracted amount
        const bridgeMessage = `Bridge ${usdcAmount} USDC from Optimism Sepolia to Arbitrum Sepolia`;
        elizaLogger.info('🤖 Agent says:', bridgeMessage);
        response = await this.sendMessage(bridgeMessage);
        elizaLogger.info('💬 Chroma replies bridge:', response);

        const responseWithIntent = response.find(r => r.intent);
        if (!responseWithIntent) {
          throw new Error('No intent found in bridge response');
        }

        const accounts = await this.getAvailableAccounts();
        const chainDetailsText = this.getChainDetailsText(accounts);
        const isValidIntent = await validateOperationResponse(goal, responseWithIntent, chainDetailsText, this.runtime);
        if (!isValidIntent) {
          throw new Error('Invalid intent received for bridge');
        }

        await this.storeResponse(goal, responseWithIntent);
        elizaLogger.info('✅ Bridge operation presented successfully');
        await this.completeObjective(goal, 'present-bridge-operation-chain-a');
        return true;
      },
      'Failed to complete bridge operation after multiple attempts'
    );

    if (!result) {
      const objective = goal.objectives.find(obj => obj.id === 'present-bridge-operation-chain-a') as ChromaObjective;
      if (objective) {
        objective.status = ObjectiveStatus.ABORTED;
        await this.runtime?.databaseAdapter.updateGoal(goal);
      }
    }
  }

  private async handleIntent(goal: Goal, objectiveId: string): Promise<void> {
    elizaLogger.info(`🔄 Checking intent confirmation status for ${objectiveId}...`);

    const storedResponse = await this.getLatestResponse(goal);
    if (!storedResponse?.intent) {
      elizaLogger.warn('❌ No intent found in stored response');
      return;
    }

    const confirmContext = `# TASK: Generate a confirmation message for the intent.
Intent: ${JSON.stringify(storedResponse.intent, null, 2)}
Goal: ${goal.name}
Objective: ${goal.objectives.find(obj => obj.id === objectiveId)?.description}

Create a brief confirmation message that:
1. Confirms we want to proceed with this intent, preferably using the word "confirm"
2. Is direct and positive
3. Uses very few words, preferably just "confirm" or "confirm intent"
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
          await this.completeObjective(goal, objectiveId);
          return true;
        } else {
          elizaLogger.warn('❌ No proposal received after confirmation');
          throw new Error('No proposal received after confirmation');
        }
      },
      'Failed to confirm intent after multiple attempts'
    );

    if (!result) {
      const objective = goal.objectives.find(obj => obj.id === objectiveId) as ChromaObjective;
      if (objective) {
        objective.status = ObjectiveStatus.ABORTED;
        await this.runtime?.databaseAdapter.updateGoal(goal);
      }
    }
  }

  private async handleProposal(goal: Goal, objectiveId: string): Promise<void> {
    elizaLogger.info(`🔄 Starting proposal processing for ${objectiveId}...`);

    const storedResponse = await this.getLatestResponse(goal);
    if (!storedResponse?.proposals) {
      elizaLogger.warn('❌ No stored proposal found');
      return;
    }

    const result = await this.retryWithBackoff(
      async () => {
        elizaLogger.info(`Processing proposal: ${JSON.stringify(storedResponse.proposals)}`);
        // Handle multiple proposals
        const result = await this.signProposal(storedResponse.proposals[0]);
        if (Array.isArray(result)) {
          elizaLogger.success(`Multiple transactions confirmed with hashes: ${result.join(', ')}`);
        } else {
          elizaLogger.success(`Transaction confirmed with hash: ${result}`);
        }

        elizaLogger.info(`✅ Transaction for ${objectiveId} processed successfully`);
        await this.completeObjective(goal, objectiveId);
        return true;
      },
      'Failed to process transactions'
    );

    if (!result) {
      const objective = goal.objectives.find(obj => obj.id === objectiveId) as ChromaObjective;
      if (objective) {
        objective.status = ObjectiveStatus.ABORTED;
        await this.runtime?.databaseAdapter.updateGoal(goal);
      }
    }
  }

  private async handleBridgeConfirmation(goal: Goal): Promise<void> {
    elizaLogger.info('🔄 Waiting for bridge confirmation...');

    const startTime = Date.now();
    let checkInterval = this.BRIDGE_INITIAL_CHECK_INTERVAL_MS;
    let hasBalance = false;

    const result = await this.retryWithBackoff(
      async () => {
        while (Date.now() - startTime < this.MAX_BRIDGE_WAIT_TIME_MS) {
          // Check balance on Arbitrum Sepolia
          const balanceQuery = "What's my balance on Arbitrum Sepolia?";
          elizaLogger.info('🤖 Agent says:', balanceQuery);
          const balanceResponse = await this.sendMessage(balanceQuery);
          elizaLogger.info('💬 Chroma replies balance:', balanceResponse);

          // Extract token amounts and check if USDC > 0
          const tokenAmounts = await this.extractTokenAmounts(balanceResponse);
          const usdcAmount = tokenAmounts.tokenAmount;

          if (usdcAmount && parseFloat(usdcAmount) > 0) {
            hasBalance = true;
            elizaLogger.info(`✅ Detected USDC balance on Arbitrum Sepolia: ${usdcAmount}`);
            await this.completeObjective(goal, 'wait-for-chain-b-confirmation');
            return true;
          }

          elizaLogger.info(`⏳ No balance detected yet. Checking again in ${checkInterval / 1000}s...`);

          // Wait for the next check interval with exponential backoff
          await new Promise(resolve => setTimeout(resolve, checkInterval));
          checkInterval = Math.min(checkInterval * 2, 60000); // Cap at 1 minute
        }

        if (!hasBalance) {
          throw new Error('Bridge confirmation timed out');
        }

        return true;
      },
      'Failed to confirm bridge after maximum wait time'
    );

    if (!result) {
      const objective = goal.objectives.find(obj => obj.id === 'wait-for-chain-b-confirmation') as ChromaObjective;
      if (objective) {
        objective.status = ObjectiveStatus.ABORTED;
        await this.runtime?.databaseAdapter.updateGoal(goal);
      }
    }
  }

  private async handleDepositOperation(goal: Goal): Promise<void> {
    elizaLogger.info('🔄 Starting deposit operation...');

    const result = await this.retryWithBackoff(
      async () => {
        // Get the current balance on Arbitrum Sepolia
        const balanceQuery = "What's my balance on Arbitrum Sepolia?";
        elizaLogger.info('🤖 Agent says:', balanceQuery);
        const balanceResponse = await this.sendMessage(balanceQuery);
        elizaLogger.info('💬 Chroma replies balance:', balanceResponse);

        // Extract token amounts from the balance response
        const tokenAmounts = await this.extractTokenAmounts(balanceResponse);
        const usdcAmount = tokenAmounts.tokenAmount;

        if (!usdcAmount) {
          throw new Error('Failed to extract USDC amount from balance response');
        }

        // Generate deposit operation message with extracted amount
        const depositMessage = `Generate yield by depositing ${usdcAmount} USDC on Arbitrum Sepolia`;
        elizaLogger.info('🤖 Agent says:', depositMessage);
        const response = await this.sendMessage(depositMessage);
        elizaLogger.info('💬 Chroma replies deposit:', response);

        const responseWithIntent = response.find(r => r.intent);
        if (!responseWithIntent) {
          throw new Error('No intent found in deposit response');
        }

        const accounts = await this.getAvailableAccounts();
        const chainDetailsText = this.getChainDetailsText(accounts);
        const isValidIntent = await validateOperationResponse(goal, responseWithIntent, chainDetailsText, this.runtime);
        if (!isValidIntent) {
          throw new Error('Invalid intent received for deposit');
        }

        await this.storeResponse(goal, responseWithIntent);
        elizaLogger.info('✅ Deposit operation presented successfully');
        await this.completeObjective(goal, 'present-deposit-operation-chain-b');
        return true;
      },
      'Failed to complete deposit operation after multiple attempts'
    );

    if (!result) {
      const objective = goal.objectives.find(obj => obj.id === 'present-deposit-operation-chain-b') as ChromaObjective;
      if (objective) {
        objective.status = ObjectiveStatus.ABORTED;
        await this.runtime?.databaseAdapter.updateGoal(goal);
      }
    }
  }

  private async extractTokenAmounts(response: ChromaResponse[]): Promise<{ [key: string]: string }> {
    const responseText = response.map(r => r.text).join('\n');

    const extractionPrompt = `# TASK: Extract token amounts from the balance response.

Balance Response:
"""
${responseText}
"""

Your task is to extract EXACTLY two specific types of token amounts from this balance response:

1. "tokenAmount": The amount of the base token (usually USDC, USDT, or DAI)
   - Example: In "37.850000 USDC", the tokenAmount is "37.850000"

2. "aTokenAmount": The amount of any aToken (tokens that start with 'a', like aOptSepUSDC)
   - Example: In "1.750004 aOptSepUSDC", the aTokenAmount is "1.750004"

Return BOTH values in the following format:
{
  "tokenAmount": "numeric amount as string",
  "aTokenAmount": "numeric amount as string"
}

IMPORTANT:
- Extract ONLY the numeric values, without any symbols or units
- Do NOT leave out either value if present in the response
- You MUST extract both the base token amount AND the aToken amount if they exist
- In this balance response, look carefully for both a USDC amount AND an aOptSepUSDC amount`;

    try {
      // Define the schema using zod
      const schema = z.object({
        tokenAmount: z.string().describe('The numeric amount of the base token (USDC, USDT, DAI, etc.) as a string'),
        aTokenAmount: z.string().describe('The numeric amount of the aToken (starting with "a", like aOptSepUSDC) as a string')
      });

      const result = (await generateObject({
        runtime: this.runtime,
        context: extractionPrompt,
        schema,
        modelClass: ModelClass.SMALL
      })).object as z.infer<typeof schema>;

      // Create a clean result object with just the numeric values
      const cleanedResult: { [key: string]: string } = {};

      // Process the result object
      Object.entries(result).forEach(([key, value]) => {
        if (typeof value === 'string') {
          // Clean up the value to ensure it's just a number
          const cleanedValue = value.trim().replace(/[^\d.]/g, '');
          if (cleanedValue) {
            cleanedResult[key] = cleanedValue;
          }
        }
      });

      elizaLogger.info('✅ Extracted token amounts:', cleanedResult);
      return cleanedResult;
    } catch (error) {
      elizaLogger.error('❌ Error extracting token amounts:', error);
      return {};
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