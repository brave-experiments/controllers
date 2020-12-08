import BigNumber from 'bignumber.js';
import { addHexPrefix } from 'ethereumjs-util';
import BaseController, { BaseConfig, BaseState } from '../BaseController';
import { calcTokenAmount, estimateGas, query } from '../util';
import { Transaction } from '../transaction/TransactionController';
import {
  DEFAULT_ERC20_APPROVE_GAS,
  ETH_SWAPS_TOKEN_ADDRESS,
  fetchTokens,
  fetchTradesInfo,
  SWAPS_CONTRACT_ADDRESS,
  SwapsError,
  calculateMaxNetworkFee,
  calculateEstimatedNetworkFee,
  getMedianEthValueQuote,
} from './SwapsUtil';
import {
  SwapsTrade,
  SwapsQuote,
  SwapsQuoteSavings,
  SwapsToken,
  APIFetchQuotesParams,
  APIFetchQuotesMetadata,
  TradeFees,
} from './SwapsInterfaces';

const { Mutex } = require('await-semaphore');
const abiERC20 = require('human-standard-token-abi');
const EthQuery = require('ethjs-query');
const Web3 = require('web3');

// An address that the metaswap-api recognizes as ETH, in place of the token address that ERC-20 tokens have

export interface SwapsConfig extends BaseConfig {
  maxGasLimit: number;
  pollCountLimit: number;
  metaSwapAddress: string;
  fetchTokensThreshold: number;
  quotePollingInterval: number;
  provider: any;
}

