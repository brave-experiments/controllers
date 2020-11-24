import { addHexPrefix, isValidAddress, bufferToHex } from 'ethereumjs-util';
import BigNumber from 'bignumber.js';
import { TYPED_MESSAGE_SCHEMA, typedSignatureHash } from 'eth-sig-util';
import { Transaction, FetchAllOptions } from './transaction/TransactionController';
import { MessageParams } from './message-manager/MessageManager';
import { PersonalMessageParams } from './message-manager/PersonalMessageManager';
import { TypedMessageParams } from './message-manager/TypedMessageManager';
import { Token } from './assets/TokenRatesController';

const jsonschema = require('jsonschema');
const { BN, stripHexPrefix } = require('ethereumjs-util');
const ensNamehash = require('eth-ens-namehash');

const hexRe = /^[0-9A-Fa-f]+$/gu;

const NORMALIZERS: { [param in keyof Transaction]: any } = {
  data: (data: string) => addHexPrefix(data),
  from: (from: string) => addHexPrefix(from).toLowerCase(),
  gas: (gas: string) => addHexPrefix(gas),
  gasPrice: (gasPrice: string) => addHexPrefix(gasPrice),
  nonce: (nonce: string) => addHexPrefix(nonce),
  to: (to: string) => addHexPrefix(to).toLowerCase(),
  value: (value: string) => addHexPrefix(value),
};

/**
 * Converts a BN object to a hex string with a '0x' prefix
 *
 * @param inputBn - BN instance to convert to a hex string
 * @returns - '0x'-prefixed hex string
 *
 */
export function BNToHex(inputBn: any) {
  return addHexPrefix(inputBn.toString(16));
}

/**
 * Used to multiply a BN by a fraction
 *
 * @param targetBN - Number to multiply by a fraction
 * @param numerator - Numerator of the fraction multiplier
 * @param denominator - Denominator of the fraction multiplier
 * @returns - Product of the multiplication
 */
export function fractionBN(targetBN: any, numerator: number | string, denominator: number | string) {
  const numBN = new BN(numerator);
  const denomBN = new BN(denominator);
  return targetBN.mul(numBN).div(denomBN);
}

/**
 * Return a URL that can be used to obtain ETH for a given network
 *
 * @param networkCode - Network code of desired network
 * @param address - Address to deposit obtained ETH
 * @param amount - How much ETH is desired
 * @returns - URL to buy ETH based on network
 */
export function getBuyURL(networkCode = '1', address?: string, amount = 5) {
  switch (networkCode) {
    case '1':
      return `https://buy.coinbase.com/?code=9ec56d01-7e81-5017-930c-513daa27bb6a&amount=${amount}&address=${address}&crypto_currency=ETH`;
    case '3':
      return 'https://faucet.metamask.io/';
    case '4':
      return 'https://www.rinkeby.io/';
    case '5':
      return 'https://goerli-faucet.slock.it/';
    case '42':
      return 'https://github.com/kovan-testnet/faucet';
  }
}

/**
 * Return a URL that can be used to fetch ETH transactions
 *
 * @param networkType - Network type of desired network
 * @param address - Address to get the transactions from
 * @param fromBlock? - Block from which transactions are needed
 * @returns - URL to fetch the transactions from
 */
export function getEtherscanApiUrl(networkType: string, address: string, fromBlock?: string): string {
  let etherscanSubdomain = 'api';
  /* istanbul ignore next */
  if (networkType !== 'mainnet') {
    etherscanSubdomain = `api-${networkType}`;
  }
  const apiUrl = `https://${etherscanSubdomain}.etherscan.io`;
  let url = `${apiUrl}/api?module=account&action=txlist&address=${address}&tag=latest&page=1`;
  if (fromBlock) {
    url += `&startBlock=${fromBlock}`;
  }
  return url;
}

/**
 * Return a URL that can be used to fetch ERC20 token transactions
 *
 * @param networkType - Network type of desired network
 * @param address - Address to get the transactions from
 * @param opt? - Object that can contain fromBlock and Alethio service API key
 * @returns - URL to fetch the transactions from
 */
export function getAlethioApiUrl(networkType: string, address: string, opt?: FetchAllOptions) {
  if (networkType !== 'mainnet') {
    return { url: '', headers: {} };
  }
  let url = `https://api.aleth.io/v1/token-transfers?filter[to]=${address}`;
  // From alethio implementation
  // cursor = hardcoded prefix `0x00` + fromBlock in hex format + max possible tx index `ffff`
  let fromBlock = opt && opt.fromBlock;
  if (fromBlock) {
    fromBlock = parseInt(fromBlock).toString(16);
    let prev = `0x00${fromBlock}ffff`;
    while (prev.length < 34) {
      prev += '0';
    }
    url += `&page[prev]=${prev}`;
  }
  /* istanbul ignore next */
  const headers = opt && opt.alethioApiKey ? { Authorization: `Bearer ${opt.alethioApiKey}` } : undefined;
  return { url, headers };
}

