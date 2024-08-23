import { ethers, AbiCoder } from "ethers";
import { GatewayQuoteParams } from "./types";
import { TOKENS_INFO, ADDRESS_LOOKUP, Token as TokenInfo } from "./tokens";

type EvmAddress = string;

type GatewayQuote = {
    /** @description The gateway address */
    gatewayAddress: EvmAddress;
    /** @description The minimum amount of Bitcoin to send */
    dustThreshold: number;
    /** @description The satoshi output amount */
    satoshis: number;
    /** @description The fee paid in satoshis (includes gas refill) */
    fee: number;
    /** @description The Bitcoin address to send BTC */
    bitcoinAddress: string;
    /** @description The number of confirmations required to confirm the Bitcoin tx */
    txProofDifficultyFactor: number;
    /** @description The optional strategy address */
    strategyAddress: EvmAddress | null,
};

/** @dev Internal request type used to call the Gateway API */
type GatewayCreateOrderRequest = {
    gatewayAddress: EvmAddress,
    strategyAddress: EvmAddress | null,
    satsToConvertToEth: number,
    userAddress: EvmAddress,
    gatewayExtraData: string | null,
    strategyExtraData: string | null,
    satoshis: number,
};

type GatewayOrderResponse = {
    /** @description The gateway address */
    gatewayAddress: EvmAddress;
    /** @description The token address */
    tokenAddress: EvmAddress;
    /** @description The Bitcoin txid */
    txid: string;
    /** @description True when the order was executed on BOB */
    status: boolean;
    /** @description When the order was created */
    timestamp: number;
    /** @description The converted satoshi amount */
    tokens: string;
    /** @description The satoshi output amount */
    satoshis: number;
    /** @description The fee paid in satoshis (includes gas refill) */
    fee: number;
    /** @description The number of confirmations required to confirm the Bitcoin tx */
    txProofDifficultyFactor: number;
    /** @description The optional strategy address */
    strategyAddress: EvmAddress | null,
    /** @description The gas refill in satoshis */
    satsToConvertToEth: number,
};

/** Order given by the Gateway API once the bitcoin tx is submitted */
type GatewayOrder = Omit<GatewayOrderResponse & {
    /** @description The gas refill in satoshis */
    gasRefill: number,
}, "satsToConvertToEth">;

type GatewayCreateOrderResponse = {
    uuid: string,
    opReturnHash: string,
};

/** @dev The success type on create order */
type GatewayStartOrderResult = GatewayCreateOrderResponse & {
    bitcoinAddress: string,
    satoshis: number;
};

/**
 * Base url for the mainnet Gateway API.
 * @default "https://gateway-api-mainnet.gobob.xyz"
 */
export const MAINNET_GATEWAY_BASE_URL = "https://gateway-api-mainnet.gobob.xyz";

/**
 * Base url for the testnet Gateway API.
 * @default "https://gateway-api-testnet.gobob.xyz"
 */
export const TESTNET_GATEWAY_BASE_URL = "https://gateway-api-testnet.gobob.xyz";

enum Network {
    Mainnet,
    Testnet,
}

/**
 * Gateway REST HTTP API client 
 */
export class GatewayApiClient {
    private network: Network;
    private baseUrl: string;

    /**
     * @constructor
     * @param networkOrUrl The network ID or Gateway API URL.
     */
    constructor(networkOrUrl: string = "mainnet") {
        switch (networkOrUrl) {
            case "mainnet" || "bob":
                this.network = Network.Mainnet;
                this.baseUrl = MAINNET_GATEWAY_BASE_URL;
                break;
            case "testnet" || "bobSepolia":
                this.network = Network.Testnet;
                this.baseUrl = TESTNET_GATEWAY_BASE_URL;
                break;
            default:
                this.baseUrl = networkOrUrl;
        }
    }

    /**
     * Get a quote from the Gateway API for swapping or staking BTC.
     * 
     * @param params The parameters for the quote.
     */
    async getQuote(params: GatewayQuoteParams): Promise<GatewayQuote> {
        const isMainnet = params.toChain == "bob" || params.toChain == 60808;
        const isTestnet = params.toChain == "bobSepolia" || params.toChain == 808813;

        let outputToken = "";
        if (params.toToken.startsWith("0x")) {
            outputToken = params.toToken;
        } else if (params.toToken in TOKENS_INFO) {
            if (isMainnet && this.network === Network.Mainnet) {
                outputToken = TOKENS_INFO[params.toToken].bob;
            } else if (isTestnet && this.network === Network.Testnet) {
                outputToken = TOKENS_INFO[params.toToken].bobSepolia;
            } else {
                throw new Error('Unknown network');
            }
        } else {
            throw new Error('Unknown output token');
        }

        const atomicAmount = params.amount;
        const response = await fetch(`${this.baseUrl}/quote/${outputToken}/${atomicAmount || ''}`, {
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json'
            }
        });

