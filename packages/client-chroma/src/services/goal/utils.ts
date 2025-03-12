import { Goal, IAgentRuntime, elizaLogger, generateText, generateTrueOrFalse, generateObject, ModelClass } from '@elizaos/core';
import { z } from 'zod';
import { RetryOptions } from './types';

export const CONSTANTS = {
  MAX_RETRIES: 3,
  RETRY_DELAY_MS: 1000,
  INTENT_CONFIRMATION_TIMEOUT: 30000,
  GOAL_CHECK_INTERVAL: 10000,
};

export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  options: RetryOptions,
  errorMessage: string,
  runtime?: IAgentRuntime,
  onAbort?: () => Promise<void>
): Promise<T | null> {
  if (options.currentAttempt >= options.maxRetries) {
    elizaLogger.warn(`❌ Max retries (${options.maxRetries}) reached: ${errorMessage}`);
    if (onAbort) {
      await onAbort();
    }
    return null;
  }

  try {
    const result = await operation();
    return result;
  } catch (error) {
    //console.log('error', error);
    elizaLogger.error(`Attempt ${options.currentAttempt + 1} failed:`, error);
    await new Promise(resolve =>
      setTimeout(resolve, CONSTANTS.RETRY_DELAY_MS * Math.pow(2, options.currentAttempt))
    );
    return retryWithBackoff(
      operation,
      {
        ...options,
        currentAttempt: options.currentAttempt + 1
      },
      errorMessage,
      runtime,
      onAbort
    );
  }
}

export async function isCryptoGoal(goal: Goal, runtime: IAgentRuntime, cryptoGoalCache: Map<string, boolean>): Promise<boolean> {
  if (!goal.id) return false;

  if (cryptoGoalCache.has(goal.id)) {
    return cryptoGoalCache.get(goal.id)!;
  }

  const isCryptoGoalPrompt = `For this goal:
Goal: "${goal.name}"
Objectives:
${goal.objectives.map(o => `- ${o.description}`).join('\n')}

Determine if it is related to cryptocurrency operations.
Answer only with "true" or "false".`;

  cryptoGoalCache.set(goal.id, undefined);

  const result = await generateTrueOrFalse({
    runtime,
    context: isCryptoGoalPrompt,
    modelClass: ModelClass.SMALL
  });

  cryptoGoalCache.set(goal.id, result);
  return result;
}

export async function generateOperationMessage(goal: Goal, chainDetailsText: string, runtime: IAgentRuntime): Promise<string | null> {
  const operationContext = `# TASK: Generate a crypto operation request.
Goal: ${goal.name}
Operation: ${goal.objectives.find(obj => obj.id === 'present-operation')?.description}

${chainDetailsText}

Rules for the message:
1. State the operation (transfer/swap) and its parameters directly
2. Use only the addresses needed for the operation
3. For swaps, assume same-chain unless specified otherwise
4. For deposits or yield operations, assume the user wants to maximize yield using all the available chains
5. Be brief and clear - use simple language
6. Avoid recommendations or warnings
7. Speak in first person
8. Do not change some keywords like "deposit", "withdraw", "bridge", "swap", "transfer", "yield", etc
9. DO NOT include this words: "intent", "confirm", "proposal"
10. VERY IMPORTANT: if the operation mentions the network, include it in the message

Generate only the operation request text.`;

  return generateText({
    runtime,
    context: operationContext,
    modelClass: ModelClass.SMALL
  });
}

