import BigNumber from 'bignumber.js';
import { Transaction } from '../transaction/TransactionController';

export interface SwapsTokenObject {
  address: string;
  symbol: string;
  decimals: number;
  occurances?: number;
  iconUrl?: string;
}

export interface SwapsQuotes {
  [key: string]: SwapsQuote;
}

export interface SwapsSavings {
  total: BigNumber;
  performance: BigNumber;
  fee: BigNumber;
}

export interface SwapsQuote {
  topAggId: string;
  ethTradeValueOfBestQuote: BigNumber;
  ethFeeForBestQuote: BigNumber;
  isBest?: boolean;
  sourceTokenInfo?: string;
  destinationTokenInfo?: APIToken;
  gasEstimateWithRefund?: BigNumber;
  gasEstimate?: number;
  savings?: SwapsSavings;
}

export interface SwapsValues {
  allEthTradeValues: BigNumber[];
  allEthFees: BigNumber[];
}

export interface SwapsBestQuoteAndSwapValues {
  bestQuote: SwapsQuote;
  values: SwapsValues;
}

export enum SwapsError {
  QUOTES_EXPIRED_ERROR = 'quotes-expired',
  SWAP_FAILED_ERROR = 'swap-failed-error',
  ERROR_FETCHING_QUOTES = 'error-fetching-quotes',
  QUOTES_NOT_AVAILABLE_ERROR = 'quotes-not-avilable',
  OFFLINE_FOR_MAINTENANCE = 'offline-for-maintenance',
  SWAPS_FETCH_ORDER_CONFLICT = 'swaps-fetch-order-conflict',
}

export enum APIType {
  TRADES = 'TRADES',
  TOKENS = 'TOKENS',
  TOP_ASSETS = 'TOP_ASSETS',
  FEATURE_FLAG = 'FEATURE_FLAG',
  AGGREGATOR_METADATA = 'AGGREGATOR_METADATA',
}

export interface APITradeRequest {
  sourceToken: string;
  destinationToken: string;
  sourceAmount: string;
  slippage: number;
  excludeFees?: boolean;
  txOriginAddress?: string;
  timeout: number;
  walletAddress: string;
  exchangeList?: null | string[];
}

export interface APIAsset {
  address: string;
  symbol: string;
  name?: string;
}

export interface APIToken extends APIAsset {
  decimals: number;
  occurances?: number;
  iconUrl?: string;
}

export interface APITrades {
  [key: string]: APITrade;
}

export interface APITradesMetadata {
  [key: string]: APITradeMetadata;
}

export interface APITradesMetadataWithGas {
  [key: string]: APITradeMetadataWithGas;
}

export interface APITrade {
  trade: Transaction;
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
  gasEstimate?: number;
  gasEstimateWithRefund?: BigNumber;
  isBest?: boolean;
  savings?: SwapsSavings;
}

export interface APITradeMetadata {
  sourceTokenInfo: string;
  destinationTokenInfo: APIToken;
  accountBalance: string;
}

export interface APITradeMetadataWithGas extends APITradeMetadata {
  gasEstimate?: number;
  gasEstimateWithRefund?: BigNumber;
  isBest?: boolean;
  savings?: SwapsSavings;
}

export interface APIAggregatorTradesResponse {
  [key: string]: APITrade;
}

export interface APIAggregatorMetadata {
  color: string;
  title: string;
  icon: string;
}

export interface APIAggregatorMetadataResponse {
  [key: string]: APIAggregatorMetadata;
}

export interface SwapsQuoteParams extends APITradeParams {
  metaData: APITradeMetadata;
}

export interface APITradeParams {
  slippage: number;
  sourceToken: string;
  sourceAmount: string;
  destinationToken: string;
  fromAddress: string;
  exchangeList?: string[];
  balanceError?: boolean;
  //
}
