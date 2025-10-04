import { Transaction, WebSocketProvider } from "ethers";
import fs from "fs";

// Kết nối tới node Geth local (WS port 8546)
const provider = new WebSocketProvider("ws://127.0.0.1:8546");

// Địa chỉ contract muốn filter (ví dụ UniswapV2 Router)
const targetAddress = "0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af".toLowerCase();

// File để lưu kết quả
const outputFile = "filtered_tx.txt";

async function main() {
    console.log("🔎 Subscribing pending transactions...");

    provider.on("pending", async (txHash) => {

        try {
            const tx = await provider.getTransaction(txHash);


            console.log(Transaction.from(tx).serialized);


            if (tx) {
                if (tx.to && tx.to.toLowerCase() === targetAddress) {

                    // Ghi thêm vào file
                    const logData = `${new Date().toISOString()} | ${txHash}\n`;
                    fs.appendFileSync(outputFile, logData);
                    console.log("🎯 Found tx to target contract, saved to file:", tx.hash);
                }
            }
        } catch (err) {
            console.error("⚠️ Error fetching tx:", err.message);
        }
    });
}

main();
