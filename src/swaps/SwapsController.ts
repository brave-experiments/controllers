import BigNumber from 'bignumber.js';
import BaseController, { BaseConfig, BaseState } from '../BaseController';
import NetworkController from '../network/NetworkController';
import TokenRatesController from '../assets/TokenRatesController';
import { calcTokenAmount, estimateGas, query } from '../util';
import { Transaction } from '../transaction/TransactionController';
import { calculateGasEstimateWithRefund, fetchTradesInfo, getMedian } from './SwapsUtil';
import {
  APITrade,
  APITradeMetadata,
  APITradeMetadataWithGas,
  APITrades,
  APITradesMetadata,
  APITradesMetadataWithGas,
  SwapsBestQuoteAndSwapValues,
  SwapsError,
  SwapsQuote,
  SwapsQuoteParams,
  SwapsSavings,
  SwapsTokenObject,
  SwapsValues,
} from './SwapsInterfaces';

const abiERC20 = require('human-standard-token-abi');

const EthQuery = require('eth-query');
const Web3 = require('web3');

const DEFAULT_ERC20_APPROVE_GAS = '0x1d4c0';
const METASWAP_ADDRESS = '0x881d40237659c251811cec9c364ef91dc08d300c';
// An address that the metaswap-api recognizes as ETH, in place of the token address that ERC-20 tokens have
export const ETH_SWAPS_TOKEN_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface SwapsConfig extends BaseConfig {
  maxGasLimit: number;
  pollCountLimit: number;
  metaSwapAddress: string;
}

export interface SwapsState extends BaseState {
  quotes: APITradesMetadataWithGas;
  fetchParams: SwapsQuoteParams;
  tokens: null | SwapsTokenObject[];
  quotesLastFetched: null | number;
  errorKey: null | SwapsError;
  topAggId: null | string;
  swapsFeatureIsLive: boolean;
}

const QUOTE_POLLING_INTERVAL = 50 * 1000;
// The MAX_GAS_LIMIT is a number that is higher than the maximum gas costs we have observed on any aggregator
const MAX_GAS_LIMIT = 2500000;

export default class SwapsController extends BaseController<SwapsConfig, SwapsState> {
  private handle?: NodeJS.Timer;

  private web3: any;

  private ethQuery: any;

  private pollCount = 0;

  private indexOfNewestCallInFlight: number;

  /**
   * Fetch current gas price
   *
   * @returns - Promise resolving to the current gas price
   */
  private async getGasPrice(): Promise<string> {
    const gasPrice = await query('gasPrice', this.ethQuery);
    return gasPrice.toHexString();
  }

  /**
   * Find best quote and ETH values, all quotes fees and all quotes trade values
   *
   * @param quotes - Array of quotes
   * @param customGasPrice - If defined, custom gas price used
   * @returns - Promise resolving to the best quote object and ETH values from quotes
   */
  private async getBestQuoteAndEthValues(
    quotes: APITrades,
    customGasPrice?: string,
  ): Promise<SwapsBestQuoteAndSwapValues> {
    const tokenRatesController = this.context.TokenRatesController as TokenRatesController;
    const { contractExchangeRates } = tokenRatesController.state;

    const allEthTradeValues: BigNumber[] = [];
    const allEthFees: BigNumber[] = [];

    let topAggId = '';
    let ethTradeValueOfBestQuote: BigNumber = new BigNumber(0);
    let ethFeeForBestQuote: BigNumber = new BigNumber(0);

    const usedGasPrice = customGasPrice || (await this.getGasPrice());
    const quotesValues = Object.values(quotes).map((quote) => quote);
    quotesValues.forEach((quote: APITrade) => {
      const {
        aggregator,
        approvalNeeded,
        averageGas,
        destinationAmount = 0,
        destinationToken,
        gasEstimate,
        sourceAmount,
        sourceToken,
        trade,
      } = quote;

      const tradeGasLimitForCalculation = gasEstimate
        ? new BigNumber(gasEstimate, 16)
        : new BigNumber(averageGas || MAX_GAS_LIMIT, 10);

      const totalGasLimitForCalculation = tradeGasLimitForCalculation
        .plus(approvalNeeded?.gas || '0x0', 16)
        .toString(16);

      const gasTotalInWeiHex = new BigNumber(totalGasLimitForCalculation, 16).times(new BigNumber(usedGasPrice, 16));

      // trade.value is a sum of different values depending on the transaction.
      // It always includes any external fees charged by the quote source. In
      // addition, if the source asset is ETH, trade.value includes the amount
      // of swapped ETH.
      const totalWeiCost = new BigNumber(gasTotalInWeiHex, 16).plus(trade.value, 16);

      // The total fee is aggregator/exchange fees plus gas fees.
      // If the swap is from ETH, subtract the sourceAmount from the total cost.
      // Otherwise, the total fee is simply trade.value plus gas fees.
      const ethFee = sourceToken === ETH_SWAPS_TOKEN_ADDRESS ? totalWeiCost.minus(sourceAmount, 10) : totalWeiCost;

      const { destinationTokenInfo } = this.state.fetchParams.metaData;

      const tokenConversionRate = contractExchangeRates[destinationToken];
      const ethValueOfTrade =
        destinationToken === ETH_SWAPS_TOKEN_ADDRESS
          ? calcTokenAmount(destinationAmount, 18).minus(totalWeiCost, 10)
          : new BigNumber(tokenConversionRate || 1, 10)
              .times(calcTokenAmount(destinationAmount, destinationTokenInfo?.decimals), 10)
              .minus(tokenConversionRate ? totalWeiCost : 0, 10);

      // collect values for savings calculation
      allEthTradeValues.push(ethValueOfTrade);
      allEthFees.push(ethFee);

      if (ethValueOfTrade.gt(ethTradeValueOfBestQuote)) {
        topAggId = aggregator;
        ethTradeValueOfBestQuote = ethValueOfTrade;
        ethFeeForBestQuote = ethFee;
      }
    });

    const isBest =
      quotes[topAggId].destinationToken === ETH_SWAPS_TOKEN_ADDRESS ||
      Boolean(contractExchangeRates[quotes[topAggId]?.destinationToken]);

    return {
      bestQuote: { topAggId, isBest, ethTradeValueOfBestQuote, ethFeeForBestQuote },
      values: { allEthTradeValues, allEthFees },
    };
  }

