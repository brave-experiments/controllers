import BigNumber from 'bignumber.js';
import { Transaction } from '../transaction/TransactionController';

export enum APIType {
  TRADES = 'TRADES',
  TOKENS = 'TOKENS',
  TOP_ASSETS = 'TOP_ASSETS',
  FEATURE_FLAG = 'FEATURE_FLAG',
  AGGREGATOR_METADATA = 'AGGREGATOR_METADATA',
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

export interface SwapsQuoteSavings {
  total: BigNumber;
  performance: BigNumber;
  fee: BigNumber;
  medianMetaMaskFee: BigNumber;
}

export interface SwapsQuote {
  topAggId: string;
  isBest?: boolean;
  sourceTokenInfo?: string;
  destinationTokenInfo?: SwapsToken;
  gasEstimateWithRefund?: BigNumber;
  gasEstimate: string | null;
  savings?: SwapsQuoteSavings;
}

export interface SwapsAllValues {
  allEthTradeValues: BigNumber[];
  allEthFees: BigNumber[];
}

export interface APITradeRequest {
  sourceToken: string;
  destinationToken: string;
  sourceAmount: number;
  slippage: number;
  excludeFees?: boolean;
  txOriginAddress?: string;
  timeout: number;
  walletAddress: string;
  exchangeList?: string[];
}

export interface APIFetchQuotesMetadata {
  sourceTokenInfo: SwapsToken;
  destinationTokenInfo: SwapsToken;
  accountBalance: string;
  destinationTokenConversionRate?: string;
}

export interface APIFetchQuotesParams {
  slippage: number;
  sourceToken: string;
  sourceAmount: number;
  destinationToken: string;
  fromAddress: string;
  exchangeList?: string[];
  balanceError?: boolean;
  metaData: APIFetchQuotesMetadata;
}

export interface APIAggregatorMetadata {
  color: string;
  title: string;
  icon: string;
}

interface TradeTransaction extends Transaction {
  value: string;
}

export interface SwapsTrade {
  trade: TradeTransaction;
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
  gasMultiplier?: number;
  savings?: SwapsQuoteSavings;
  gasEstimate: string | null;
  maxNetworkFee: null | number;
  estimatedNetworkFee?: number;
}

export interface TradeFees {
  ethFee: string;
  ethValueOfTokens: string;
  overallValueOfQuote: string;
  metaMaskFeeInEth: string;
}
