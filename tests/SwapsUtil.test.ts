import BigNumber from 'bignumber.js';
import { APIType } from '../src/swaps/SwapsInterfaces';
import * as swapsUtil from '../src/swaps/SwapsUtil';

describe('SwapsUtil', () => {
  describe('getBaseApiURL', () => {
    it('should return expected values', () => {
      expect(swapsUtil.getBaseApiURL(APIType.TRADES)).toBeTruthy();
      expect(swapsUtil.getBaseApiURL(APIType.TRADES)).toBeTruthy();
      expect(swapsUtil.getBaseApiURL(APIType.TOKENS)).toBeTruthy();
      expect(swapsUtil.getBaseApiURL(APIType.TOP_ASSETS)).toBeTruthy();
      expect(swapsUtil.getBaseApiURL(APIType.FEATURE_FLAG)).toBeTruthy();
      expect(swapsUtil.getBaseApiURL(APIType.AGGREGATOR_METADATA)).toBeTruthy();
    });
  });

  describe('fetchTradesInfo', () => {
    it('should work', async () => {
      jest.setTimeout(15000);
      // TODO(wachunei): this is actually performing a fetch request to production server
      const quotes = await swapsUtil.fetchTradesInfo({
        slippage: 3,
        sourceToken: '0x6b175474e89094c44da98b954eedeac495271d0f',
        destinationToken: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        sourceAmount: '1000000000000000000',
        fromAddress: '0xB0dA5965D43369968574D399dBe6374683773a65',
        metaData: {
          sourceTokenInfo: '',
          destinationTokenInfo: {
            decimals: 18,
            address: '',
            symbol: '',
          },
          accountBalance: '0x0',
        },
      });
      expect(quotes).toBeInstanceOf(Object);
    });
  });

  describe('fetchTokens', () => {
    it('should work', async () => {
      // TODO(wachunei): this is actually performing a fetch request to production server
      const tokens = await swapsUtil.fetchTokens();
      expect(tokens).toBeInstanceOf(Array);
    });
  });

  describe('fetchAggregatorMetadata', () => {
    it('should work', async () => {
      // TODO(wachunei): this is actually performing a fetch request to production server
      const aggregatorsMetadata = await swapsUtil.fetchAggregatorMetadata();
      expect(aggregatorsMetadata).toBeInstanceOf(Object);
    });
  });

  describe('fetchTopAssets', () => {
    it('should work', async () => {
      // TODO(wachunei): this is actually performing a fetch request to production server
      const assets = await swapsUtil.fetchTopAssets();
      expect(assets).toBeTruthy();
      expect(assets).toBeInstanceOf(Array);
    });
  });

  describe('fetchSwapsFeatureLiveness', () => {
    it('should work', async () => {
      // TODO(wachunei): this is actually performing a fetch request to production server
      const featureLiveness = await swapsUtil.fetchSwapsFeatureLiveness();
      expect(typeof featureLiveness).toBe('boolean');
    });
  });

  describe('fetchTokenPrice', () => {
    it('should work', async () => {
      const address = '0x6b175474e89094c44da98b954eedeac495271d0f';
      // TODO(wachunei): this is actually performing a fetch request to coingecko
      const ethPrice = await swapsUtil.fetchTokenPrice(address);
      expect(ethPrice).toBeTruthy();
      expect(typeof ethPrice).toBe('number');
    });
  });

  describe('getRenderableNetworkFeesForQuote', () => {
    it.todo('should work');
  });

  describe('quotesToRenderableData', () => {
    it.todo('should work');
  });

  describe('getSwapsTokensReceivedFromTxMeta', () => {
    it.todo('should work');
  });

  describe('calculateGasEstimateWithRefund', () => {
    test.each`
      maxGas       | estimatedRefund | estimatedGas | expected
      ${0}         | ${0}            | ${0}         | ${'0'}
      ${undefined} | ${2_000_000}    | ${501_000}   | ${'500000'}
      ${3}         | ${2}            | ${1}         | ${'1'}
      ${3}         | ${3}            | ${1}         | ${'0'}
      ${10}        | ${5}            | ${6}         | ${'5'}
    `('should return expected value', ({ maxGas, estimatedRefund, estimatedGas, expected }) => {
      const estimated = swapsUtil.calculateGasEstimateWithRefund(maxGas, estimatedRefund, estimatedGas);
      expect(estimated).toBeInstanceOf(BigNumber);
      expect(estimated.toString(10)).toBe(expected);
    });
  });

  describe('getMedian', () => {
    const numbers = [...Array(9).keys()].map((i) => new BigNumber(i + 1));
    const largeNumbers = numbers.map((i) => i.multipliedBy(100));

    it.each([
      [numbers, '5'],
      [largeNumbers, '500'],
    ])('returns the middle value', (values, result) => {
      const middleValue = swapsUtil.getMedian(values);
      expect(middleValue).toBeInstanceOf(BigNumber);
      expect(middleValue.toString(10)).toBe(result);
    });

    it.each([
      [[...numbers, new BigNumber(10)], '5.5'],
      [[...largeNumbers, new BigNumber(1000)], '550'],
    ])('returns the median value', (values, result) => {
      const medianValue = swapsUtil.getMedian(values);
      expect(medianValue).toBeInstanceOf(BigNumber);
      expect(medianValue.toString(10)).toBe(result);
    });
  });
});