  /**
   * Calculate savings from quotes
   *
   * @param quotes - Quotes to do the calculation
   * @param values - Swaps ETH values, all quotes fees and all quotes trade values
   * @returns - Promise resolving to an object containing best aggregator id and respective savings
   */
  private async calculateSavings(quote: SwapsQuote, values: SwapsValues): Promise<SwapsSavings> {
    const savings: SwapsSavings = { fee: new BigNumber(0), total: new BigNumber(0), performance: new BigNumber(0) };
    // Performance savings are calculated as:
    //   valueForBestTrade - medianValueOfAllTrades
    savings.performance = quote.ethTradeValueOfBestQuote.minus(getMedian(values.allEthTradeValues), 10);

    // Performance savings are calculated as:
    //   medianFeeOfAllTrades - feeForBestTrade
    savings.fee = getMedian(values.allEthFees).minus(quote.ethFeeForBestQuote, 10);

    // Total savings are the sum of performance and fee savings
    savings.total = savings.performance.plus(savings.fee, 10);

    return savings;
  }

  /**
   * Find best quote and savings from specific quotes
   *
   * @param quotes - Quotes to do the calculation
   * @param customGasPrice - If defined, custom gas price used
   * @returns - Promise resolving to an object containing best aggregator id and respective savings
   */
  private async findBestQuoteAndCalulateSavings(
    quotes: APITrades,
    customGasPrice?: string,
  ): Promise<SwapsQuote | null> {
    const numQuotes = Object.keys(quotes).length;
    if (!numQuotes) {
      return null;
    }

    const { bestQuote, values } = await this.getBestQuoteAndEthValues(quotes, customGasPrice);
    const savings = await this.calculateSavings(bestQuote, values);

    return { ...bestQuote, savings };
  }

  /**
   * Get current allowance for a wallet address to access ERC20 contract address funds
   *
   * @param contractAddress - Hex address of the ERC20 contract
   * @param walletAddress - Hex address of the wallet
   * @returns - Promise resolving to allowance number
   */
  private async getERC20Allowance(contractAddress: string, walletAddress: string): Promise<number> {
    const contract = this.web3.eth.contract(abiERC20).at(contractAddress);
    return new Promise<number>((resolve, reject) => {
      contract.allowance(walletAddress, (error: Error, result: number) => {
        /* istanbul ignore if */
        if (error) {
          reject(error);
          return;
        }
        resolve(result);
      });
    });
  }

  private timedoutGasReturn(tradeTxParams: Transaction | null): Promise<{ gas: string | null }> {
    if (!tradeTxParams) {
      return new Promise((resolve) => {
        resolve({ gas: null });
      });
    }
    return new Promise((resolve) => {
      const gasTimeout = setTimeout(() => {
        resolve({ gas: null });
      }, 5000);

      // Remove gas from params that will be passed to the `estimateGas` call
      // Including it can cause the estimate to fail if the actual gas needed
      // exceeds the passed gas
      const tradeTxParamsForGasEstimate = {
        data: tradeTxParams.data,
        from: tradeTxParams.from,
        to: tradeTxParams.to,
        value: tradeTxParams.value,
      };

      return Promise.race([estimateGas(tradeTxParamsForGasEstimate, query), gasTimeout]);
    });
  }

