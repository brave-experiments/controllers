import BigNumber from 'bignumber.js';
import { handleFetch, timeoutFetch, constructTxParams, BNToHex } from '../util';
import { APIAggregatorMetadataResponse, APIAggregatorTradesResponse, APIAsset, APIToken, APITrade, APITradeParams, APITradeRequest, APITrades, APIType } from './SwapsInterfaces';

export const ETH_SWAPS_TOKEN_ADDRESS = '0x0000000000000000000000000000000000000000';

export const ETH_SWAPS_TOKEN_OBJECT: APIToken = {
  symbol: 'ETH',
  name: 'Ether',
  address: ETH_SWAPS_TOKEN_ADDRESS,
  decimals: 18,
  iconUrl: 'images/black-eth-logo.svg',
};

export const DEFAULT_ERC20_APPROVE_GAS = '0x1d4c0';

// The MAX_GAS_LIMIT is a number that is higher than the maximum gas costs we have observed on any aggregator
const MAX_GAS_LIMIT = 2500000;

export const SWAPS_CONTRACT_ADDRESS = '0x881d40237659c251811cec9c364ef91dc08d300c';

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
}: APITradeParams): Promise<APITrades> {

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
  const tradesResponse = (await timeoutFetch(tradeURL, { method: 'GET' }, 15000)) as APITrade[];

  const newQuotes = tradesResponse.reduce((aggIdTradeMap: APIAggregatorTradesResponse, quote: APITrade) => {
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

export async function fetchTokens(): Promise<APIToken[]> {
  const tokenUrl = getBaseApiURL(APIType.TOKENS);
  const tokens: APIToken[] = await handleFetch(tokenUrl, { method: 'GET' });
  const filteredTokens = tokens.filter((token) => {
    return token.address !== ETH_SWAPS_TOKEN_ADDRESS;
  });
  tokens.push(ETH_SWAPS_TOKEN_OBJECT);
  return filteredTokens;
}

export async function fetchAggregatorMetadata() {
  const aggregatorMetadataUrl = getBaseApiURL(APIType.AGGREGATOR_METADATA);
  const aggregators: APIAggregatorMetadataResponse = await handleFetch(aggregatorMetadataUrl, { method: 'GET' });
  return aggregators;
}

export async function fetchTopAssets(): Promise<APIAsset[]> {
  const topAssetsUrl = getBaseApiURL(APIType.TOP_ASSETS);
  const response: APIAsset[] = await handleFetch(topAssetsUrl, { method: 'GET' });
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
