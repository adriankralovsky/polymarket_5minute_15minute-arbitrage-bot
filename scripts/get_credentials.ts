import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import * as dotenv from "dotenv";

// Load environment variables from .env
dotenv.config();

async function getCreds() {
    if (!process.env.POLY_PRIVATE_KEY) {
        console.error("❌ Error: POLY_PRIVATE_KEY is missing in your .env file!");
        return;
    }

    const wallet = new Wallet(process.env.POLY_PRIVATE_KEY);

    // Create an adapter for ethers v6 to match the ClobSigner interface (which expects ethers v5 or viem)
    const signer = {
        _signTypedData: (domain: any, types: any, value: any) => wallet.signTypedData(domain, types, value),
        getAddress: async () => wallet.address,
    } as any;

    // Initialize the official client
    const client = new ClobClient(
        "https://clob.polymarket.com",
        137, // Polygon mainnet
        signer
    );

    console.log("⏳ Deriving API credentials from your private key...");

    try {
        // This derives your existing credentials or creates new ones if they don't exist
        const credentials = await client.createOrDeriveApiKey();

        console.log("✅ SUCCESS! Copy these into your .env file:");
        console.log("-----------------------------------------");
        console.log(`POLY_API_KEY=${credentials.key}`);
        console.log(`POLY_API_SECRET=${credentials.secret}`);
        console.log(`POLY_API_PASSPHRASE=${credentials.passphrase}`);
        console.log("-----------------------------------------");
    } catch (error) {
        console.error("❌ Failed to derive credentials:", error);
    }
}

getCreds();