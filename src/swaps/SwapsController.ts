import BigNumber from 'bignumber.js';
import AbortController from 'abort-controller';
import BaseController, { BaseConfig, BaseState } from '../BaseController';
import { calcTokenAmount, estimateGas } from '../util';
import { Transaction } from '../transaction/TransactionController';
import {
  DEFAULT_ERC20_APPROVE_GAS,
  ETH_SWAPS_TOKEN_ADDRESS,
  fetchTokens,
  fetchTradesInfo,
  SWAPS_CONTRACT_ADDRESS,
  SwapsError,
  getMedianEthValueQuote,
  fetchGasPrices,
  calculateGasEstimateWithRefund,
} from './SwapsUtil';
import {
  Quote,
  QuoteSavings,
  SwapsToken,
  APIFetchQuotesParams,
  APIFetchQuotesMetadata,
  QuoteValues,
} from './SwapsInterfaces';

/** We need to abort quotes fetch if stopPollingAndResetState is called while getting quotes */
const controller = new AbortController();
const { signal } = controller;

const { Mutex } = require('await-semaphore');
const abiERC20 = require('human-standard-token-abi');
const EthQuery = require('ethjs-query');
const Web3 = require('web3');

export interface SwapsConfig extends BaseConfig {
  maxGasLimit: number;
  pollCountLimit: number;
  metaSwapAddress: string;
  fetchTokensThreshold: number;
  quotePollingInterval: number;
  provider: any;
}

export interface SwapsState extends BaseState {
  quotes: { [key: string]: Quote };
  fetchParams: APIFetchQuotesParams;
  fetchParamsMetaData: APIFetchQuotesMetadata;
  topAggSavings: QuoteSavings | null;
  tokens: null | SwapsToken[];
  quotesLastFetched: null | number;
  errorKey: null | SwapsError;
  topAggId: null | string;
  tokensLastFetched: number;
  customGasPrice?: string;
  isInPolling: boolean;
  isInFetch: boolean;
  pollingCyclesLeft: number;
  approvalTransaction: Transaction | null;
  quoteValues: { [key: string]: QuoteValues } | null;
}

const QUOTE_POLLING_INTERVAL = 50 * 1000;
// The MAX_GAS_LIMIT is a number that is higher than the maximum gas costs we have observed on any aggregator
const MAX_GAS_LIMIT = 2500000;

export class SwapsController extends BaseController<SwapsConfig, SwapsState> {
  private handle?: NodeJS.Timer;

  private web3: any;

  private ethQuery: any;

  private pollCount = 0;

  private mutex = new Mutex();

  /**
   * Fetch current gas price
   *
   * @returns - Promise resolving to the current gas price
   */
  private async getGasPrice(): Promise<string> {
    const { ProposeGasPrice } = await fetchGasPrices();
    return ProposeGasPrice;
  }

