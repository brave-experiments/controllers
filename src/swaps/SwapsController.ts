import BigNumber from 'bignumber.js';
import BaseController, { BaseConfig, BaseState } from '../BaseController';
import NetworkController from '../network/NetworkController';
import TokenRatesController from '../assets/TokenRatesController';
import { calcTokenAmount } from '../util';
import { getMedian, SwapsError } from './SwapsUtil';

const Web3 = require('web3');
const abiERC20 = require('human-standard-token-abi');

const EthQuery = require('eth-query');

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
  [key: string]: Record<string, any>;
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
  fetchParams: null | Record<string, any>;
  tokens: null | SwapsTokenObject[];
  quotesLastFetched: null | Date;
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
  // private pollCount?: number;

  /**
   * Fetch current gas price
   *
   * @returns - Promise resolving to the current gas price
   */
  private async getGasPrice(): Promise<string> {
    const gasPrice = await this.query('gasPrice');
    return gasPrice.toHexString();
  }

  private async getBestQuoteAndEthValues(
    quotes: SwapsQuotes,
    customGasPrice: string,
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
   * Find best quote and savings from specific quotes
   *
   * @param quotes - Quotes to do the calculation
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
   * @returns - Promise resolving to an object containing best aggregator id and respective savings
   */
  private async findBestQuoteAndCalulateSavings(
    quotes: SwapsQuotes,
    customGasPrice: string,
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
   * @returns
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
      quotesLastFetched: null,
      errorKey: null,
      topAggId: null,
      swapsFeatureIsLive: false,
    };
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
    this.fetchAndSetQuotes(null, {}, true);
    this.handle = setTimeout(() => {
      this.fetchAndSetQuotes(null, {}, true);
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
    fetchParams: null | Record<string, any>,
    fetchParamsMetaData: Object,
    isPolledRequest: boolean,
    customGasPrice?: string,
  ) {
    if (!fetchParams) {
      return null;
    }

    // Every time we get a new request that is not from the polling, we reset the poll count so we can poll for up to three more sets of quotes with these new params.
    if (!isPolledRequest) {
      // this.pollCount = 0
    }

    // If there are any pending poll requests, clear them so that they don't get call while this new fetch is in process
    this.handle && clearTimeout(this.handle);

    if (!isPolledRequest) {
      this.setSwapsErrorKey(null);
    }
    // ...

    this.update({ fetchParams: { ...fetchParams, metaData: fetchParamsMetaData } });
  }

  safeRefetchQuotes() {
    const { fetchParams } = this.state;
    if (!this.handle && fetchParams) {
      this.fetchAndSetQuotes(fetchParams, {}, false);
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
