import { configVariable, defineConfig } from "hardhat/config";
import hardhatToolboxViem from "@nomicfoundation/hardhat-toolbox-viem";

export default defineConfig({
  plugins: [hardhatToolboxViem],
  solidity: {
    version: "0.8.28",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    bscFork: {
      type: "edr-simulated",
      chainType: "l1",
      forking: { url: "https://bsc-dataseed.bnbchain.org" },
    },
    bsc: {
      type: "http",
      chainType: "l1",
      url: "https://bsc-dataseed.bnbchain.org",
      accounts: [configVariable("DEPLOYER_PRIVATE_KEY")],
    },
  },
});