/**
 * Handles the fetch of incoming transactions
 *
 * @param networkType - Network type of desired network
 * @param address - Address to get the transactions from
 * @param opt? - Object that can contain fromBlock and Alethio service API key
 * @returns - Responses for both ETH and ERC20 token transactions
 */
export async function handleTransactionFetch(
  networkType: string,
  address: string,
  opt?: FetchAllOptions,
): Promise<[{ [result: string]: [] }, { [data: string]: [] }]> {
  const url = getEtherscanApiUrl(networkType, address, opt && opt.fromBlock);
  const etherscanResponsePromise = handleFetch(url);
  const alethioUrl = getAlethioApiUrl(networkType, address, opt);
  const alethioResponsePromise = alethioUrl.url !== '' && handleFetch(alethioUrl.url, { headers: alethioUrl.headers });
  let [etherscanResponse, alethioResponse] = await Promise.all([etherscanResponsePromise, alethioResponsePromise]);
  if (etherscanResponse.status === '0' || etherscanResponse.result.length <= 0) {
    etherscanResponse = { result: [] };
  }
  if (!alethioUrl.url || !alethioResponse || !alethioResponse.data) {
    alethioResponse = { data: [] };
  }
  return [etherscanResponse, alethioResponse];
}

/**
 * Converts a hex string to a BN object
 *
 * @param inputHex - Number represented as a hex string
 * @returns - A BN instance
 *
 */
export function hexToBN(inputHex: string) {
  return new BN(stripHexPrefix(inputHex), 16);
}

/**
 * A helper function that converts hex data to human readable string
 *
 * @param hex - The hex string to convert to string
 * @returns - A human readable string conversion
 *
 */
export function hexToText(hex: string) {
  try {
    const stripped = stripHexPrefix(hex);
    const buff = Buffer.from(stripped, 'hex');
    return buff.toString('utf8');
  } catch (e) {
    /* istanbul ignore next */
    return hex;
  }
}

/**
 * Given the standard set of information about a transaction, returns a transaction properly formatted for
 * publishing via JSON RPC and web3
 *
 * @param {boolean} [sendToken] - Indicates whether or not the transaciton is a token transaction
 * @param {string} data - A hex string containing the data to include in the transaction
 * @param {string} to - A hex address of the tx recipient address
 * @param {string} amount - A hex amount, in case of a token tranaction will be set to Tx value
 * @param {string} from - A hex address of the tx sender address
 * @param {string} gas - A hex representation of the gas value for the transaction
 * @param {string} gasPrice - A hex representation of the gas price for the transaction
 * @returns {object} An object ready for submission to the blockchain, with all values appropriately hex prefixed
 */
export function constructTxParams({
  sendToken,
  data,
  to,
  amount,
  from,
  gas,
  gasPrice,
}: {
  sendToken?: boolean;
  data?: string;
  to?: string;
  from: string;
  gas?: string;
  gasPrice?: string;
  amount?: string;
}): any {
  const txParams: Transaction = {
    data,
    from,
    value: '0',
    gas,
    gasPrice,
  };

  if (!sendToken) {
    txParams.value = amount;
    txParams.to = to;
  }
  return normalizeTransaction(txParams);
}

/**
 * Normalizes properties on a Transaction object
 *
 * @param transaction - Transaction object to normalize
 * @returns - Normalized Transaction object
 */
export function normalizeTransaction(transaction: Transaction) {
  const normalizedTransaction: Transaction = { from: '' };
  let key: keyof Transaction;
  for (key in NORMALIZERS) {
    if (transaction[key as keyof Transaction]) {
      normalizedTransaction[key] = NORMALIZERS[key](transaction[key]) as never;
    }
  }
  return normalizedTransaction;
}

/**
 * Execute and return an asynchronous operation without throwing errors
 *
 * @param operation - Function returning a Promise
 * @param logError - Determines if the error should be logged
 * @param retry - Function called if an error is caught
 * @returns - Promise resolving to the result of the async operation
 */
export async function safelyExecute(operation: () => Promise<any>, logError = false, retry?: (error: Error) => void) {
  try {
    return await operation();
  } catch (error) {
    /* istanbul ignore next */
    if (logError) {
      console.error(error);
    }
    retry && retry(error);
  }
}

/**
 * Validates a Transaction object for required properties and throws in
 * the event of any validation error.
 *
 * @param transaction - Transaction object to validate
 */
