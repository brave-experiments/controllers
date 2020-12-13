import BigNumber from 'bignumber.js';
import { Transaction } from '../transaction/TransactionController';

export enum APIType {
  TRADES = 'TRADES',
  TOKENS = 'TOKENS',
  TOP_ASSETS = 'TOP_ASSETS',
  FEATURE_FLAG = 'FEATURE_FLAG',
  AGGREGATOR_METADATA = 'AGGREGATOR_METADATA',
  GAS_PRICES = 'GAS_PRICES',
}

export interface SwapsAsset {
  address: string;
  symbol: string;
  name?: string;
}

export interface SwapsToken extends SwapsAsset {
  decimals: number;
  occurances?: number;
  iconUrl?: string;
}

/**
 * Metadata needed to fetch quotes
 *
 * @interface APIFetchQuotesMetadata
 *
 * @sourceTokenInfo Source token information
 * @destinationTokenInfo Destination token information
 * @accountBalance Current ETH account balance
 * @destinationTokenConversionRate Current conversion rate to ETH of destination token
 *
 */
export interface APIFetchQuotesMetadata {
  sourceTokenInfo: SwapsToken;
  destinationTokenInfo: SwapsToken;
  accountBalance: string;
  destinationTokenConversionRate?: string;
}

/**
 * Parameters needed to fetch quotes
 *
 * @interface APIFetchQuotesParams
 *
 * @slippage Slippage
 * @sourceToken Source token address
 * @sourceAmount Source token amount
 * @destinationToken Destination token address
 * @walletAddress Address to do the swap from
 * @exchangeList
 * @balanceError
 * @metaData Metadata needed to fetch quotes
 *
 */
export interface APIFetchQuotesParams {
  slippage: number;
  sourceToken: string;
  sourceAmount: number;
  destinationToken: string;
  walletAddress: string;
  exchangeList?: string[];
  balanceError?: boolean;
  timeout?: number;
}

/**
 * Aggregator metadata coming from API
 *
 * @interface APIAggregatorMetadata
 *
 */
export interface APIAggregatorMetadata {
  color: string;
  title: string;
  icon: string;
}

interface QuoteTransaction extends Transaction {
  value: string;
}

/**
 * Savings of a quote
 *
 * @interface QuoteSavings
 */
export interface QuoteSavings {
  total: BigNumber;
  performance: BigNumber;
  fee: BigNumber;
  medianMetaMaskFee: BigNumber;
}

/**
 * Trade data structure coming from API, together with savings and gas estimations.
 *
 * @interface Quote
 *
 * @trade The ethereum transaction data for the swap
 * @approvalNeeded Ethereum transaction to complete a ERC20 approval, if needed
 * @sourceAmount Amount in minimal unit to send
 * @destinationAmount Amount in minimal unit to receive
 * @error Trade error, if any
 * @sourceToken Source token address
 * @destinationToken Destination token address
 * @maxGas Maximum gas to use
 * @averageGas Average gas to use
 * @estimatedRefund Destination token address
 * @fetchTime Fetch time
 * @fee MetaMask fee
 * @gasMultiplier
 * @aggregator Aggregator id
 * @aggType Aggregator type
 * @priceSlippage Price slippage information object
 * @savings Estimation of savings
 * @gasEstimate Estimation of gas
 * @gasEstimateWithRefund Estimation of gas with refund
 */
export interface Quote {
  trade: QuoteTransaction;
  approvalNeeded: null | {
    data: string;
    to: string;
    from: string;
    gas: string;
  };
  sourceAmount: string;
  destinationAmount: number;
  error: null | Error;
  sourceToken: string;
  destinationToken: string;
  maxGas: number;
  averageGas: number;
  estimatedRefund: number;
  fetchTime: number;
  aggregator: string;
  aggType: string;
  fee: number;
  gasMultiplier: number;
  savings: QuoteSavings | null;
  gasEstimate: string | null;
  gasEstimateWithRefund: number | null;
}

/**
 * Trade fees information for one aggregator
 *
 * @interface QuoteFees
 *
 * @aggregator Aggregator id
 * @ethFee Fee in ETH
 * @maxEthFee Maximum fee in ETH
 * @ethValueOfTokens Total value of tokens in ETH
 * @overallValueOfQuote
 * @metaMaskFeeInEth MetaMask fee in ETH
 */
export interface QuoteFees {
  aggregator: string;
  ethFee: string;
  maxEthFee: string;
  ethValueOfTokens: string;
  overallValueOfQuote: string;
  metaMaskFeeInEth: string;
}
