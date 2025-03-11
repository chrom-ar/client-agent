import { IAgentRuntime, elizaLogger } from '@elizaos/core';
import { DeriveKeyProvider } from '@elizaos/plugin-tee';
import {
  Connection,
  Keypair,
  VersionedTransaction
} from '@solana/web3.js';
import { TransactionProposal } from '../../types';
import { BaseSignatureHandler, ChainAccount } from './types';
import bs58 from 'bs58';

export class SolanaSignatureHandler extends BaseSignatureHandler {
  private connection?: Connection;
  private keypair?: Keypair;

  async initialize(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
    const rpcUrl = runtime.getSetting('CHROMA_SOLANA_RPC_URL');

    if (!rpcUrl) {
      throw new Error('CHROMA_SOLANA_RPC_URL not configured');
    }

    this.connection = new Connection(rpcUrl, 'confirmed');

    // Initialize keypair
    try {
      const privateKey = this.runtime.getSetting('CHROMA_SOLANA_PRIVATE_KEY');

      if (privateKey) {
        elizaLogger.debug('Using traditional private key for Solana');
        // Convert private key from base58 string to Uint8Array
        const secretKey = bs58.decode(privateKey);
        this.keypair = Keypair.fromSecretKey(secretKey);
      } else if (this.runtime.getSetting('TEE_MODE') !== 'OFF') {
        elizaLogger.debug('Using TEE-based signing for Solana');
        const teeMode = this.runtime.getSetting('TEE_MODE');
        const walletSecretSalt = this.runtime.getSetting('WALLET_SECRET_SALT');

        if (!walletSecretSalt) {
          throw new Error('Wallet secret salt not configured for TEE signing');
        }

        const deriveKeyProvider = new DeriveKeyProvider(teeMode);
        const result = await deriveKeyProvider.deriveEd25519Keypair(
          '/',
          walletSecretSalt,
          this.runtime.agentId
        );

        const secretKey = new Uint8Array(result.keypair.secretKey);
        this.keypair = Keypair.fromSecretKey(secretKey);
      }

      if (this.keypair) {
        elizaLogger.debug(`Solana account initialized: ${this.keypair.publicKey.toString()}`);
      }
    } catch (error) {
      elizaLogger.error('Failed to initialize Solana account:', error);
    }
  }

  async getAccount(type: 'evm' | 'solana'): Promise<ChainAccount> {
    // Only return account if the type is 'solana'
    if (type !== 'solana') {
      throw new Error(`SolanaSignatureHandler doesn't support ${type} accounts`);
    }

    if (!this.keypair) {
      throw new Error('Solana account not initialized');
    }

    return {
      type: 'solana',
      address: this.keypair.publicKey.toString(),
      publicKey: this.keypair.publicKey,
      chains: ['solana']
    };
  }

  supportsChain(proposal: TransactionProposal): boolean {
    // Solana transactions have 'serializedTransation' field
    return 'serializedTransaction' in proposal.transaction;
  }

  async signProposal(proposal: TransactionProposal): Promise<string | string[]> {
    if (!this.connection || !this.keypair) {
      throw new Error('Handler not properly initialized');
    }

    try {
      // Handle multiple transactions case
      if (proposal.transactions) {
        throw new Error('Multiple transactions not supported for Solana');
      }

      // Handle single transaction case
      if (!proposal.transaction) {
        throw new Error('No transaction found in proposal');
      }

      const tx = proposal.transaction;
      let transaction: VersionedTransaction;

      // Handle all transaction types using serializedTransation
      const transactionBuf = Buffer.from(tx.serializedTransaction as string, 'base64');
      transaction = VersionedTransaction.deserialize(transactionBuf);
      transaction.sign([this.keypair]);

      // Check if in example mode
      const isExampleMode = this.runtime.getSetting('CHROMA_EXAMPLE_MODE');
      if (isExampleMode) {
        elizaLogger.log('Example mode: Simulating transaction instead of sending');
        const simulation = await this.connection.simulateTransaction(transaction);
        elizaLogger.log('Simulation result:', simulation);
        return `simulation_${simulation.value.err ? 'failed' : 'success'}`;
      }

      // Get latest blockhash and send transaction
      const latestBlockHash = await this.connection.getLatestBlockhash();
      const rawTransaction = transaction.serialize();
      const signature = await this.connection.sendRawTransaction(rawTransaction, {
        skipPreflight: true,
        maxRetries: 2
      });

      await this.connection.confirmTransaction({
        blockhash: latestBlockHash.blockhash,
        lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
        signature
      });

      elizaLogger.success(`Solana transaction sent with signature: ${signature}`);
      return signature;
    } catch (error) {
      elizaLogger.error('Solana transaction signing/sending failed:', error);
      throw error;
    }
  }
}
