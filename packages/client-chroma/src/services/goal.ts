import {
    Service,
    ServiceType,
    IAgentRuntime,
    elizaLogger,
    Goal,
    GoalStatus,
    generateText,
    ModelClass,
    generateTrueOrFalse,
    Objective
} from '@elizaos/core';
import { ChromaApiClient } from '../api';
import { ChromaResponse, TransactionProposal } from '../types';
import { EVMSignatureHandler } from './signatures/evm';
import { SolanaSignatureHandler } from './signatures/solana';
import { SignatureHandlerInterface } from './signatures/types';
import { ChainAccount } from './signatures/types';
import { isCryptoGoal } from './goal/utils';
import { GoalHandlerInterface } from './goal/types';
import { SingleChainGoalHandler, MultiChainGoalHandler, CDPGoalHandler } from './goal/handlers';

const GOAL_CHECK_INTERVAL = 10000;

interface RetryOptions {
  maxRetries: number;
  currentAttempt: number;
}

export class ChromaService extends Service {
  private apiClient?: ChromaApiClient;
  private runtime?: IAgentRuntime;
  private signatureHandlers: SignatureHandlerInterface[] = [];
  private checkInterval?: NodeJS.Timeout;
  private processingGoals: Set<string> = new Set();
  private goalResponses: Map<string, ChromaResponse> = new Map();
  private cryptoGoalCache: Map<string, boolean> = new Map();
  private static readonly MAX_RETRIES = 3;
  private static readonly RETRY_DELAY_MS = 1000;
  private static readonly INTENT_CONFIRMATION_TIMEOUT = 30000; // 30 seconds
  private handlers: GoalHandlerInterface[] = [];

  static get serviceType(): ServiceType {
    return ServiceType.CHROMA;
  }

  async initialize(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;

    const hostUrl = runtime.getSetting('CHROMA_HOST_URL');

    this.apiClient = new ChromaApiClient(hostUrl);
    await this.apiClient.initialize();

    // Initialize signature handlers
    const evmHandler = new EVMSignatureHandler(runtime);
    const solanaHandler = new SolanaSignatureHandler(runtime);

    await evmHandler.initialize(runtime);
    await solanaHandler.initialize(runtime);

    this.signatureHandlers = [evmHandler, solanaHandler];

    // Initialize handlers
    const singleChainHandler = new SingleChainGoalHandler();
    const multiChainHandler = new MultiChainGoalHandler();
    const cdpHandler = new CDPGoalHandler();

    await singleChainHandler.initialize(runtime);
    await multiChainHandler.initialize(runtime);
    await cdpHandler.initialize(runtime);

    this.handlers = [singleChainHandler, cdpHandler, multiChainHandler];

    this.startGoalChecking();
  }

