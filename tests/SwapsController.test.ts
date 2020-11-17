import { SinonStub, stub, spy } from 'sinon';
import AssetsContractController from '../src/assets/AssetsContractController';
import AssetsController from '../src/assets/AssetsController';
import CurrencyRateController from '../src/assets/CurrencyRateController';
import TokenRatesController from '../src/assets/TokenRatesController';
import ComposableController from '../src/ComposableController';
import NetworkController from '../src/network/NetworkController';
import SwapsController from '../src/swaps/SwapsController';
import { SwapsError } from '../src/swaps/SwapsInterfaces';
import PreferencesController from '../src/user/PreferencesController';

const swapsUtil = require('../src/swaps/SwapsUtil');

const API_TOKENS = [
  {
    address: '0x6b175474e89094c44da98b954eedeac495271d0f',
    symbol: 'DAI',
    decimals: 18,
    occurances: 30,
    iconUrl: 'https://cloudflare-ipfs.com/ipfs/QmNYVMm3iC7HEoxfvxsZbRoapdjDHj9EREFac4BPeVphSJ',
  },
  {
    address: '0xdac17f958d2ee523a2206206994597c13d831ec7',
    symbol: 'USDT',
    decimals: 6,
    occurances: 30,
    iconUrl: 'https://cloudflare-ipfs.com/ipfs/QmR3TGmDDdmid99ExTHwPiKro4njZhSidbjcTbSrS5rHnq',
  },
  {
    address: '0x8e870d67f660d95d5be530380d0ec0bd388289e1',
    symbol: 'PAX',
    decimals: 18,
    occurances: 30,
    iconUrl: 'https://cloudflare-ipfs.com/ipfs/QmQTzo6Ecdn54x7NafwegjLetAnno1ATL9Y8M3PcVXGVhR',
  },
];

describe('SwapsController', () => {
  let swapsController: SwapsController;
  let networkController: NetworkController;
  let tokenRatesController: TokenRatesController;
  let assetsController: AssetsController;
  let currencyRateController: CurrencyRateController;
  let assetsContractController: AssetsContractController;
  let preferencesController: PreferencesController;
  let swapsUtilFetchTokens: SinonStub;
  beforeEach(() => {
    swapsUtilFetchTokens = stub(swapsUtil, 'fetchTokens').returns([]);
    swapsController = new SwapsController({ quotePollingInterval: 10 });
    networkController = new NetworkController();
    tokenRatesController = new TokenRatesController();
    assetsController = new AssetsController();
    currencyRateController = new CurrencyRateController();
    assetsContractController = new AssetsContractController();
    preferencesController = new PreferencesController();
    new ComposableController([
      swapsController,
      networkController,
      tokenRatesController,
      assetsController,
      currencyRateController,
      assetsContractController,
      preferencesController,
    ]);
  });

  afterEach(() => {
    swapsUtilFetchTokens.restore();
  });

  it('should set default config', () => {
    expect(swapsController.config).toEqual({
      maxGasLimit: 2500000,
      pollCountLimit: 3,
      metaSwapAddress: '0x881d40237659c251811cec9c364ef91dc08d300c',
      fetchTokensThreshold: 86400000,
      quotePollingInterval: 10,
    });
  });

  it('should set default state', () => {
    expect(swapsController.state).toEqual({
      quotes: {},
      fetchParams: {
        slippage: 0,
        sourceToken: '',
        sourceAmount: '',
        destinationToken: '',
        fromAddress: '',
        metaData: {
          sourceTokenInfo: '',
          destinationTokenInfo: {
            decimals: 0,
            address: '',
            symbol: '',
          },
          accountBalance: '0x',
        },
      },
      tokens: null,
      quotesLastFetched: 0,
      errorKey: null,
      topAggId: null,
      swapsFeatureIsLive: false,
      tokensLastFetched: 0,
    });
  });

  it('should set tokens', () => {
    swapsController.setSwapsTokens(API_TOKENS);
    expect(swapsController.state.tokens).toEqual(API_TOKENS);
  });

  it('should set error key', () => {
    swapsController.setSwapsErrorKey(SwapsError.ERROR_FETCHING_QUOTES);
    expect(swapsController.state.errorKey).toEqual(SwapsError.ERROR_FETCHING_QUOTES);
  });

  it('should set quotes last fetched', () => {
    swapsController.setQuotesLastFetched(123);
    expect(swapsController.state.quotesLastFetched).toEqual(123);
  });

  it('should set swaps liveness', () => {
    swapsController.setSwapsLiveness(true);
    expect(swapsController.state.swapsFeatureIsLive).toEqual(true);
  });

  it('should call poll', () => {
    return new Promise((resolve) => {
      const poll = spy(swapsController, 'fetchAndSetQuotes');
      swapsController.pollForNewQuotes();
      expect(poll.called).toBe(true);
      expect(poll.calledTwice).toBe(false);
      setTimeout(() => {
        expect(poll.calledTwice).toBe(true);
        resolve();
      }, 11);
    });
  });

  it('should stop polling', () => {
    return new Promise((resolve) => {
      const poll = stub(swapsController, 'fetchAndSetQuotes');
      swapsController.pollForNewQuotes();
      expect(poll.called).toBe(true);
      expect(poll.calledTwice).toBe(false);
      setTimeout(() => {
        expect(poll.calledTwice).toBe(true);
        swapsController.stopPollingForQuotes();
        setTimeout(() => {
          expect(poll.calledThrice).toBe(false);
        }, 11);
        resolve();
      }, 11);
    });
  });

  it('should fetch tokens when no tokens in state', () => {
    return new Promise(async (resolve) => {
      swapsController.state.tokens = null;
      await swapsController.fetchTokenWithCache();
      expect(swapsUtilFetchTokens.called).toBe(true);
      resolve();
    });
  });

  it('should fetch tokens when no threshold reached', () => {
    return new Promise(async (resolve) => {
      swapsController.state.tokens = [];
      swapsController.state.tokensLastFetched = Date.now();
      await swapsController.fetchTokenWithCache();
      expect(swapsUtilFetchTokens.called).toBe(false);
      setTimeout(async () => {
        await swapsController.fetchTokenWithCache();
        expect(swapsUtilFetchTokens.called).toBe(true);
      }, 20);
      resolve();
    });
  });

  it('should not fetch tokens when no threshold reached or tokens are available', () => {
    return new Promise(async (resolve) => {
      swapsController.state.tokens = [];
      swapsController.state.tokensLastFetched = Date.now();
      await swapsController.fetchTokenWithCache();
      expect(swapsUtilFetchTokens.called).toBe(false);
      resolve();
    });
  });
});