  /**
   * Name of this controller used during composition
   */
  name = 'SwapsController';

  /**
   * List of required sibling controllers this controller needs to function
   */
  requiredControllers = ['NetworkController', 'TokenRatesController'];

  /**
   * Creates a SwapsController instance
   *
   * @param config - Initial options used to configure this controller
   * @param state - Initial state to set on this controller
   */
  constructor(config?: Partial<SwapsConfig>, state?: Partial<SwapsState>) {
    super(config, state);
    this.defaultConfig = {
      maxGasLimit: 2500000,
      pollCountLimit: 3,
      metaSwapAddress: METASWAP_ADDRESS,
    };
    this.defaultState = {
      quotes: {},
      fetchParams: {
        slippage: 0,
        sourceToken: '',
        sourceAmount: '',
        destinationToken: '',
        fromAddress: '',
      },
      tokens: null,
      quotesLastFetched: 0,
      errorKey: null,
      topAggId: null,
      swapsFeatureIsLive: false,
    };
    this.indexOfNewestCallInFlight = 0;

    this.initialize();
  }

  /**
   * Extension point called if and when this controller is composed
   * with other controllers using a ComposableController
   */
  onComposed() {
    super.onComposed();
    const network = this.context.NetworkController as NetworkController;
    const onProviderUpdate = () => {
      if (network.provider) {
        this.ethQuery = new EthQuery(network.provider);
        this.web3 = new Web3(network.provider);
      }
    };
    onProviderUpdate();
    network.subscribe(onProviderUpdate);
  }

  setSwapsTokens(newTokens: null | SwapsTokenObject[]) {
    this.update({ tokens: newTokens });
  }

  setSwapsErrorKey(newErrorKey: null | SwapsError) {
    this.update({ errorKey: newErrorKey });
  }

  setQuotesLastFetched(quotesLastFetched: APITradesMetadataWithGas) {
    this.update({ quotes: quotesLastFetched });
  }

  setSwapsLiveness(isLive: boolean) {
    this.update({ swapsFeatureIsLive: isLive });
  }

  /**
   * Starts a new polling process
   *
   */
  pollForNewQuotes() {
    const { fetchParams } = this.state;
    this.handle && clearTimeout(this.handle);
    this.fetchAndSetQuotes(fetchParams, fetchParams?.metaData || {}, true);
    this.handle = setTimeout(() => {
      this.fetchAndSetQuotes(fetchParams, fetchParams?.metaData || {}, true);
    }, QUOTE_POLLING_INTERVAL);
  }

  /**
   * Stops the polling process
   *
   */
  stopPollingForQuotes() {
    this.handle && clearTimeout(this.handle);
  }

  async getAllQuotesWithGasEstimates(quotes: APITrades): Promise<APITrades> {
    const quoteGasData = await Promise.all(
      Object.values(quotes).map(async (quote) => {
        const { gas } = await this.timedoutGasReturn(quote.trade);
        return { gas, aggId: quote.aggregator };
      }),
    );
    // simulation fail ?
    const newQuotes: APITrades = {};
    quoteGasData.forEach(({ gas, aggId }) => {
      if (gas) {
        const gasEstimateWithRefund = calculateGasEstimateWithRefund(
          quotes[aggId].maxGas,
          quotes[aggId].estimatedRefund,
          parseInt(gas, 16),
        );

        newQuotes[aggId] = {
          ...quotes[aggId],
          gasEstimate: parseInt(gas, 16),
          gasEstimateWithRefund,
        };
      } else if (quotes[aggId].approvalNeeded) {
        // If gas estimation fails, but an ERC-20 approve is needed, then we do not add any estimate property to the quote object
        // Such quotes will rely on the maxGas and averageGas properties from the api
        newQuotes[aggId] = { ...quotes[aggId], gasEstimate: undefined, gasEstimateWithRefund: undefined };
      }
      // If gas estimation fails and no approval is needed, then we filter that quote out, so that it is not shown to the user
    });
    return newQuotes;
  }

