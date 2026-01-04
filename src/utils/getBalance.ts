import { ethers } from "ethers";
import { ENV } from "../config/env";

const USDC_ABI = ["function balanceOf(address owner) view returns (uint256)"];

export async function getUSDCBalance(walletAddress: string): Promise<number> {
  try {
    const provider = new ethers.providers.JsonRpcProvider(ENV.RPC_URL);
    const usdcContract = new ethers.Contract(
      ENV.USDC_CONTRACT_ADDRESS,
      USDC_ABI,
      provider
    );

    const balance = await usdcContract.balanceOf(walletAddress);
    // USDC has 6 decimals
    return parseFloat(ethers.utils.formatUnits(balance, 6));
  } catch (error) {
    console.error("Error fetching USDC balance:", error);
    throw error;
  }
}

export default getUSDCBalance;
