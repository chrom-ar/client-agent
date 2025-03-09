import { IAgentRuntime } from '@elizaos/core';
import { Account } from 'viem';
// Mock PublicKey type to avoid the dependency
type PublicKey = { toBuffer(): Uint8Array; toString(): string; };
import { TransactionProposal } from '../../types';

export type ChainAccount = {
  type: 'evm' | 'solana';
  address: string;
  chains: string[];      // Required chain identifiers
  publicKey?: PublicKey; // For Solana
  evmAccount?: Account;  // For EVM
}

export interface SignatureHandlerInterface {
  initialize(runtime: IAgentRuntime): Promise<void>;
  getAccount(type: 'evm' | 'solana'): Promise<ChainAccount>;
  signProposal(proposal: TransactionProposal): Promise<string | string[]>;
  supportsChain(proposal: TransactionProposal): boolean;
}

export abstract class BaseSignatureHandler implements SignatureHandlerInterface {
  protected runtime: IAgentRuntime;

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
  }

  abstract initialize(runtime: IAgentRuntime): Promise<void>;
  abstract getAccount(type: 'evm' | 'solana'): Promise<ChainAccount>;
  abstract signProposal(proposal: TransactionProposal): Promise<string | string[]>;
  abstract supportsChain(proposal: TransactionProposal): boolean;
}