  /**
   * Find best quote and quotes calculated values
   *
   * @param quotes - Array of quotes
   * @param customGasPrice - If defined, custom gas price used
   * @returns - Promise resolving to the best quote object and values from quotes
   */
  private async getBestQuoteAndQuotesValues(
    quotes: { [key: string]: Quote },
    customGasPrice?: string,
  ): Promise<{ topAggId: string; quoteValues: { [key: string]: QuoteValues } }> {
    let topAggId = '';
    let overallValueOfBestQuoteForSorting: BigNumber = new BigNumber(0);

    const quoteValues: { [key: string]: QuoteValues } = {};
    const usedGasPrice = customGasPrice || (await this.getGasPrice());

    const { destinationTokenInfo, destinationTokenConversionRate } = this.state.fetchParamsMetaData;
    Object.values(quotes).forEach((quote: Quote) => {
      const {
        aggregator,
        averageGas,
        maxGas,
        destinationAmount = 0,
        destinationToken,
        sourceAmount,
        sourceToken,
        trade,
        gasEstimate,
        gasEstimateWithRefund,
        fee: metaMaskFee,
      } = quote;

      // trade gas
      const tradeGasLimit =
        gasEstimateWithRefund && gasEstimateWithRefund !== 0
          ? new BigNumber(gasEstimateWithRefund)
          : new BigNumber(averageGas || MAX_GAS_LIMIT, 10);
      const calculatedMaxGasLimit = new BigNumber(gasEstimate || averageGas).times(1.4, 10);
      const tradeMaxGasLimit =
        calculatedMaxGasLimit.toNumber() > maxGas ? calculatedMaxGasLimit : new BigNumber(maxGas);

      // + approval gas if required
      const approvalGas = this.state.approvalTransaction?.gas || '0x0';
      const totalGasLimit = tradeGasLimit.plus(approvalGas, 16);
      const maxTotalGasLimit = tradeMaxGasLimit.plus(approvalGas, 16);
      const totalGasInWei = totalGasLimit.times(usedGasPrice, 10).times(1000000000);
      const maxTotalGasInWei = maxTotalGasLimit.times(usedGasPrice, 10).times(1000000000);

      // totalGas + trade value
      // trade.value is a sum of different values depending on the transaction.
      // It always includes any external fees charged by the quote source. In
      // addition, if the source asset is ETH, trade.value includes the amount
      // of swapped ETH.
      const totalInWei = totalGasInWei.plus(trade.value, 16);
      const maxTotalInWei = maxTotalGasInWei.plus(trade.value, 16);

      // if value in trade, ETH fee will be the gas, if not it will be the total wei
      const weiFee = sourceToken === ETH_SWAPS_TOKEN_ADDRESS ? totalInWei.minus(sourceAmount, 10) : totalInWei; // sourceAmount is in wei : totalInWei;
      const maxWeiFee = sourceToken === ETH_SWAPS_TOKEN_ADDRESS ? maxTotalInWei.minus(sourceAmount, 10) : maxTotalInWei; // sourceAmount is in wei : totalInWei;
      const ethFee = calcTokenAmount(weiFee, 18);
      const maxEthFee = calcTokenAmount(maxWeiFee, 18);
      const decimalAdjustedDestinationAmount = calcTokenAmount(destinationAmount, destinationTokenInfo.decimals);

      // fees

      const tokenPercentageOfPreFeeDestAmount = new BigNumber(100, 10).minus(metaMaskFee, 10).div(100);
      const destinationAmountBeforeMetaMaskFee = decimalAdjustedDestinationAmount.div(
        tokenPercentageOfPreFeeDestAmount,
      );
      const metaMaskFeeInTokens = destinationAmountBeforeMetaMaskFee.minus(decimalAdjustedDestinationAmount);

      const conversionRate = destinationTokenConversionRate || 1;

      const ethValueOfTokens = decimalAdjustedDestinationAmount.times(conversionRate, 10);

      // the more tokens the better
      const overallValueOfQuote =
        destinationToken === ETH_SWAPS_TOKEN_ADDRESS ? ethValueOfTokens.minus(ethFee, 10) : ethValueOfTokens;
      quoteValues[aggregator] = {
        aggregator,
        ethFee: ethFee.toFixed(18),
        maxEthFee: maxEthFee.toFixed(18),
        ethValueOfTokens: ethValueOfTokens.toFixed(18),
        overallValueOfQuote: overallValueOfQuote.toFixed(18),
        metaMaskFeeInEth: metaMaskFeeInTokens.times(conversionRate).toFixed(18),
      };

      if (overallValueOfQuote.gt(overallValueOfBestQuoteForSorting)) {
        topAggId = aggregator;
        overallValueOfBestQuoteForSorting = overallValueOfQuote;
      }
    });

    return { topAggId, quoteValues };
  }

