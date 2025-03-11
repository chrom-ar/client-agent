interface ExampleConfig {
  name: string;
  operation: string;
  type: 'single' | 'cdp' | 'multi';
}

export const EXAMPLE_CONFIGS: Record<string, ExampleConfig> = {
  bridge_usdc_to_base: {
    name: 'Bridge USDC to Base',
    operation: 'Bridge 9.99589 USDC from Optimism to Base',
    type: 'single'
  },
  bridge_usdc_to_optimism: {
    name: 'Bridge USDC to Optimism Example',
    operation: 'Bridge 1.5 USDC from Sepolia to Optimism Sepolia',
    type: 'single'
  },
  bridge_usdc_from_base_to_optimism: {
    name: 'Bridge USDC from Base to Optimism',
    operation: 'Bridge 9.985097 USDC from Base to Optimism',
    type: 'single'
  },
  bridge_usdc_to_solana: {
    name: 'Bridge USDC to Solana Example',
    operation: 'Bridge 1.5 USDC from Sepolia to Solana',
    type: 'single'
  },
  deposit_dai_on_optimism: {
    name: 'Deposit DAI on Optimism',
    operation: 'Generate yield via deposit 19.966634 DAI on Optimism',
    type: 'single'
  },
  deposit_usdc_on_optimism: {
    name: 'Deposit USDC on Optimism',
    operation: 'Generate yield via deposit 19.962961 USDC on Optimism',
    type: 'single'
  },
  deposit_usdc_on_curve_optimism: {
    name: 'Deposit USDC on Curve Optimism',
    operation: 'Generate yield via deposit 9.987936 USDC on Curve Optimism',
    type: 'single'
  },
  find_best_yield: {
    name: 'Find Best Yield Example',
    operation: 'Find the best yield for USDC on Optimism and Arbitrum',
    type: 'multi'
  },
  find_best_yield_single_chain: {
    name: 'Find Best Yield Example',
    operation: 'Find the best yield for USDC on Optimism',
    type: 'single'
  },
  swap_sol: {
    name: 'Swap SOL Example',
    operation: 'Swap 0.01 SOL for USDC',
    type: 'single'
  },
  swap_eth: {
    name: 'Swap ETH Example',
    operation: 'Swap 0.01 ETH for USDC on Sepolia',
    type: 'single'
  },
  swap_eth_on_base: {
    name: 'Swap ETH on Base Example',
    operation: 'Swap 0.01 ETH for USDC on Base',
    type: 'single'
  },
  swap_usdc_for_dai_on_optimism: {
    name: 'Swap USDC for DAI on Optimism',
    operation: 'Swap 19.967080 USDC for DAI on Optimism',
    type: 'single'
  },
  swap_usdc_for_usdc_e_on_optimism: {
    name: 'Swap USDC for USDC.e on Optimism',
    operation: 'Swap 10 USDC for USDC.e on Optimism',
    type: 'single'
  },
  swap_usdc_e_for_usdc_on_optimism: {
    name: 'Swap USDC.e for USDC on Optimism',
    operation: 'Swap 10.001853 USDC.e for USDC on Optimism',
    type: 'single'
  },
  transfer: {
    name: 'Transfer ETH Example',
    operation: 'Transfer 0.0001 ETH to 0xf8Ead621c50Dd72fBd7F9C4517B05f50f5168041',
    type: 'single'
  },
  withdraw_usdc_from_optimism: {
    name: 'Withdraw USDC from Optimism',
    operation: 'Withdraw 19.967076 USDC from Optimism',
    type: 'single'
  },
  withdraw_usdc_from_curve_optimism: {
    name: 'Withdraw USDC from Curve Optimism',
    operation: 'Withdraw 9.827231331784442934 crvUSDC from Curve Optimism',
    type: 'single'
  },
};
