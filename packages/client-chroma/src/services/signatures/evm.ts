import { IAgentRuntime, elizaLogger } from '@elizaos/core';
import { DeriveKeyProvider } from '@elizaos/plugin-tee';
import {
  Account,
  Chain,
  PublicClient,
  createPublicClient,
  createWalletClient,
  http,
  Transport
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia, optimismSepolia, arbitrumSepolia, baseSepolia, mainnet, optimism, arbitrum, base } from 'viem/chains';
import { TransactionProposal, BaseTransaction } from '../../types';
import { BaseSignatureHandler, ChainAccount } from './types';

// Updated interface to avoid wallet client creation during initialization
interface ChainClientsMap {
  [chainId: number]: {
    publicClient: PublicClient;
    chain: Chain;
    transport: Transport;
  };
}

// Mapping of chain identifiers to Alchemy subdomains
const CHAIN_SUBDOMAINS: Record<number, string> = {
  [mainnet.id]: 'eth-mainnet',
  [optimism.id]: 'opt-mainnet',
  [arbitrum.id]: 'arb-mainnet',
  [base.id]: 'base-mainnet',
  [sepolia.id]: 'eth-sepolia',
  [optimismSepolia.id]: 'opt-sepolia',
  [arbitrumSepolia.id]: 'arb-sepolia',
  [baseSepolia.id]: 'base-sepolia'
};

// List of supported chains
const SUPPORTED_CHAINS = [sepolia, optimismSepolia, arbitrumSepolia, baseSepolia, mainnet, optimism, arbitrum, base];

export class EVMSignatureHandler extends BaseSignatureHandler {
  private chainClients: ChainClientsMap = {};
  private account?: Account;
  private defaultChain: Chain = sepolia; // Default to sepolia
  private gasConfig = {
    priorityMultiplier: 1.2, // 20% increase by default for replacement transactions
    gasLimitBuffer: 1.1     // 10% buffer on estimated gas limit
  };

  supportsChain(proposal: TransactionProposal): boolean {
    // TODO: Improve, but for now all Solana transactions are serialized
    return !proposal.transaction?.serializedTransaction;
  }

  async initialize(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;

    // Initialize chain clients (done once)
    const alchemyApiKey = this.runtime.getSetting('CHROMA_ALCHEMY_API_KEY');

    if (!alchemyApiKey) {
      throw new Error('CHROMA_ALCHEMY_API_KEY not configured');
    }

    for (const chain of SUPPORTED_CHAINS) {
      try {
        const subdomain = CHAIN_SUBDOMAINS[chain.id];

        if (!subdomain) {
          throw new Error(`No Alchemy subdomain found for chain ID ${chain.id}`);
        }

        const url = `https://${subdomain}.g.alchemy.com/v2/${alchemyApiKey}`;
        const transport = http(url);

        const publicClient = createPublicClient({
          chain,
          transport
        });

        // Store only publicClient and chain information
        this.chainClients[chain.id] = {
          // @ts-ignore
          publicClient,
          chain,
          transport
        };

        elizaLogger.debug(`Initialized EVM chain client for ${chain.name} (${chain.id})`);
      } catch (error) {
        elizaLogger.error(`Failed to initialize EVM chain client for ${chain.name}:`, error);
      }
    }

    // Initialize account
    try {
      const chains = this.runtime.getSetting('CHROMA_EVM_CHAINS');

      if (!chains) {
        elizaLogger.warn('CHROMA_EVM_CHAINS not configured');
        return;
      }

      const privateKey = this.runtime.getSetting('CHROMA_EVM_PRIVATE_KEY');

      if (privateKey) {
        elizaLogger.log('Using traditional private key signing');
        this.account = privateKeyToAccount(privateKey as `0x${string}`);
      } else {
        elizaLogger.log('Using TEE-based signing');
        const teeMode = this.runtime.getSetting('TEE_MODE');
        const walletSecretSalt = this.runtime.getSetting('WALLET_SECRET_SALT');

        if (!walletSecretSalt) {
          throw new Error('Wallet secret salt not configured for TEE signing');
        }

        const deriveKeyProvider = new DeriveKeyProvider(teeMode);
        const result = await deriveKeyProvider.deriveEcdsaKeypair(
          '/',
          walletSecretSalt,
          this.runtime.agentId
        );

        const derivedPrivateKey = (result as any).keypair.privateKey as `0x${string}`;
        this.account = privateKeyToAccount(derivedPrivateKey);
      }

      elizaLogger.debug(`EVM account initialized: ${this.account.address}`);
    } catch (error) {
      elizaLogger.error('Failed to initialize EVM account:', error);
    }
  }