  private startGoalChecking() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }

    this.checkInterval = setInterval(async () => {
      await this.processGoals();
    }, GOAL_CHECK_INTERVAL);
  }

  private async processGoals(): Promise<void> {
    const goals = await this.runtime?.databaseAdapter.getGoals({
      agentId: this.runtime.agentId,
      roomId: this.runtime.agentId,
      onlyInProgress: true
    });

    if (!goals?.length) return;

    for (const goal of goals) {
      if (!goal.id) continue;

      elizaLogger.debug(`Processing state for goal ${goal.id}:`, {
        isProcessing: this.processingGoals.has(goal.id),
        hasStoredResponse: this.goalResponses.has(goal.id),
        objectives: goal.objectives.map(o => ({id: o.id, completed: o.completed}))
      });

      if (this.processingGoals.has(goal.id)) {
        elizaLogger.debug(`⏳ Goal ${goal.id} is marked as processing`);
        continue;
      }

      const isCrypto = await isCryptoGoal(goal, this.runtime!, this.cryptoGoalCache);
      if (!isCrypto) continue;

      try {
        this.processingGoals.add(goal.id);
        const handler = await this.getHandlerForGoal(goal);
        if (!handler) {
          elizaLogger.warn(`No handler found for goal ${goal.id}`);
          continue;
        }

        await handler.processObjective(goal);
      } catch (error) {
        elizaLogger.error(`Error processing goal ${goal.id}:`, error);
        this.clearProcessingState(goal.id);
        for (const handler of this.handlers) {
          handler.clearState(goal.id);
        }
      }
    }
  }

  private async getHandlerForGoal(goal: Goal): Promise<GoalHandlerInterface | undefined> {
    for (const handler of this.handlers) {
      if (await handler.supportsGoal(goal)) {
        return handler;
      }
    }
    return undefined;
  }

  private async isCryptoGoal(goal: Goal): Promise<boolean> {
    if (!goal.id) return false;

    // Check cache first
    if (this.cryptoGoalCache.has(goal.id)) {
      return this.cryptoGoalCache.get(goal.id)!;
    }

    const isCryptoGoalPrompt = `For this goal:
Goal: "${goal.name}"
Objectives:
${goal.objectives.map(o => `- ${o.description}`).join('\n')}

Determine if it is related to cryptocurrency operations.
Answer only with "true" or "false".`;

    // So we don't run this again
    this.cryptoGoalCache.set(goal.id, undefined);

    const result = await generateTrueOrFalse({
      runtime: this.runtime,
      context: isCryptoGoalPrompt,
      modelClass: ModelClass.SMALL
    });

    // Cache the result
    this.cryptoGoalCache.set(goal.id, result);
    return result;
  }

  private async processCryptoGoal(goal: Goal): Promise<void> {
    if (!goal.id) return;

    try {
      const pendingObjective = goal.objectives.find(obj => !obj.completed);
      if (!pendingObjective) {
        elizaLogger.info(`No pending objectives for goal ${goal.id}`);
        await this.completeGoal(goal);
        return;
      }

      elizaLogger.info(`Processing objective: ${pendingObjective.id} for goal: ${goal.name}`);

      await this.processObjective(goal, pendingObjective);
    } catch (error) {
      elizaLogger.error(`Error in processCryptoGoal for ${goal.id}:`, error);
      await this.failGoal(goal);
      throw error;
    }
  }

  private async processObjective(goal: Goal, objective: Objective): Promise<void> {
    try {
      switch (objective.id) {
        case 'introduce-agent':
          await this.handleIntroduction(goal);
          break;
        case 'present-operation':
          await this.handleOperation(goal);
          break;
        case 'confirm-intent':
          await this.handleIntent(goal);
          break;
        case 'process-proposal':
          await this.handleProposal(goal);
          break;
        default:
          elizaLogger.warn(`Unknown objective: ${objective.id}`);
          return;
      }

      // After objective is completed, process the next one
      const nextObjective = goal.objectives.find(obj => !obj.completed);
      if (nextObjective) {
        elizaLogger.info(`Moving to next objective: ${nextObjective.id}`);
        await this.processObjective(goal, nextObjective);
      } else {
        elizaLogger.info('✅ All objectives completed');
        await this.completeGoal(goal);
      }
    } catch (error) {
      elizaLogger.error(`Error processing objective ${objective.id}:`, error);
      throw error;
    }
  }

  private async getAvailableAccounts(): Promise<{ evmAccount?: ChainAccount; solanaAccount?: ChainAccount }> {
    let evmAccount: ChainAccount | undefined;
    let solanaAccount: ChainAccount | undefined;

    try {
      const evmHandler = this.signatureHandlers.find(h => h instanceof EVMSignatureHandler);
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

    if (!evmAccount && !solanaAccount) {
      throw new Error('No accounts available');
    }

    return { evmAccount, solanaAccount };
  }

  private getChainDetailsText(accounts: { evmAccount?: ChainAccount; solanaAccount?: ChainAccount }): string {
    return `Available chains and addresses (use only what's needed for the operation):
${accounts.evmAccount ? `- Option 1: ${accounts.evmAccount.chains.join(', ')} with address ${accounts.evmAccount.address}` : ''}
${accounts.solanaAccount ? `- Option 2: Solana with address ${accounts.solanaAccount.address}` : ''}

- Select the appropriate chain based on the operation requirements.
- Do not mention chains or addresses that aren't relevant to the specific operation.
- Use ethereum if no chain is mentioned and seems an evm chain operation.`;
  }

  private async handleIntroduction(goal: Goal): Promise<void> {
    elizaLogger.info('🔄 Starting introduction sequence...');

    return this.retryWithBackoff(
        async () => {
            const accounts = await this.getAvailableAccounts();

            const introContext = `# TASK: You need to perform a crypto operation. Generate an introduction message for this.
${this.getChainDetailsText(accounts)}

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
            const isIntroductionValid = await this.validateIntroResponse(response);
            elizaLogger.info(`🔄 Introduction validation result: ${isIntroductionValid}`);

            if (isIntroductionValid) {
                elizaLogger.info('✅ Introduction successful');
                await this.completeObjective(goal, 'introduce-agent');
            } else {
                elizaLogger.warn('❌ Introduction validation failed');
                throw new Error('Introduction validation failed');
            }
        },
        { maxRetries: ChromaService.MAX_RETRIES, currentAttempt: 0 },
        'Failed to complete introduction after multiple attempts'
    );
  }

  private async handleOperation(goal: Goal): Promise<void> {
    elizaLogger.info('🔄 Starting operation presentation...');

    const operationMessage = await this.generateOperationMessage(goal);
    if (!operationMessage) return;

    return this.retryWithBackoff(
        async () => {
            elizaLogger.info('🤖 Agent says:', operationMessage);
            const response = await this.sendMessage(operationMessage);
            elizaLogger.info('💬 Chroma replies:', response);

            const responseWithIntent = response.find(r => r.intent);
            if (!responseWithIntent) {
                throw new Error('No intent found in response');
            }

            const isValidIntent = await this.validateOperationResponse(goal, responseWithIntent);
            if (!isValidIntent) {
                throw new Error('Invalid intent received');
            }

            await this.handleSuccessfulIntent(goal, responseWithIntent);

            const confirmContext = `# TASK: Generate a confirmation message for the received intent.
Intent: ${JSON.stringify(responseWithIntent.intent, null, 2)}
Goal: ${goal.name}
Operation: ${goal.objectives.find(obj => obj.id === 'present-operation')?.description}

Create a brief confirmation message that:
1. Confirms we want to proceed with this intent
2. Is direct and positive (e.g., "Yes, please proceed" or "Confirm this intent")
3. Uses only 3-5 words
4. Does not include additional explanations or details

Generate only the confirmation message text.`;

            const confirmMessage = await generateText({
                runtime: this.runtime,
                context: confirmContext,
                modelClass: ModelClass.SMALL
            });

            elizaLogger.info('🤖 Agent confirms:', confirmMessage);
            const confirmResponse = await this.sendMessage(confirmMessage);
            elizaLogger.info('💬 Chroma replies:', confirmResponse);

            const responseWithProposal = confirmResponse.find(r => r.proposals);
            if (!responseWithProposal) {
                throw new Error('No proposals received after confirmation');
            }

            await this.storeResponseForGoal(goal, responseWithProposal);
            elizaLogger.info('✅ Intent confirmed and received proposal');
            await this.completeObjective(goal, 'confirm-intent');
        },
        { maxRetries: ChromaService.MAX_RETRIES, currentAttempt: 0 },
        'Failed to complete operation after multiple attempts'
    );
  }

  private async validateOperationResponse(goal: Goal, response: ChromaResponse): Promise<boolean> {
    const accounts = await this.getAvailableAccounts();

    const validationContext = `# TASK: Validate if this intent is valid for the operation.

Goal: ${goal.name}
Operation: ${goal.objectives.find(obj => obj.id === 'present-operation')?.description}

Available Accounts:
${accounts.evmAccount ? `- EVM: ${accounts.evmAccount.address}` : ''}
${accounts.solanaAccount ? `- Solana: ${accounts.solanaAccount.address}` : ''}

Received Intent:
${JSON.stringify(response.intent, null, 2)}

Check these key points (intent is valid if MOST conditions are met):
1. The chain context makes sense (e.g., EVM operations use EVM addresses)
2. The addresses mentioned exist in our available accounts
3. The basic operation parameters (amount, token, etc.) are present
4. The operation type generally aligns with the goal

Note: Minor missing details or extra parameters are acceptable as long as the core operation is valid.

Answer with "true" if the intent is generally valid and usable, or "false" if there are major issues.`;

    return await generateTrueOrFalse({
        runtime: this.runtime,
        context: validationContext,
        modelClass: ModelClass.SMALL
    });
  }

  private async generateOperationMessage(goal: Goal): Promise<string | null> {
    const accounts = await this.getAvailableAccounts();

    const operationContext = `# TASK: Generate a crypto operation request.
Goal: ${goal.name}
Operation: ${goal.objectives.find(obj => obj.id === 'present-operation')?.description}

${this.getChainDetailsText(accounts)}

Rules for the message:
1. State the operation (transfer/swap) and its parameters directly
2. Use only the addresses needed for the operation
3. For swaps, assume same-chain unless specified otherwise
4. Be brief and clear - use simple language
5. Avoid recommendations or warnings
6. Speak in first person
7. DO NOT include this words: "intent", "confirm", "proposal"

Generate only the operation request text.`;

    return generateText({
      runtime: this.runtime,
      context: operationContext,
      modelClass: ModelClass.SMALL
    });
  }

  private async handleSuccessfulIntent(goal: Goal, response: ChromaResponse): Promise<void> {
    await this.storeResponseForGoal(goal, response);
    elizaLogger.info('✅ Operation presented successfully');
    await this.completeObjective(goal, 'present-operation');
  }

  private async validateIntroResponse(responses: ChromaResponse[]): Promise<boolean> {
    const introValidationPrompt = `# TASK: Determine if this is a valid introduction response.

Responses received:
\`\`\`
${responses.map(r => r.text).join('\n')}
\`\`\`

A response is considered VALID if it meets ANY of these criteria:
1. Asks for operation details
2. Requests transaction parameters
3. Shows readiness to process the operation
4. Prompts for specific details about what to do next

A response should be considered INVALID only if:
1. Contains an error message
2. Is completely unrelated to the introduction
3. Is empty or nonsensical
4. Ask for wallet address or chain, not related to an operation but in general

Answer only with "true" for valid responses or "false" for invalid ones.`;

    return await generateTrueOrFalse({
      runtime: this.runtime,
      context: introValidationPrompt,
      modelClass: ModelClass.SMALL
    });
  }

  private getLatestResponseForGoal(goal: Goal): ChromaResponse | undefined {
    if (!goal.id) return undefined;
    return this.goalResponses.get(goal.id);
  }

  private storeResponseForGoal(goal: Goal, response: ChromaResponse): void {
    if (!goal.id) return;
    elizaLogger.info(`💾 Storing response for goal ${goal.id}:`, response);
    this.goalResponses.set(goal.id, response);
  }

  private async completeObjective(goal: Goal, objectiveId: string) {
    const objective = goal.objectives.find(o => o.id === objectiveId);
    if (objective) {
      objective.completed = true;
      await this.runtime?.databaseAdapter.updateGoal(goal);
      elizaLogger.info(`✅ Completed objective: ${objectiveId}`);
    }
  }

  private async completeGoal(goal: Goal) {
    if (!goal.id) return;

    this.goalResponses.delete(goal.id);
    elizaLogger.debug(`🧹 Cleaned up stored response for goal ${goal.id}`);

    await this.runtime?.databaseAdapter.updateGoalStatus({
      goalId: goal.id,
      status: GoalStatus.DONE
    });
  }

  private async failGoal(goal: Goal) {
    if (!goal.id) return;

    this.goalResponses.delete(goal.id);
    elizaLogger.debug(`🧹 Cleaned up stored response for goal ${goal.id}`);

    await this.runtime?.databaseAdapter.updateGoalStatus({
      goalId: goal.id,
      status: GoalStatus.FAILED
    });
  }

  private async signProposal(proposal: TransactionProposal): Promise<string | string[]> {
    const handler = this.signatureHandlers.find(h => h.supportsChain(proposal));
    return handler.signProposal(proposal);
  }

  async sendMessage(text: string): Promise<ChromaResponse[]> {
    if (!this.apiClient) {
      throw new Error('Service not initialized');
    }

    const responses = await this.apiClient.sendMessage(text);
    return responses;
  }

  getSelectedAgent() {
    return this.apiClient?.getSelectedAgent();
  }

  private async retryWithBackoff<T>(
    operation: () => Promise<T>,
    options: RetryOptions,
    errorMessage: string
  ): Promise<T | null> {
    if (options.currentAttempt >= options.maxRetries) {
      elizaLogger.warn(`❌ Max retries (${options.maxRetries}) reached: ${errorMessage}`);
      return null;
    }

    try {
      const result = await operation();
      return result;
    } catch (error) {
      elizaLogger.error(`Attempt ${options.currentAttempt + 1} failed:`, error);
      await new Promise(resolve =>
        setTimeout(resolve, ChromaService.RETRY_DELAY_MS * Math.pow(2, options.currentAttempt))
      );
      return this.retryWithBackoff(operation, {
        ...options,
        currentAttempt: options.currentAttempt + 1
      }, errorMessage);
    }
  }

  private async retryMessage(
    goal: Goal,
    originalMessage: string,
    originalResponse: ChromaResponse[],
    retryType: 'intent' | 'proposal'
  ): Promise<ChromaResponse[]> {
    return this.retryWithBackoff(
      async () => {
        const retryContext = `# TASK: Analyze the failed interaction and generate a clearer request.

Goal: ${goal.name}
Original Request: ${originalMessage}
Response received: ${JSON.stringify(originalResponse, null, 2)}
Expected response should include: ${retryType === 'intent' ? 'an intent object' : 'transaction proposals'}

Create a more specific request that:
1. Addresses any ambiguity in the original request
2. Explicitly asks for the ${retryType === 'intent' ? 'intent object' : 'transaction proposal'}
3. Uses precise terminology
4. Includes all necessary transaction details
5. Is concise and clear, use only plain text
6. DO NOT use the words "intent", "confirm", or "proposal" in the message
7. Be concise and clear, use only plain text, express in as few words as possible.
8. Formulate the request in a way that is easy to understand and follow, vary from the original request.

Generate only the improved request text.`;

        const improvedMessage = await generateText({
          runtime: this.runtime,
          context: retryContext,
          modelClass: ModelClass.SMALL
        });

        elizaLogger.debug('📤 Agent retries:', improvedMessage);
        const retryResponse = await this.sendMessage(improvedMessage);
        elizaLogger.debug('📥 Chroma replies:', retryResponse);

        return retryResponse;
      },
      { maxRetries: ChromaService.MAX_RETRIES, currentAttempt: 0 },
      `Failed to get valid ${retryType} after multiple attempts`
    ) || originalResponse;
  }

  private async handleIntent(goal: Goal): Promise<void> {
    elizaLogger.info('🔄 Checking intent confirmation status...');

    const storedResponse = await this.getLatestResponseForGoal(goal);
    if (!storedResponse?.proposals) {
        elizaLogger.warn('❌ No proposals found in stored response');

        if (storedResponse?.intent) {
            elizaLogger.info('🔄 Retrying intent confirmation...');
            const confirmContext = `# TASK: Generate a confirmation message for the intent.
Intent: ${JSON.stringify(storedResponse.intent, null, 2)}
Goal: ${goal.name}

Create a brief confirmation message that:
1. Confirms we want to proceed with this intent
2. Is direct and positive
3. Uses only 3-5 words
4. Does not include additional explanations

Generate only the confirmation message text.`;

            const confirmMessage = await generateText({
                runtime: this.runtime,
                context: confirmContext,
                modelClass: ModelClass.SMALL
            });

            elizaLogger.info('🤖 Agent says:', confirmMessage);

            // Create a promise that times out
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('Intent confirmation timed out')), ChromaService.INTENT_CONFIRMATION_TIMEOUT);
            });

            try {
                const response = await Promise.race([
                    this.sendMessage(confirmMessage),
                    timeoutPromise
                ]) as ChromaResponse[];

                const responseWithProposal = response.find(r => r.proposals);
                if (responseWithProposal) {
                    await this.storeResponseForGoal(goal, responseWithProposal);
                    elizaLogger.info('✅ Received proposals after retry');
                    await this.completeObjective(goal, 'confirm-intent');
                    await this.processObjective(goal, goal.objectives.find(obj => obj.id === 'process-proposal')!);
                    return;
                }
            } catch (error) {
                elizaLogger.warn('Intent confirmation failed:', error);
            }

            // If we reach here, either we timed out or didn't get proposals
            elizaLogger.info('🔄 No proposals received or timed out, restarting from operation step');
            goal.objectives.forEach(obj => {
                if (obj.id === 'introduce-agent') {
                    // Keep introduction completed
                    return;
                }
                obj.completed = false;
            });
            await this.runtime?.databaseAdapter.updateGoal(goal);
            await this.processObjective(goal, goal.objectives.find(obj => obj.id === 'present-operation')!);
        }
    } else {
        elizaLogger.info('✅ Intent already confirmed with proposals');
        await this.completeObjective(goal, 'confirm-intent');
        await this.processObjective(goal, goal.objectives.find(obj => obj.id === 'process-proposal')!);
    }
  }

  private async handleProposal(goal: Goal): Promise<void> {
    elizaLogger.info('🔄 Starting proposal processing...');

    const storedResponse = await this.getLatestResponseForGoal(goal);
    if (!storedResponse?.proposals) {
      elizaLogger.warn('❌ No stored proposal found');
      return;
    }

    try {
      // For the moment, we only support the first proposal
      const proposal = storedResponse.proposals[0];

      elizaLogger.info(`Processing proposal: ${JSON.stringify(proposal)}`);
      const result = await this.signProposal(proposal);
      if (Array.isArray(result)) {
        elizaLogger.success(`Multiple transactions confirmed with hashes: ${result.join(', ')}`);
      } else {
        elizaLogger.success(`Transaction confirmed with hash: ${result}`);
      }

      elizaLogger.info('✅ All proposals processed successfully');
      await this.completeObjective(goal, 'process-proposal');
      await this.completeGoal(goal);
    } catch (error) {
      elizaLogger.error('Failed to process proposals:', error);
      await this.failGoal(goal);
      throw error;
    }
  }

  protected async onStop(): Promise<void> {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }
    this.processingGoals.clear();
    this.goalResponses.clear();
    this.cryptoGoalCache.clear();
    elizaLogger.info('🧹 Cleaned up service state on stop');
  }

  private clearProcessingState(goalId: string): void {
    elizaLogger.info(`🧹 Clearing processing state for goal ${goalId}`);
    this.processingGoals.delete(goalId);
    this.goalResponses.delete(goalId);
    this.cryptoGoalCache.delete(goalId);
  }

  protected async onStart(): Promise<void> {
    this.processingGoals.clear();
    this.goalResponses.clear();
    this.cryptoGoalCache.clear();
    elizaLogger.info('🧹 Cleared all processing states on service start');

    this.startGoalChecking();
  }
}
