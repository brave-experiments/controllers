import BigNumber from 'bignumber.js';
import { addHexPrefix } from 'ethereumjs-util';
import BaseController, { BaseConfig, BaseState } from '../BaseController';
import NetworkController from '../network/NetworkController';
import TokenRatesController from '../assets/TokenRatesController';
import { BNToHex, calcTokenAmount, fractionBN, hexToBN } from '../util';
import { Transaction } from '../transaction/TransactionController';
import { fetchTradesInfo, getMedian, SwapsError, APITrade, APITradeParams } from './SwapsUtil';

const Web3 = require('web3');
const abiERC20 = require('human-standard-token-abi');

const EthQuery = require('eth-query');

const DEFAULT_ERC20_APPROVE_GAS = '0x1d4c0';
const METASWAP_ADDRESS = '0x881d40237659c251811cec9c364ef91dc08d300c';
// An address that the metaswap-api recognizes as ETH, in place of the token address that ERC-20 tokens have
export const ETH_SWAPS_TOKEN_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface SwapsTokenObject {
  address: string;
  symbol: string;
  decimals: number;
  occurances?: number;
  iconUrl?: string;
}

export interface SwapsConfig extends BaseConfig {
  maxGasLimit: number;
  pollCountLimit: number;
  metaSwapAddress: string;
}

interface SwapsQuotes {
  [key: string]: APITrade;
}

interface SwapsSavings {
  total: BigNumber;
  performance: BigNumber;
  fee: BigNumber;
}

interface SwapsBestQuote {
  topAggId: string;
  ethTradeValueOfBestQuote: BigNumber;
  ethFeeForBestQuote: BigNumber;
  isBest: boolean;
}

interface SwapValues {
  allEthTradeValues: BigNumber[];
  allEthFees: BigNumber[];
}

interface SwapsBestQuoteAndSwapValues {
  bestQuote: SwapsBestQuote;
  values: SwapValues;
}

interface SwapsBestQuoteAndSavings {
  bestQuote: SwapsBestQuote;
  savings: SwapsSavings;
}