        return await response.json();
    }

    // TODO: add error handling
    /**
     * Start an order via the Gateway API to reserve liquidity. This is step 1 of 2, see the {@link finalizeOrder} method.
     * 
     * @param gatewayQuote The quote given by the {@link getQuote} method.
     * @param params The parameters for the quote, same as before.
     * @returns {Promise<GatewayStartOrderResult>} The success object.
     */
    async startOrder(gatewayQuote: GatewayQuote, params: GatewayQuoteParams): Promise<GatewayStartOrderResult> {
        const request: GatewayCreateOrderRequest = {
            gatewayAddress: gatewayQuote.gatewayAddress,
            strategyAddress: gatewayQuote.strategyAddress,
            satsToConvertToEth: params.gasRefill,
            userAddress: params.toUserAddress,
            // TODO: figure out how to get extra data
            gatewayExtraData: null,
            strategyExtraData: null,
            satoshis: gatewayQuote.satoshis,
        };

        const response = await fetch(`${this.baseUrl}/order`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json'
            },
            body: JSON.stringify(request)
        });

        if (!response.ok) {
            throw new Error('Failed to create order');
        }

        const data: GatewayCreateOrderResponse = await response.json();
        // NOTE: could remove this check but good for sanity
        if (data.opReturnHash != calculateOpReturnHash(request)) {
            throw new Error('Invalid OP_RETURN hash');
        }

        return {
            uuid: data.uuid,
            opReturnHash: data.opReturnHash,
            bitcoinAddress: gatewayQuote.bitcoinAddress,
            satoshis: gatewayQuote.satoshis,
        }
    }

    /**
     * Finalize an order via the Gateway API by providing the Bitcoin transaction. The tx will
     * be validated for correctness and forwarded to the mempool so there is no need to separately
     * broadcast the transaction. This is step 2 of 2, see the {@link startOrder} method.
     * 
     * @param uuid The id given by the {@link startOrder} method.
     * @param bitcoinTxHex The hex encoded Bitcoin transaction.
     */
    async finalizeOrder(uuid: string, bitcoinTxHex: string) {
        const response = await fetch(`${this.baseUrl}/order/${uuid}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json'
            },
            body: JSON.stringify({ bitcoinTx: bitcoinTxHex })
        });

        if (!response.ok) {
            throw new Error('Failed to update order');
        }
    }

    /**
     * Returns all pending and completed orders for this account.
     * 
     * @param userAddress The user's EVM address.
     * @returns {Promise<GatewayOrder[]>} The array of account orders.
     */
    async getOrders(userAddress: EvmAddress): Promise<GatewayOrder[]> {
        const response = await fetch(`${this.baseUrl}/orders/${userAddress}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json'
            }
        });

        const orders: GatewayOrderResponse[] = await response.json();
        return orders.map(order => { return { gasRefill: order.satsToConvertToEth, ...order } });
    }

    /**
     * Returns all tokens (and strategy tokens) supported by the Gateway API.
     * 
     * @returns {Promise<EvmAddress[]>} The array of token addresses.
     */
    async getTokens(): Promise<EvmAddress[]> {
        const response = await fetch(`${this.baseUrl}/tokens`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json'
            }
        });

        return response.json();
    }

    /**
     * Same as {@link getTokens} but with additional info.
     * 
     * @returns {Promise<EvmAddress[]>} The array of tokens.
     */
    async getTokensInfo(): Promise<TokenInfo[]> {
        const tokens = await this.getTokens();
        return tokens
            .map(token => ADDRESS_LOOKUP[token])
            .filter(token => token !== undefined);;
    }
}

/**
 * Should compute the same OP_RETURN hash as the Gateway API and smart contracts.
 * This is used for data integrity checking.
 */
function calculateOpReturnHash(req: GatewayCreateOrderRequest) {
    const abiCoder = new AbiCoder();
    return ethers.keccak256(abiCoder.encode(
        ["address", "address", "uint256", "address", "bytes", "bytes"],
        [
            req.gatewayAddress,
            req.strategyAddress || ethers.ZeroAddress,
            req.satsToConvertToEth,
            req.userAddress,
            req.gatewayExtraData,
            req.strategyExtraData
        ]
    ))
}