export function validateTransaction(transaction: Transaction) {
  if (!transaction.from || typeof transaction.from !== 'string' || !isValidAddress(transaction.from)) {
    throw new Error(`Invalid "from" address: ${transaction.from} must be a valid string.`);
  }
  if (transaction.to === '0x' || transaction.to === undefined) {
    if (transaction.data) {
      delete transaction.to;
    } else {
      throw new Error(`Invalid "to" address: ${transaction.to} must be a valid string.`);
    }
  } else if (transaction.to !== undefined && !isValidAddress(transaction.to)) {
    throw new Error(`Invalid "to" address: ${transaction.to} must be a valid string.`);
  }
  if (transaction.value !== undefined) {
    const value = transaction.value.toString();
    if (value.includes('-')) {
      throw new Error(`Invalid "value": ${value} is not a positive number.`);
    }
    if (value.includes('.')) {
      throw new Error(`Invalid "value": ${value} number must be denominated in wei.`);
    }
    const intValue = parseInt(transaction.value, 10);
    const isValid =
      Number.isFinite(intValue) && !Number.isNaN(intValue) && !isNaN(Number(value)) && Number.isSafeInteger(intValue);
    if (!isValid) {
      throw new Error(`Invalid "value": ${value} number must be a valid number.`);
    }
  }
}

/**
 * A helper function that converts rawmessageData buffer data to a hex, or just returns the data if
 * it is already formatted as a hex.
 *
 * @param data - The buffer data to convert to a hex
 * @returns - A hex string conversion of the buffer data
 *
 */
export function normalizeMessageData(data: string) {
  try {
    const stripped = stripHexPrefix(data);
    if (stripped.match(hexRe)) {
      return addHexPrefix(stripped);
    }
  } catch (e) {
    /* istanbul ignore next */
  }
  return bufferToHex(Buffer.from(data, 'utf8'));
}

/**
 * Validates a PersonalMessageParams and MessageParams objects for required properties and throws in
 * the event of any validation error.
 *
 * @param messageData - PersonalMessageParams object to validate
 */
export function validateSignMessageData(messageData: PersonalMessageParams | MessageParams) {
  if (!messageData.from || typeof messageData.from !== 'string' || !isValidAddress(messageData.from)) {
    throw new Error(`Invalid "from" address: ${messageData.from} must be a valid string.`);
  }
  if (!messageData.data || typeof messageData.data !== 'string') {
    throw new Error(`Invalid message "data": ${messageData.data} must be a valid string.`);
  }
}

/**
 * Validates a TypedMessageParams object for required properties and throws in
 * the event of any validation error for eth_signTypedMessage_V1.
 *
 * @param messageData - TypedMessageParams object to validate
 * @param activeChainId - Active chain id
 */
export function validateTypedSignMessageDataV1(messageData: TypedMessageParams) {
  if (!messageData.from || typeof messageData.from !== 'string' || !isValidAddress(messageData.from)) {
    throw new Error(`Invalid "from" address: ${messageData.from} must be a valid string.`);
  }
  if (!messageData.data || !Array.isArray(messageData.data)) {
    throw new Error(`Invalid message "data": ${messageData.data} must be a valid array.`);
  }
  try {
    // typedSignatureHash will throw if the data is invalid.
    typedSignatureHash(messageData.data as any);
  } catch (e) {
    throw new Error(`Expected EIP712 typed data.`);
  }
}

/**
 * Validates a TypedMessageParams object for required properties and throws in
 * the event of any validation error for eth_signTypedMessage_V3.
 *
 * @param messageData - TypedMessageParams object to validate
 */
export function validateTypedSignMessageDataV3(messageData: TypedMessageParams) {
  if (!messageData.from || typeof messageData.from !== 'string' || !isValidAddress(messageData.from)) {
    throw new Error(`Invalid "from" address: ${messageData.from} must be a valid string.`);
  }
  if (!messageData.data || typeof messageData.data !== 'string') {
    throw new Error(`Invalid message "data": ${messageData.data} must be a valid array.`);
  }
  let data;
  try {
    data = JSON.parse(messageData.data);
  } catch (e) {
    throw new Error('Data must be passed as a valid JSON string.');
  }
  const validation = jsonschema.validate(data, TYPED_MESSAGE_SCHEMA);
  if (validation.errors.length > 0) {
    throw new Error('Data must conform to EIP-712 schema. See https://git.io/fNtcx.');
  }
}

/**
 * Validates a ERC20 token to be added with EIP747.
 *
 * @param token - Token object to validate
 */