export interface SwapsState extends BaseState {
  quotes: SwapsQuotes;
  fetchParams: null | APITradeParams;
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
    const gasPrice = await this.query('gasPrice');
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
    quotes: SwapsQuotes,
    customGasPrice: string | null,
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
    quotesValues.forEach((quote) => {
      const {
        aggregator,
        approvalNeeded,
        averageGas,
        destinationAmount = 0,
        destinationToken,
        destinationTokenInfo,
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

      const tokenConversionRate = contractExchangeRates[destinationToken];
      const ethValueOfTrade =
        destinationToken === ETH_SWAPS_TOKEN_ADDRESS
          ? calcTokenAmount(destinationAmount, 18).minus(totalWeiCost, 10)
          : new BigNumber(tokenConversionRate || 1, 10)
              .times(calcTokenAmount(destinationAmount, destinationTokenInfo.decimals), 10)
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
  private async calculateSavings(quote: SwapsBestQuote, values: SwapValues): Promise<SwapsSavings> {
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
    quotes: SwapsQuotes,
    customGasPrice: string | null,
  ): Promise<SwapsBestQuoteAndSavings | null> {
    const numQuotes = Object.keys(quotes).length;
    if (!numQuotes) {
      return null;
    }

    const { bestQuote, values } = await this.getBestQuoteAndEthValues(quotes, customGasPrice);
    const savings = await this.calculateSavings(bestQuote, values);

    return { bestQuote, savings };
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

  private query(method: string, args: any[] = []): Promise<any> {
    return new Promise((resolve, reject) => {
      this.ethQuery[method](...args, (error: Error, result: any) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(result);
      });
    });
  }

  /**
   * Estimates required gas for a given transaction
   *
   * @param transaction - Transaction object to estimate gas for
   * @returns - Promise resolving to an object containing gas and gasPrice
   */
  private async estimateGas(transaction: Transaction) {
    const estimatedTransaction = { ...transaction };
    const { gasLimit } = await this.query('getBlockByNumber', ['latest', false]);
    const { gas, gasPrice: providedGasPrice, to, value, data } = estimatedTransaction;
    const gasPrice = typeof providedGasPrice === 'undefined' ? await this.query('gasPrice') : providedGasPrice;

    // 1. If gas is already defined on the transaction, use it
    if (typeof gas !== 'undefined') {
      return { gas, gasPrice };
    }

    // 2. If to is not defined or this is not a contract address, and there is no data use 0x5208 / 21000
    /* istanbul ignore next */
    const code = to ? await this.query('getCode', [to]) : undefined;
    /* istanbul ignore next */
    if (!to || (to && !data && (!code || code === '0x'))) {
      return { gas: '0x5208', gasPrice };
    }
    // if data, should be hex string format
    estimatedTransaction.data = !data ? data : /* istanbul ignore next */ addHexPrefix(data);
    // 3. If this is a contract address, safely estimate gas using RPC
    estimatedTransaction.value = typeof value === 'undefined' ? '0x0' : /* istanbul ignore next */ value;
    const gasLimitBN = hexToBN(gasLimit);
    estimatedTransaction.gas = BNToHex(fractionBN(gasLimitBN, 19, 20));
    const gasHex = await this.query('estimateGas', [estimatedTransaction]);

    // 4. Pad estimated gas without exceeding the most recent block gasLimit
    const gasBN = hexToBN(gasHex);
    const maxGasBN = gasLimitBN.muln(0.9);
    const paddedGasBN = gasBN.muln(1.5);
    /* istanbul ignore next */
    if (gasBN.gt(maxGasBN)) {
      return { gas: addHexPrefix(gasHex), gasPrice };
    }
    /* istanbul ignore next */
    if (paddedGasBN.lt(maxGasBN)) {
      return { gas: addHexPrefix(BNToHex(paddedGasBN)), gasPrice };
    }
    return { gas: addHexPrefix(BNToHex(maxGasBN)), gasPrice };
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

      return Promise.race([this.estimateGas(tradeTxParamsForGasEstimate), gasTimeout]);
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
      fetchParams: null,
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

  setQuotesLastFetched(quotesLastFetched: SwapsQuotes) {
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
    this.handle && clearTimeout(this.handle);
    this.fetchAndSetQuotes(this.state.fetchParams, {}, true, null);
    this.handle = setTimeout(() => {
      this.fetchAndSetQuotes(this.state.fetchParams, {}, true, null);
    }, QUOTE_POLLING_INTERVAL);
  }

  /**
   * Stops the polling process
   *
   */
  stopPollingForQuotes() {
    this.handle && clearTimeout(this.handle);
  }

  async fetchAndSetQuotes(
    fetchParams: null | {
      slippage: number;
      sourceToken: string;
      sourceAmount: string;
      destinationToken: string;
      fromAddress: string;
      exchangeList?: string[];
      balanceError?: string;
    },
    fetchParamsMetaData: Record<string, any>,
    isPolledRequest: boolean,
    customGasPrice: string | null,
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

    let newQuotes = await fetchTradesInfo(fetchParams);

    newQuotes = Object(newQuotes)
      .values()
      .map((quote: Record<string, any>) => ({
        ...quote,
        sourceTokenInfo: fetchParamsMetaData.sourceTokenInfo,
        destinationTokenInfo: fetchParamsMetaData.destinationTokenInfo,
      }));

    const quotesLastFetched = Date.now();
    let approvalRequired = false;
    if (fetchParams.sourceToken !== ETH_SWAPS_TOKEN_ADDRESS && Object.values(newQuotes).length) {
      const allowance = await this.getERC20Allowance(fetchParams.sourceToken, fetchParams.fromAddress);

      // For a user to be able to swap a token, they need to have approved the MetaSwap contract to withdraw that token.
      // _getERC20Allowance() returns the amount of the token they have approved for withdrawal. If that amount is greater
      // than 0, it means that approval has already occured and is not needed. Otherwise, for tokens to be swapped, a new
      // call of the ERC-20 approve method is required.
      approvalRequired = allowance === 0;
      if (!approvalRequired) {
        newQuotes = Object(newQuotes).values((quote: Record<string, any>) => ({
          ...quote,
          approvalNeeded: null,
        }));
      } else if (!isPolledRequest) {
        const quoteTrade = Object.values(newQuotes)[0].trade;

        const transaction: Transaction = {
          data: quoteTrade.data,
          from: quoteTrade.from,
          to: quoteTrade.to,
          value: quoteTrade.value,
        };
        const { gas: approvalGas } = await this.timedoutGasReturn(transaction);

        newQuotes = Object(newQuotes).values((quote: SwapsQuotes) => ({
          ...quote,
          approvalNeeded: {
            ...quote.approvalNeeded,
            gas: approvalGas || DEFAULT_ERC20_APPROVE_GAS,
          },
        }));
      }

      let topAggId = null;

      // We can reduce time on the loading screen by only doing this after the
      // loading screen and best quote have rendered.
      if (!approvalRequired && !fetchParams?.balanceError) {
        newQuotes = await this.getAllQuotesWithGasEstimates(newQuotes);
      }

      if (Object.values(newQuotes).length === 0) {
        this.setSwapsErrorKey(SwapsError.QUOTES_NOT_AVAILABLE_ERROR);
      } else {
        const topQuoteData = await this.findBestQuoteAndCalulateSavings(newQuotes, customGasPrice);

        if (topQuoteData?.bestQuote.topAggId) {
          topAggId = topQuoteData.bestQuote.topAggId;
          // newQuotes[topAggId].isBest = topQuoteData.bestQuote.isBest;
          // newQuotes[topAggId].savings = topQuoteData.savings;
        }
      }

      // If a newer call has been made, don't update state with old information
      // Prevents timing conflicts between fetches
      if (this.indexOfNewestCallInFlight !== indexOfCurrentCall) {
        throw new Error(SwapsError.SWAPS_FETCH_ORDER_CONFLICT);
      }

      this.update({
        quotes: newQuotes,
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

      return [newQuotes, topAggId];
    }

    this.update({ fetchParams: { ...fetchParams, metaData: fetchParamsMetaData } });
  }

  safeRefetchQuotes() {
    const { fetchParams } = this.state;
    if (!this.handle && fetchParams) {
      this.fetchAndSetQuotes(fetchParams, {}, false, null);
    }
  }

  async getAllQuotesWithGasEstimates(quotes: SwapsQuotes): Promise<SwapsQuotes> {
    const newQuotes = quotes;
    return newQuotes;
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

  // resetSwapsState () {}

  // timedoutGasReturn (tradeTxParams) {}

  // setSelectedQuoteAggId (selectedAggId) () {}

  // async setInitialGasEstimate (initialAggId, baseGasEstimate) {}

  // setApproveTxId (approveTxId) {}

  // setTradeTxId (tradeTxId) {}

  // setMaxMode (maxMode) {}

  // setSwapsTxGasPrice (gasPrice) {}

  // setSwapsTxGasLimit (gasLimit) {}

  // setCustomApproveTxData (data) {}

  // setBackgroundSwapRouteState (routeState) {}
}
