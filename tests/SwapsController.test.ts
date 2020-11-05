import TokenRatesController from '../src/assets/TokenRatesController';
import ComposableController from '../src/ComposableController';
import NetworkController from '../src/network/NetworkController';
import SwapsController from '../src/swaps/SwapsController';

describe('SwapsController', () => {
  let swapsController: SwapsController;
  let networkController: NetworkController;
  let tokenRatesController: TokenRatesController;

  beforeEach(() => {
    swapsController = new SwapsController();
    new ComposableController([swapsController, networkController, tokenRatesController]);
  });

  it('should set default config', () => {
    expect(swapsController.config).toEqual({
      maxGasLimit: 2500000,
      pollCountLimit: 3,
      metaSwapAddress: '0x881d40237659c251811cec9c364ef91dc08d300c',
    });
  });

  it('should set default state', () => {
    expect(swapsController.state).toEqual({
      quotes: {},
      fetchParams: null,
      tokens: null,
      quotesLastFetched: null,
      errorKey: null,
      topAggId: null,
      swapsFeatureIsLive: false,
    });
  });
});