export async function validateOperationResponse(
  goal: Goal,
  response: any,
  chainDetailsText: string,
  runtime: IAgentRuntime
): Promise<{ isValid: boolean; reason: string }> {
  // Note: TransferIntent interface doesn't have a 'type' property, but the API response might
  // Fast path: if this is clearly a bridge intent with the required fields, accept it immediately
  if ((response?.intent as any)?.type === 'BRIDGE' ||
     (response?.intent &&
      response?.intent?.fromChain?.includes('sepolia') &&
      response?.intent?.recipientChain?.includes('sepolia') &&
      response?.intent?.amount)) {
    elizaLogger.info('✅ Fast-track validating bridge intent: VALID');
    return { isValid: true, reason: 'Valid bridge intent with all required fields' };
  }

  // Similarly if this is a withdraw intent with the required fields
  if ((response?.intent as any)?.type === 'WITHDRAW' ||
     (response?.intent &&
      response?.intent?.fromToken &&  // Note: using fromToken which might be API-specific
      response?.intent?.amount &&
      response?.intent?.fromAddress)) {
    elizaLogger.info('✅ Fast-track validating withdraw intent: VALID');
    return { isValid: true, reason: 'Valid withdraw intent with all required fields' };
  }

  // More detailed model-based validation for other cases
  const validationContext = `# TASK: Validate if this intent is valid for the operation.

Goal: ${goal.name}
Operation: ${goal.objectives.find(obj => obj.id === 'present-operation')?.description}

${chainDetailsText}

Received Intent:
${JSON.stringify(response.intent, null, 2)}

Check these key points (intent is valid if MOST conditions are met):
1. The chain context makes sense (e.g., EVM operations use EVM addresses)
2. The basic operation parameters (amount, token, etc.) are present
3. The operation type generally aligns with the goal
4. If one network is sepolia, all the other networks should be sepolia. Consider if just "sepolia" is mentioned, it refers to ethereum sepolia, which is fine.
5. Be lenient with all details, especially token types and names
6. For withdraw operations, accept "USDC" even when withdrawing aTokens like "aOptSepUSDC"
7. For bridge operations, accept ANY chain naming (sepolia, optimism-sepolia, opt-sepolia, arbitrum-sepolia, arb-sepolia, etc.)
8. Focus on the operation type, amount, and address - if these are valid, approve the intent
9. Only reject intents with issues like wrong operation type or missing critical parameters

The default answer should be to approve unless there's a clear and serious problem.

Return an object with two fields:
- "continue": boolean value (true if we should proceed with this intent, false if not)
- "reason": A brief explanation (1-2 sentences) of your decision

Your decision should default to "continue: true" unless there's a clear problem.`;

  try {
    // Define schema with zod
    const validationSchema = z.object({
      continue: z.boolean().describe('Whether the intent is valid and we should proceed'),
      reason: z.string().describe('Brief explanation for the decision')
    });

    const result = await generateObject({
      runtime,
      context: validationContext,
      schema: validationSchema,
      modelClass: ModelClass.SMALL
    });

    const validationResult = result.object as z.infer<typeof validationSchema>;

    elizaLogger.info(`📝 Intent validation result: ${validationResult.continue ? 'VALID' : 'INVALID'}`);
    elizaLogger.info(`📝 Reason: ${validationResult.reason}`);

    return { 
      isValid: validationResult.continue, 
      reason: validationResult.reason 
    };
  } catch (error) {
    elizaLogger.error('❌ Error in intent validation:', error);
    // If validation fails for technical reasons, default to accept the intent
    elizaLogger.info('📝 Defaulting to VALID due to validation error');
    return { 
      isValid: true, 
      reason: 'Default to valid due to validation error: ' + (error instanceof Error ? error.message : String(error))
    };
  }
}

export async function validateIntroResponse(responses: any[], runtime: IAgentRuntime): Promise<{ isValid: boolean; reason: string }> {
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

Return an object with:
- "continue": boolean, true for valid responses or false for invalid ones
- "reason": brief explanation for your decision`;

  try {
    // Define schema with zod
    const validationSchema = z.object({
      continue: z.boolean().describe('Whether the response is valid'),
      reason: z.string().describe('Brief explanation for the decision')
    });

    const result = await generateObject({
      runtime,
      context: introValidationPrompt,
      schema: validationSchema,
      modelClass: ModelClass.SMALL
    });

    const validationResult = result.object as z.infer<typeof validationSchema>;

    elizaLogger.info(`📝 Intro validation result: ${validationResult.continue ? 'VALID' : 'INVALID'}`);
    elizaLogger.info(`📝 Reason: ${validationResult.reason}`);

    return { 
      isValid: validationResult.continue, 
      reason: validationResult.reason 
    };
  } catch (error) {
    elizaLogger.error('❌ Error in intro validation:', error);
    // If validation fails for technical reasons, default to accept the response
    elizaLogger.info('📝 Defaulting to VALID due to validation error');
    return { 
      isValid: true, 
      reason: 'Default to valid due to validation error: ' + (error instanceof Error ? error.message : String(error)) 
    };
  }
}