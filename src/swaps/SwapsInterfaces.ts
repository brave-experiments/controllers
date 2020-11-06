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
  [key: string]: APITrade;
}

export interface SwapsSavings {
  total: BigNumber;
  performance: BigNumber;
  fee: BigNumber;
}

export interface SwapsBestQuote {
  topAggId: string;
  ethTradeValueOfBestQuote: BigNumber;
  ethFeeForBestQuote: BigNumber;
  isBest: boolean;
}

export interface SwapValues {
  allEthTradeValues: BigNumber[];
  allEthFees: BigNumber[];
}

export interface SwapsBestQuoteAndSwapValues {
  bestQuote: SwapsBestQuote;
  values: SwapValues;
}

export interface SwapsBestQuoteAndSavings {
  bestQuote: SwapsBestQuote;
  savings: SwapsSavings;
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

export interface APITrade {
  trade: Transaction;
  approvalNeeded: null | {
    data: string;
    to: string;
    from: string;
  };
  sourceAmount: string;
  destinationAmount: string;
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
}

export interface APIAggregatorTradesResponse {
  [key: string]: APITrade;
}

export interface APIAggregatorMetadataResponse {
  [key: string]: APIAggregatorMetadata;
}

export interface APIAggregatorMetadata {
  color: string;
  title: string;
  icon: string;
}

export interface APITradeParams {
  slippage: number;
  sourceToken: string;
  sourceAmount: string;
  destinationToken: string;
  fromAddress: string;
  exchangeList?: string[];
  //
  metaData?: Record<string, any>;
}
