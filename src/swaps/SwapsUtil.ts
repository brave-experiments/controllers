import BigNumber from 'bignumber.js';
import { handleFetch, timeoutFetch, constructTxParams, BNToHex } from '../util';
import {
  APIAggregatorMetadata,
  SwapsAsset,
  SwapsToken,
  APITradeRequest,
  APIType,
  SwapsTrade,
  APIFetchQuotesParams,
} from './SwapsInterfaces';

export const ETH_SWAPS_TOKEN_ADDRESS = '0x0000000000000000000000000000000000000000';

export const ETH_SWAPS_TOKEN_OBJECT: SwapsToken = {
  symbol: 'ETH',
  name: 'Ether',
  address: ETH_SWAPS_TOKEN_ADDRESS,
  decimals: 18,
};

export const DEFAULT_ERC20_APPROVE_GAS = '0x1d4c0';

// The MAX_GAS_LIMIT is a number that is higher than the maximum gas costs we have observed on any aggregator
const MAX_GAS_LIMIT = 2500000;

export const SWAPS_CONTRACT_ADDRESS = '0x881d40237659c251811cec9c364ef91dc08d300c';

export enum SwapsError {
  QUOTES_EXPIRED_ERROR = 'quotes-expired',
  SWAP_FAILED_ERROR = 'swap-failed-error',
  ERROR_FETCHING_QUOTES = 'error-fetching-quotes',
  QUOTES_NOT_AVAILABLE_ERROR = 'quotes-not-available',
  OFFLINE_FOR_MAINTENANCE = 'offline-for-maintenance',
  SWAPS_FETCH_ORDER_CONFLICT = 'swaps-fetch-order-conflict',
}

// Functions

export const getBaseApiURL = function (type: APIType): string {
  switch (type) {
    case APIType.TRADES:
      return 'https://api.metaswap.codefi.network/trades';
    case APIType.TOKENS:
      return 'https://api.metaswap.codefi.network/tokens';
    case APIType.TOP_ASSETS:
      return 'https://api.metaswap.codefi.network/topAssets';
    case APIType.FEATURE_FLAG:
      return 'https://api.metaswap.codefi.network/featureFlag';
    case APIType.AGGREGATOR_METADATA:
      return 'https://api.metaswap.codefi.network/aggregatorMetadata';
    default:
      throw new Error('getBaseApiURL requires an api call type');
  }
};

export async function fetchTradesInfo({
  slippage,
  sourceToken,
  sourceAmount,
  destinationToken,
  fromAddress,
  exchangeList,
}: APIFetchQuotesParams): Promise<{ [key: string]: SwapsTrade }> {
  const urlParams: APITradeRequest = {
    destinationToken,
    sourceToken,
    sourceAmount,
    slippage,
    timeout: 10000,
    walletAddress: fromAddress,
  };

  if (exchangeList) {
    urlParams.exchangeList = exchangeList;
  }

  const tradeURL = `${getBaseApiURL(APIType.TRADES)}?${new URLSearchParams(urlParams as Record<any, any>).toString()}`;

  const tradesResponse = (await timeoutFetch(tradeURL, { method: 'GET' }, 15000)) as SwapsTrade[];
  const newQuotes = tradesResponse.reduce((aggIdTradeMap: { [key: string]: SwapsTrade }, quote: SwapsTrade) => {
    if (quote.trade && !quote.error) {
      const constructedTrade = constructTxParams({
        to: quote.trade.to,
        from: quote.trade.from,
        data: quote.trade.data,
        amount: BNToHex(quote.trade.value),
        gas: BNToHex(quote.maxGas),
      });

      let { approvalNeeded } = quote;

      if (approvalNeeded) {
        approvalNeeded = constructTxParams({
          ...approvalNeeded,
        });
      }

      return {
        ...aggIdTradeMap,
        [quote.aggregator]: {
          ...quote,
          slippage,
          trade: constructedTrade,
          approvalNeeded,
        },
      };
    }

    return aggIdTradeMap;
  }, {});

  return newQuotes;
}

export async function fetchTokens(): Promise<SwapsToken[]> {
  const tokenUrl = getBaseApiURL(APIType.TOKENS);
  const tokens: SwapsToken[] = await handleFetch(tokenUrl, { method: 'GET' });
  const filteredTokens = tokens.filter((token) => {
    return token.address !== ETH_SWAPS_TOKEN_ADDRESS;
  });
  filteredTokens.push(ETH_SWAPS_TOKEN_OBJECT);
  return filteredTokens;
}

export async function fetchAggregatorMetadata() {
  const aggregatorMetadataUrl = getBaseApiURL(APIType.AGGREGATOR_METADATA);
  const aggregators: { [key: string]: APIAggregatorMetadata } = await handleFetch(aggregatorMetadataUrl, {
    method: 'GET',
  });
  return aggregators;
}

export async function fetchTopAssets(): Promise<SwapsAsset[]> {
  const topAssetsUrl = getBaseApiURL(APIType.TOP_ASSETS);
  const response: SwapsAsset[] = await handleFetch(topAssetsUrl, { method: 'GET' });
  return response;
}

export async function fetchSwapsFeatureLiveness(): Promise<boolean> {
  try {
    const status = await handleFetch(getBaseApiURL(APIType.FEATURE_FLAG), { method: 'GET' });
    return status?.active;
  } catch (err) {
    return false;
  }
}

export async function fetchTokenPrice(address: string): Promise<string> {
  const query = `contract_addresses=${address}&vs_currencies=eth`;
  const prices = await handleFetch(`https://api.coingecko.com/api/v3/simple/token_price/ethereum?${query}`, {
    method: 'GET',
  });
  return prices && prices[address]?.eth;
}

export function calculateGasEstimateWithRefund(
  maxGas = MAX_GAS_LIMIT,
  estimatedRefund = 0,
  estimatedGas = 0,
): BigNumber {
  const maxGasMinusRefund = new BigNumber(maxGas, 10).minus(estimatedRefund);
  const estimatedGasBN = new BigNumber(estimatedGas);
  const gasEstimateWithRefund = maxGasMinusRefund.lt(estimatedGasBN) ? maxGasMinusRefund : estimatedGasBN;
  return gasEstimateWithRefund;
}

export function calculateMaxNetworkFee(approvalGas: string | null, estimatedGas: string, maxGas: number): number {
  if (approvalGas) {
    return parseInt(approvalGas, 16) + maxGas;
  }
  return Math.max(maxGas, parseInt(estimatedGas, 16));
}

export function calculateEstimatedNetworkFee(
  approvalGas: string | null,
  estimatedGas: string,
  maxGas: number,
  estimatedRefund: number,
  averageGas: number,
): number {
  if (approvalGas) {
    return parseInt(approvalGas, 16) + averageGas;
  }
  return calculateGasEstimateWithRefund(maxGas, estimatedRefund, parseInt(estimatedGas, 16)).toNumber();
}

/**
 * Calculates the median of a sample of BigNumber values.
 *
 * @param {BigNumber[]} values - A sample of BigNumber values.
 * @returns {BigNumber} The median of the sample.
 */
export function getMedian(values: BigNumber[]) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('Expected non-empty array param.');
  }
  const sorted = [...values].sort((a, b) => {
    if (a.eq(b)) {
      return 0;
    }
    return a.lt(b) ? -1 : 1;
  });

  if (sorted.length % 2 === 1) {
    // return middle value
    return sorted[(sorted.length - 1) / 2];
  }
  // return mean of middle two values
  const upperIndex = sorted.length / 2;
  return sorted[upperIndex].plus(sorted[upperIndex - 1]).div(2);
}