  async fetchAndSetQuotes(
    fetchParams: SwapsQuoteParams,
    fetchParamsMetaData: Record<string, any>,
    isPolledRequest?: boolean,
    customGasPrice?: string,
  ) {
    if (!fetchParams) {
      return null;
    }

    // Every time we get a new request that is not from the polling, we reset the poll count so we can poll for up to three more sets of quotes with these new params.
    if (!isPolledRequest) {
      this.pollCount = 0;
    }

    // If there are any pending poll requests, clear them so that they don't get call while this new fetch is in process
    this.handle && clearTimeout(this.handle);

    if (!isPolledRequest) {
      this.setSwapsErrorKey(null);
    }

    const indexOfCurrentCall = this.indexOfNewestCallInFlight + 1;
    this.indexOfNewestCallInFlight = indexOfCurrentCall;

    let apiTrades: APITrades = await fetchTradesInfo(fetchParams);

    // !! sourceTokenInfo and destinationTokenInfo is in state, why add it to all entries?

    const quotesLastFetched = Date.now();

    let approvalRequired = false;

    if (fetchParams.sourceToken !== ETH_SWAPS_TOKEN_ADDRESS && Object.values(apiTrades).length) {
      const allowance = await this.getERC20Allowance(fetchParams.sourceToken, fetchParams.fromAddress);

      // For a user to be able to swap a token, they need to have approved the MetaSwap contract to withdraw that token.
      // getERC20Allowance() returns the amount of the token they have approved for withdrawal. If that amount is greater
      // than 0, it means that approval has already occured and is not needed. Otherwise, for tokens to be swapped, a new
      // call of the ERC-20 approve method is required.

      approvalRequired = allowance === 0;
      if (!approvalRequired) {
        apiTrades = Object(apiTrades).values((quote: APITradeMetadata) => ({
          ...quote,
          approvalNeeded: null,
        }));
      } else if (!isPolledRequest) {
        const quoteTrade = Object.values(apiTrades)[0].trade;

        const transaction: Transaction = {
          data: quoteTrade.data,
          from: quoteTrade.from,
          to: quoteTrade.to,
          value: quoteTrade.value,
        };
        const { gas: approvalGas } = await this.timedoutGasReturn(transaction);

        // !! approvalNeeded is the same for all quotes, why add it to all entries?

        apiTrades = Object(apiTrades).values((quote: APITrade) => ({
          ...quote,
          approvalNeeded: {
            ...quote.approvalNeeded,
            gas: approvalGas || DEFAULT_ERC20_APPROVE_GAS,
          },
        }));
      }
    }

    let topAggId = null;
    let quotes: APITrades = {};
    // We can reduce time on the loading screen by only doing this after the
    // loading screen and best quote have rendered.
    if (!approvalRequired && !fetchParams?.balanceError) {
      quotes = await this.getAllQuotesWithGasEstimates(apiTrades);
    }

    if (Object.values(quotes).length === 0) {
      this.setSwapsErrorKey(SwapsError.QUOTES_NOT_AVAILABLE_ERROR);
    } else {
      const topQuoteData = await this.findBestQuoteAndCalulateSavings(quotes, customGasPrice);

      if (topQuoteData?.topAggId) {
        topAggId = topQuoteData.topAggId;
        quotes[topAggId].isBest = topQuoteData.isBest;
        quotes[topAggId].savings = topQuoteData.savings;
      }
    }

    // If a newer call has been made, don't update state with old information
    // Prevents timing conflicts between fetches
    if (this.indexOfNewestCallInFlight !== indexOfCurrentCall) {
      throw new Error(SwapsError.SWAPS_FETCH_ORDER_CONFLICT);
    }

    this.update({
      quotes,
      fetchParams: { ...fetchParams, metaData: fetchParamsMetaData },
      quotesLastFetched,
      topAggId,
    });

    // We only want to do up to a maximum of three requests from polling.
    this.pollCount += 1;
    if (this.pollCount < this.config.pollCountLimit + 1) {
      this.pollForNewQuotes();
    } else {
      this.resetPostFetchState();
      this.setSwapsErrorKey(SwapsError.QUOTES_EXPIRED_ERROR);
      return null;
    }

    return [quotes, topAggId];
  }

  safeRefetchQuotes() {
    const { fetchParams } = this.state;
    if (!this.handle && fetchParams) {
      this.fetchAndSetQuotes(fetchParams, {});
    }
  }

  resetPostFetchState() {
    const {
      tokens: resetTokens,
      fetchParams: resetFetchParams,
      swapsFeatureIsLive: resetSwapsFeatureIsLive,
    } = this.state;
    this.update({
      ...this.state,
      tokens: resetTokens,
      fetchParams: resetFetchParams,
      swapsFeatureIsLive: resetSwapsFeatureIsLive,
    });
    this.handle && clearTimeout(this.handle);
  }
}