  /**
   * Calculate savings from quotes
   *
   * @param quotes - Quotes to do the calculation
   * @param values - Swaps ETH values, all quotes fees and all quotes trade values
   * @returns - Promise resolving to an object containing best aggregator id and respective savings
   */
  private async calculateSavings(quote: Quote, quoteValues: { [key: string]: QuoteValues }): Promise<QuoteSavings> {
    const {
      ethFee: medianEthFee,
      metaMaskFeeInEth: medianMetaMaskFee,
      ethValueOfTokens: medianEthValueOfTokens,
    } = getMedianEthValueQuote(Object.values(quoteValues));

    const bestTradeFee = quoteValues[quote.aggregator];
    // Performance savings are calculated as:
    //   (ethValueOfTokens for the best trade) - (ethValueOfTokens for the media trade)
    const performance = new BigNumber(bestTradeFee.ethValueOfTokens, 10).minus(medianEthValueOfTokens, 10);

    // Fee savings are calculated as:
    //   (fee for the median trade) - (fee for the best trade)
    const fee = new BigNumber(medianEthFee).minus(bestTradeFee.ethFee, 10);

    const metaMaskFee = bestTradeFee.metaMaskFeeInEth;

    // Total savings are calculated as:
    //   performance savings + fee savings - metamask fee
    const total = performance.plus(fee).minus(metaMaskFee);

    return { performance, total, fee, medianMetaMaskFee: new BigNumber(medianMetaMaskFee) };
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
      contract.allowance(walletAddress, SWAPS_CONTRACT_ADDRESS, (error: Error, result: number) => {
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

    const gasTimeout = new Promise((resolve) => {
      setTimeout(() => {
        resolve({ gas: null });
      }, 5000);
    });

    return new Promise(async (resolve) => {
      const tradeTxParamsForGasEstimate = {
        data: tradeTxParams.data,
        from: tradeTxParams.from,
        to: tradeTxParams.to,
        value: tradeTxParams.value,
      };
      try {
        const gas: { gas: string | null } = (await Promise.race([
          estimateGas(tradeTxParamsForGasEstimate, this.ethQuery),
          gasTimeout,
        ])) as { gas: string | null };
        resolve(gas);
      } catch (e) {
        resolve({ gas: null });
      }
    });
  }

  private stopPollingWithError(error: SwapsError) {
    this.update({ isInPolling: false, isInFetch: false, pollingCyclesLeft: 0, errorKey: error });
  }

  /**
   * Name of this controller used during composition
   */
  name = 'SwapsController';

  /**
   * List of required sibling controllers this controller needs to function
   */
  requiredControllers = [];

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
      metaSwapAddress: SWAPS_CONTRACT_ADDRESS,
      fetchTokensThreshold: 1000 * 60 * 60 * 24,
      quotePollingInterval: QUOTE_POLLING_INTERVAL,
      provider: undefined,
    };
    this.defaultState = {
      quotes: {},
      quoteValues: {},
      fetchParams: {
        slippage: 0,
        sourceToken: '',
        sourceAmount: 0,
        destinationToken: '',
        walletAddress: '',
      },
      fetchParamsMetaData: {
        sourceTokenInfo: {
          decimals: 0,
          address: '',
          symbol: '',
        },
        destinationTokenInfo: {
          decimals: 0,
          address: '',
          symbol: '',
        },
        accountBalance: '0x',
      },
      topAggSavings: null,
      tokens: null,
      approvalTransaction: null,
      quotesLastFetched: 0,
      errorKey: null,
      topAggId: null,
      tokensLastFetched: 0,
      isInPolling: false,
      isInFetch: false,
      pollingCyclesLeft: config?.pollCountLimit || 3,
    };

    this.initialize();
  }

  set provider(provider: any) {
    if (provider) {
      this.ethQuery = new EthQuery(provider);
      this.web3 = new Web3(provider);
    }
  }

  /**
   * Starts a new polling process
   *
   */
  async pollForNewQuotes() {
    // We only want to do up to a maximum of three requests from polling.
    this.pollCount += 1;
    if (this.pollCount < this.config.pollCountLimit + 1) {
      this.update({ isInPolling: true, pollingCyclesLeft: this.config.pollCountLimit - this.pollCount });
      this.handle && clearTimeout(this.handle);
      await this.fetchAndSetQuotes();
      this.handle = setTimeout(() => {
        this.pollForNewQuotes();
      }, this.config.quotePollingInterval);
    } else {
      this.stopPollingWithError(SwapsError.QUOTES_EXPIRED_ERROR);
    }
  }

