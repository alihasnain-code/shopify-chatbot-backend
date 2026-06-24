import { shopifyApi, ApiVersion } from "@shopify/shopify-api";
import "@shopify/shopify-api/adapters/node";

const shopify = shopifyApp({
    apiKey: process.env.SHOPIFY_API_KEY,
    apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
    apiVersion: ApiVersion.April26,
    scopes: process.env.SCOPES?.split(","),
    hostName: process.env.HOSTNAME,
    future: {
        expiringOfflineAccessTokens: true,
    },
});

export default shopify;
export const apiVersion = ApiVersion.April26;