export function validateTokenToWatch(token: Token) {
  const { address, symbol, decimals } = token;
  if (!address || !symbol || typeof decimals === 'undefined') {
    throw new Error(`Cannot suggest token without address, symbol, and decimals`);
  }
  if (!(symbol.length < 7)) {
    throw new Error(`Invalid symbol ${symbol} more than six characters`);
  }
  if (isNaN(decimals) || decimals > 36 || decimals < 0) {
    throw new Error(`Invalid decimals ${decimals} must be at least 0, and not over 36`);
  }
  if (!isValidAddress(address)) {
    throw new Error(`Invalid address ${address}`);
  }
}

/**
 * Returns wether the given code corresponds to a smart contract
 *
 * @returns {string} - Corresponding code to review
 */
export function isSmartContractCode(code: string) {
  /* istanbul ignore if */
  if (!code) {
    return false;
  }
  // Geth will return '0x', and ganache-core v2.2.1 will return '0x0'
  const smartContractCode = code !== '0x' && code !== '0x0';
  return smartContractCode;
}

/**
 * Execute fetch and verify that the response was successful
 *
 * @param request - Request information
 * @param options - Options
 * @returns - Promise resolving to the fetch response
 */
export async function successfulFetch(request: string, options?: RequestInit) {
  const response = await fetch(request, options);
  if (!response.ok) {
    throw new Error(`Fetch failed with status '${response.status}' for request '${request}'`);
  }
  return response;
}

/**
 * Execute fetch and return object response
 *
 * @param request - Request information
 * @param options - Options
 * @returns - Promise resolving to the result object of fetch
 */
export async function handleFetch(request: string, options?: RequestInit) {
  const response = await successfulFetch(request, options);
  const object = await response.json();

  return object;
}

/**
 * Fetch that fails after timeout
 *
 * @param url - Url to fetch
 * @param options - Options to send with the request
 * @param timeout - Timeout to fail request
 *
 * @returns - Promise resolving the request
 */
export async function timeoutFetch(url: string, options?: RequestInit, timeout = 500): Promise<any> {
  return Promise.race([
    handleFetch(url, options),
    new Promise<void>((_, reject) =>
      setTimeout(() => {
        reject(new Error('timeout'));
      }, timeout),
    ),
  ]);
}

/**
 * Normalizes the given ENS name.
 *
 * @param {string} ensName - The ENS name
 *
 * @returns - the normalized ENS name string
 */
export function normalizeEnsName(ensName: string): string | null {
  if (ensName && typeof ensName === 'string') {
    try {
      const normalized = ensNamehash.normalize(ensName.trim());
      // this regex is only sufficient with the above call to ensNamehash.normalize
      // TODO: change 7 in regex to 3 when shorter ENS domains are live
      // eslint-disable-next-line require-unicode-regexp
      if (normalized.match(/^(([\w\d\-]+)\.)*[\w\d\-]{7,}\.(eth|test)$/)) {
        return normalized;
      }
    } catch (_) {
      // do nothing
    }
  }
  return null;
}

export function calcTokenAmount(value: number, decimals: number) {
  const multiplier = Math.pow(10, Number(decimals || 0));
  return new BigNumber(String(value)).div(multiplier);
}

/**
 * Query format using current provided eth query object
 * @param method - Method to query
 * @param ethQuery - EthQuery object
 * @param args - Conveninent arguments to execute the query
 * @returns - Promise resolving to the respective result
 */
export async function query(method: string, ethQuery: any, args: any[] = []): Promise<any> {
  return new Promise((resolve, reject) => {
    ethQuery[method](...args, (error: Error, result: any) => {
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
export async function estimateGas(transaction: Transaction, ethQuery: any) {
  console.log('GAGAGAGAAGAGGA', 'estimateGas');
  const estimatedTransaction = { ...transaction };
  const { gasLimit } = await query('getBlockByNumber', ethQuery, ['latest']);
  const { gas, gasPrice: providedGasPrice, to, value, data } = estimatedTransaction;
  const gasPrice = typeof providedGasPrice === 'undefined' ? await query('gasPrice', ethQuery) : providedGasPrice;

  // 1. If gas is already defined on the transaction, use it
  if (typeof gas !== 'undefined') {
    return { gas, gasPrice };
  }

  // 2. If to is not defined or this is not a contract address, and there is no data use 0x5208 / 21000
  /* istanbul ignore next */
  const code = to ? await query('getCode', ethQuery, [to]) : undefined;
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
  const gasHex = await query('estimateGas', ethQuery, [estimatedTransaction]);

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

export default {
  BNToHex,
  fractionBN,
  getBuyURL,
  handleFetch,
  hexToBN,
  hexToText,
  isSmartContractCode,
  constructTxParams,
  normalizeTransaction,
  safelyExecute,
  successfulFetch,
  timeoutFetch,
  validateTokenToWatch,
  validateTransaction,
  validateTypedSignMessageDataV1,
  validateTypedSignMessageDataV3,
  calcTokenAmount,
  estimateGas,
  query,
};