export interface SwapsState extends BaseState {
  quotes: { [key: string]: SwapsTrade };
  fetchParams: APIFetchQuotesParams;
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
    const gasPrice = await query('gasPrice', this.ethQuery);
    return gasPrice;
  }

  /**
   * Find best quote and ETH values, all quotes fees and all quotes trade values
   *
   * @param quotes - Array of quotes
   * @param customGasPrice - If defined, custom gas price used
   * @returns - Promise resolving to the best quote object and ETH values from quotes
   */
  private async getBestQuoteAndEthValues(
    quotes: { [key: string]: SwapsTrade },
    customGasPrice?: string,
  ): Promise<{ topAggId: string; tradeFees: { [key: string]: TradeFees } }> {
    let topAggId = '';
    let overallValueOfBestQuoteForSorting: BigNumber = new BigNumber(0);

    const tradeFees: { [key: string]: TradeFees } = {};
    const usedGasPrice = customGasPrice || (await this.getGasPrice());

    const { destinationTokenInfo, destinationTokenConversionRate } = this.state.fetchParams.metaData;

    Object.values(quotes).forEach((quote: SwapsTrade) => {
      const {
        aggregator,
        averageGas,
        destinationAmount = 0,
        destinationToken,
        sourceAmount,
        sourceToken,
        trade,
        gasEstimate,
        fee: metaMaskFee,
      } = quote;

      // trade gas
      const tradeGasLimit = gasEstimate
        ? new BigNumber(gasEstimate, 16)
        : new BigNumber(averageGas || MAX_GAS_LIMIT, 10);

      // + approval gas if required
      const totalGasLimit = tradeGasLimit.plus(this.state.approvalTransaction?.gas || '0x0', 16);
      const totalGasInWei = totalGasLimit.times(addHexPrefix(usedGasPrice), 10);

      // totalGas + trade value
      // trade.value is a sum of different values depending on the transaction.
      // It always includes any external fees charged by the quote source. In
      // addition, if the source asset is ETH, trade.value includes the amount
      // of swapped ETH.
      const totalInWei = totalGasInWei.plus(trade.value, 16);

      // if value in trade, ETH fee will be the gas, if not it will be the total wei
      const weiFee = sourceToken === ETH_SWAPS_TOKEN_ADDRESS ? totalInWei.minus(sourceAmount, 10) : totalInWei; // sourceAmount is in wei : totalInWei;
      const ethFee = calcTokenAmount(weiFee, 18);
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

      tradeFees[aggregator] = {
        ethFee: ethFee.toString(10),
        ethValueOfTokens: ethValueOfTokens.toString(10),
        overallValueOfQuote: overallValueOfQuote.toString(10),
        metaMaskFeeInEth: metaMaskFeeInTokens.times(conversionRate).toString(10),
      };

      if (overallValueOfQuote.gt(overallValueOfBestQuoteForSorting)) {
        topAggId = aggregator;
        overallValueOfBestQuoteForSorting = overallValueOfQuote;
      }
    });

    return { topAggId, tradeFees };
  }

  /**
   * Calculate savings from quotes
   *
   * @param quotes - Quotes to do the calculation
   * @param values - Swaps ETH values, all quotes fees and all quotes trade values
   * @returns - Promise resolving to an object containing best aggregator id and respective savings
   */
  private async calculateSavings(
    quote: SwapsTrade,
    tradeFees: { [key: string]: TradeFees },
  ): Promise<SwapsQuoteSavings> {
    const {
      ethFee: medianEthFee,
      metaMaskFeeInEth: medianMetaMaskFee,
      ethValueOfTokens: medianEthValueOfTokens,
    } = getMedianEthValueQuote(Object.values(tradeFees));

    const bestTradeFee = tradeFees[quote.aggregator];
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
   * Find best quote and savings from specific quotes
   *
   * @param quotes - Quotes to do the calculation
   * @param customGasPrice - If defined, custom gas price used
   * @returns - Promise resolving to an object containing best aggregator id and respective savings
   */
  private async findBestQuoteAndCalculateSavings(
    quotes: { [key: string]: SwapsTrade },
    customGasPrice?: string,
  ): Promise<SwapsQuote | null> {
    const numQuotes = Object.keys(quotes).length;
    if (!numQuotes) {
      return null;
    }

    const { topAggId, tradeFees } = await this.getBestQuoteAndEthValues(quotes, customGasPrice);
    const savings = await this.calculateSavings(quotes[topAggId], tradeFees);

    return { ...quotes[topAggId], topAggId, savings };
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

    return new Promise(async (resolve, reject) => {
      const tradeTxParamsForGasEstimate = {
        data: tradeTxParams.data,
        from: tradeTxParams.from,
        to: tradeTxParams.to,
        value: tradeTxParams.value,
        gas: tradeTxParams.gas,
      };
      try {
        const gas: { gas: string | null } = (await Promise.race([
          estimateGas(tradeTxParamsForGasEstimate, this.ethQuery),
          gasTimeout,
        ])) as { gas: string | null };
        resolve(gas);
      } catch (e) {
        reject(e);
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
      fetchParams: {
        slippage: 0,
        sourceToken: '',
        sourceAmount: 0,
        destinationToken: '',
        fromAddress: '',
        metaData: {
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
      },
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

  async getAllQuotesWithGasEstimates(
    trades: { [key: string]: SwapsTrade },
    approvalGas: string | null,
  ): Promise<{ [key: string]: SwapsTrade }> {
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

    const newQuotes: { [key: string]: SwapsTrade } = {};
    quoteGasData.forEach(({ gas, aggId }) => {
      if (gas) {
        newQuotes[aggId] = {
          ...trades[aggId],
          gasEstimate: gas,
          maxNetworkFee: calculateMaxNetworkFee(approvalGas, gas, trades[aggId]?.maxGas),
          estimatedNetworkFee: calculateEstimatedNetworkFee(
            approvalGas,
            gas,
            trades[aggId]?.maxGas,
            trades[aggId]?.estimatedRefund,
            trades[aggId]?.averageGas,
          ),
        };
      }
    });
    return newQuotes;
  }

  async fetchAndSetQuotes(): Promise<void> {
    const { fetchParams, customGasPrice } = this.state;
    this.update({ isInFetch: true });
    try {
      let apiTrades: { [key: string]: SwapsTrade } = await fetchTradesInfo(fetchParams);

      if (Object.values(apiTrades).length === 0) {
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
        const allowance = await this.getERC20Allowance(fetchParams.sourceToken, fetchParams.fromAddress);

        if (Number(allowance) === 0 && this.pollCount === 1) {
          approvalTransaction = Object.values(apiTrades)[0].approvalNeeded;
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
      apiTrades = await this.getAllQuotesWithGasEstimates(apiTrades, approvalTransaction?.gas || null);
      const bestQuote: SwapsQuote | null = await this.findBestQuoteAndCalculateSavings(apiTrades, customGasPrice);
      const topAggId = bestQuote?.topAggId;
      if (topAggId) {
        apiTrades[topAggId] = { ...apiTrades[topAggId], savings: bestQuote?.savings };
      }

      this.state.isInPolling &&
        this.update({
          quotes: apiTrades,
          quotesLastFetched,
          approvalTransaction,
          topAggId,
          isInFetch: false,
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
      fetchParams: { ...fetchParams, metaData: fetchParamsMetaData },
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
