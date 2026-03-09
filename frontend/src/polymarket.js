export const CLOB_HOST = "https://clob.polymarket.com";
export const CLOB_CHAIN_ID = 137;
export const TRADING_SIDE = {
  BUY: "BUY",
  SELL: "SELL",
};
export const TRADING_ASSET_TYPE = {
  COLLATERAL: "COLLATERAL",
  CONDITIONAL: "CONDITIONAL",
};

function parseList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function parseMarketTokens(market) {
  const outcomes = parseList(market?.outcomes);
  const tokenIds = parseList(market?.clobTokenIds);
  const prices = parseList(market?.outcomePrices);
  return outcomes
    .map((outcome, index) => {
      const tokenId = tokenIds[index];
      if (!tokenId) return null;
      const priceValue = Number(prices[index]);
      return {
        outcome: String(outcome || `Outcome ${index + 1}`),
        tokenId: String(tokenId),
        price: Number.isFinite(priceValue) ? priceValue : null,
      };
    })
    .filter(Boolean);
}

export async function connectBrowserWallet() {
  if (!window?.ethereum) {
    throw new Error("No wallet provider found. Install MetaMask or a compatible wallet.");
  }
  const { ethers } = await import("ethers");
  const provider = new ethers.providers.Web3Provider(window.ethereum, "any");
  await provider.send("eth_requestAccounts", []);
  const signer = provider.getSigner();
  const address = String(await signer.getAddress()).toLowerCase();
  return { provider, signer, address };
}

export async function createTradingClient() {
  const { ClobClient, SignatureType } = await import("@polymarket/clob-client");
  const { provider, signer, address } = await connectBrowserWallet();
  const bootstrapClient = new ClobClient(
    CLOB_HOST,
    CLOB_CHAIN_ID,
    signer,
    undefined,
    SignatureType.EOA,
    address,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    true
  );
  const creds = await bootstrapClient.createOrDeriveApiKey();
  const client = new ClobClient(
    CLOB_HOST,
    CLOB_CHAIN_ID,
    signer,
    creds,
    SignatureType.EOA,
    address,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    true
  );
  return { client, provider, signer, address };
}