  async getAllQuotesWithGasEstimates(trades: { [key: string]: Quote }): Promise<{ [key: string]: Quote }> {
    const quoteGasData = await Promise.all(
      Object.values(trades).map((trade) => {
        return new Promise<{ gas: string | null; aggId: string }>(async (resolve, reject) => {
          try {
            const { gas } = await this.timedoutGasReturn(trade.trade);
            resolve({
              gas,
              aggId: trade.aggregator,
            });
          } catch (e) {
            reject(e);
          }
        });
      }),
    );

    const newQuotes: { [key: string]: Quote } = {};
    quoteGasData.forEach(({ gas, aggId }) => {
      newQuotes[aggId] = {
        ...trades[aggId],
        gasEstimate: gas,
        gasEstimateWithRefund: calculateGasEstimateWithRefund(
          trades[aggId].maxGas,
          trades[aggId].estimatedRefund,
          gas,
        ).toNumber(),
      };
    });
    return newQuotes;
  }

  async fetchAndSetQuotes(): Promise<void> {
    const { fetchParams, customGasPrice } = this.state;
    this.update({ isInFetch: true });
    try {
      let quotes: { [key: string]: Quote } = await fetchTradesInfo(fetchParams, signal);

      if (Object.values(quotes).length === 0) {
        throw new Error(SwapsError.QUOTES_NOT_AVAILABLE_ERROR);
      }

      const quotesLastFetched = Date.now();
      let approvalTransaction: {
        data?: string;
        from: string;
        to?: string;
        gas?: string;
      } | null = null;

      if (fetchParams.sourceToken !== ETH_SWAPS_TOKEN_ADDRESS) {
        const allowance = await this.getERC20Allowance(fetchParams.sourceToken, fetchParams.walletAddress);

        if (Number(allowance) === 0 && this.pollCount === 1) {
          approvalTransaction = Object.values(quotes)[0].approvalNeeded;
          if (!approvalTransaction) {
            throw new Error(SwapsError.ERROR_FETCHING_QUOTES);
          }
          const { gas: approvalGas } = await this.timedoutGasReturn({
            data: approvalTransaction.data,
            from: approvalTransaction.from,
            to: approvalTransaction.to,
          });

          approvalTransaction = {
            ...approvalTransaction,
            gas: approvalGas || DEFAULT_ERC20_APPROVE_GAS,
          };
        }
      }
      quotes = await this.getAllQuotesWithGasEstimates(quotes);
      const { topAggId, quoteValues } = await this.getBestQuoteAndQuotesValues(quotes, customGasPrice);
      const savings = await this.calculateSavings(quotes[topAggId], quoteValues);

      this.state.isInPolling &&
        this.update({
          quotes,
          quotesLastFetched,
          approvalTransaction,
          topAggId: quotes[topAggId]?.aggregator,
          topAggSavings: savings,
          isInFetch: false,
          quoteValues,
        });
    } catch (e) {
      const error = Object.values(SwapsError).includes(e) ? e : SwapsError.ERROR_FETCHING_QUOTES;
      this.stopPollingWithError(error);
      this.stopPollingAndResetState();
    }
  }

  startFetchAndSetQuotes(
    fetchParams: APIFetchQuotesParams,
    fetchParamsMetaData: APIFetchQuotesMetadata,
    customGasPrice?: string,
  ) {
    if (!fetchParams) {
      return null;
    }
    // Every time we get a new request that is not from the polling, we reset the poll count so we can poll for up to three more sets of quotes with these new params.
    this.pollCount = 0;

    this.update({
      customGasPrice,
      fetchParams,
      fetchParamsMetaData,
    });
    this.pollForNewQuotes();
  }

  async fetchTokenWithCache() {
    if (!this.state.tokens || this.config.fetchTokensThreshold < Date.now() - this.state.tokensLastFetched) {
      const releaseLock = await this.mutex.acquire();
      try {
        const newTokens = await fetchTokens();
        this.update({ tokens: newTokens, tokensLastFetched: Date.now() });
      } finally {
        releaseLock();
      }
    }
  }

  safeRefetchQuotes() {
    const { fetchParams } = this.state;
    if (!this.handle && fetchParams) {
      this.fetchAndSetQuotes();
    }
  }

  /**
   * Stops the polling process
   *
   */
  stopPollingAndResetState() {
    controller.abort();
    this.handle && clearTimeout(this.handle);
    this.pollCount = this.config.pollCountLimit + 1;
    this.update({
      ...this.defaultState,
      isInPolling: false,
      isInFetch: false,
      tokensLastFetched: this.state.tokensLastFetched,
      tokens: this.state.tokens,
      errorKey: undefined,
    });
  }
}

export default SwapsController;
