import { Objective as CoreObjective } from '@elizaos/core';
import { ObjectiveStatus } from './services/goal/types';

export interface ChromaPluginConfig {
  hostUrl?: string;
  exampleMode?: boolean;
  defaultWalletAddress?: string;
}

export interface ChromaAgent {
  id: string;
  name: string;
}

export interface TransferIntent {
  id: string;
  amount: string;
  token: string;
  fromAddress: string;
  fromChain: string;
  recipientAddress: string;
  recipientChain: string;
  status: 'pending' | 'confirmed' | 'failed';
}

export interface BaseTransaction {
  // Common fields
  data?: string;

  // EVM specific fields
  chainId?: number;
  to?: string;
  value?: bigint | string;
  nonce?: number;
  gas?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
}

export interface TransactionProposal {
  titles: string[];
  calls: string[];
  chainId: number;
  transactions?: BaseTransaction[];
  transaction?: BaseTransaction & {
    // Solana specific fields
    serializedTransaction?: string;
  };
}

export interface ChromaResponse {
  id?: string;
  user?: string;
  text: string;
  action?: string;
  source?: string;
  intent?: TransferIntent;
  contentType?: string;
  proposals?: TransactionProposal[];
}

export interface ChromaObjective extends CoreObjective {
  status?: ObjectiveStatus;
}