  async getAccount(type: 'evm' | 'solana'): Promise<ChainAccount> {
    if (type !== 'evm') {
      throw new Error(`EVMSignatureHandler doesn't support ${type} accounts`);
    }

    const chains = this.runtime.getSetting('CHROMA_EVM_CHAINS');

    if (!chains) {
      throw new Error('CHROMA_EVM_CHAINS not configured');
    }

    if (!this.account) {
      throw new Error('EVM account not initialized');
    }

    const chainNames = chains.split(',').map(chain => chain.trim());

    return {
      type: 'evm',
      address: this.account.address,
      evmAccount: this.account,
      chains: chainNames
    };
  }

  private getClientsForChain(chainId: number) {
    const clients = this.chainClients[chainId];

    if (!clients) {
      throw new Error(`No clients initialized for chain ID ${chainId}`);
    }

    return clients;
  }

  async signProposal(proposal: TransactionProposal): Promise<string | string[]> {
    try {
      // Get the EVM account
      const account = await this.getAccount('evm');

      if (!proposal.transactions || proposal.transactions.length === 0) {
        elizaLogger.warn('No transactions found in proposal');
        return [];
      }

      // If proposal has multiple transactions, process them sequentially
      if (proposal.transactions) {
        const results: string[] = [];

        for (const tx of proposal.transactions) {
          const hash = await this.processTransaction(tx, account);

          results.push(hash);
        }

        return results;
      }
    } catch (error) {
      elizaLogger.error('Failed to sign proposal:', error);
      throw error;
    }
  }

  /**
   * Configure gas parameters for transactions
   * @param config Gas configuration parameters
   */
  configureGas(config: { priorityMultiplier?: number; gasLimitBuffer?: number }) {
    if (config.priorityMultiplier !== undefined) {
      this.gasConfig.priorityMultiplier = config.priorityMultiplier;
    }
    if (config.gasLimitBuffer !== undefined) {
      this.gasConfig.gasLimitBuffer = config.gasLimitBuffer;
    }
  }

  async processTransaction(tx: BaseTransaction, account: ChainAccount): Promise<string> {
    try {
      const chainId = tx.chainId ? Number(tx.chainId) : this.defaultChain.id;
      const clients = this.getClientsForChain(chainId);
      const { publicClient, chain, transport } = clients;

      if (!publicClient) {
        throw new Error(`No client available for chain ID ${chainId}`);
      }

      if (!tx.data) {
        throw new Error('Transaction data is required');
      }

      if (!account.evmAccount) {
        throw new Error('No EVM account available for transaction');
      }

      // Create a new wallet client with account for this specific chain
      const transactionWalletClient = createWalletClient({
        chain,
        transport,
        account: account.evmAccount
      });

      // Estimate gas for the transaction
      let gasEstimate: bigint;
      try {
        gasEstimate = await publicClient.estimateGas({
          account: account.evmAccount,
          to: tx.to as `0x${string}`,
          data: tx.data as `0x${string}`,
          value: tx.value ? BigInt(tx.value) : undefined
        });
      } catch (error) {
        elizaLogger.warn('⚠️ Gas estimation failed, using default gas limit:', error);
        gasEstimate = BigInt(21000); // Default gas limit for simple transactions
        // For contract interactions we need higher limit
        if (tx.data && tx.data !== '0x') {
          gasEstimate = BigInt(300000); // Higher default for contract interactions
        }
      }

      // Apply buffer to gas estimate
      const gasLimit = BigInt(Math.ceil(Number(gasEstimate) * this.gasConfig.gasLimitBuffer));

      // Get current gas price and base fee
      const feeData = await publicClient.estimateFeesPerGas();

      // Calculate priority fee with multiplier for replacement transactions
      const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?
        BigInt(Math.ceil(Number(feeData.maxPriorityFeePerGas) * this.gasConfig.priorityMultiplier)) :
        undefined;

      const maxFeePerGas = feeData.maxFeePerGas ?
        (feeData.gasPrice ?
          BigInt(Math.ceil(Number(feeData.gasPrice) * this.gasConfig.priorityMultiplier)) :
          BigInt(Math.ceil(Number(feeData.maxFeePerGas) * this.gasConfig.priorityMultiplier))) :
        undefined;

      elizaLogger.info(`🔧 Gas parameters: limit=${gasLimit}, maxFeePerGas=${maxFeePerGas}, maxPriorityFeePerGas=${maxPriorityFeePerGas}`);

      // Send the transaction
      const hash = await transactionWalletClient.sendTransaction({
        account: account.evmAccount,
        to: tx.to as `0x${string}`,
        data: tx.data as `0x${string}`,
        value: tx.value ? BigInt(tx.value) : undefined,
        gas: gasLimit,
        maxFeePerGas,
        maxPriorityFeePerGas,
        kzg: undefined,
        chain
      });

      await publicClient.waitForTransactionReceipt({ hash });

      elizaLogger.info(`💳 Transaction sent: ${hash} on chain ID ${chainId}`);
      return hash;
    } catch (error) {
      elizaLogger.error('💥 Failed to process transaction:', error);
      throw error;
    }
  }
}
