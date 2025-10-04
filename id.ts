import { Transaction, WebSocketProvider } from "ethers";
import fs from "fs";

// WS tới Geth local
const WS_URL = "ws://127.0.0.1:8546";
const provider = new WebSocketProvider(WS_URL);

// Contract cần lọc
const targetAddress = "0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af".toLowerCase();

// File log
const outputFile = "filtered_tx222.txt";

// ====== Tuning ======
const BATCH_SIZE = 8000;          // số hash xử lý mỗi tick
const TICK_MS = 100;             // chu kỳ worker
const MAX_RETRY = 100;            // số lần retry getTransaction
const BASE_BACKOFF_MS = 50;      // backoff cơ bản
const BACKFILL_INTERVAL_MS = 1000; // chu kỳ backfill txpool_content
// =====================

/** Hàng đợi hash cần fetch chi tiết */
const q: string[] = [];
/** Đánh dấu đã thấy để dedup queue & tránh log trùng */
const seen = new Set<string>();
/** Đánh dấu đã lưu (để không ghi file lặp) */
const saved = new Set<string>();

/** Enqueue hash an toàn */
function enqueue(hash: string) {
    if (!hash || typeof hash !== "string") return;
    hash = hash.toLowerCase();
    if (!seen.has(hash)) {
        seen.add(hash);
        q.push(hash);
    }
}

async function fetchTxWithRetry(hash: string) {
    let attempt = 0;
    while (attempt < MAX_RETRY) {
        try {
            const tx = await provider.getTransaction(hash);
            if (tx) return tx;
            // null → có thể do race; chờ backoff rồi thử lại
        } catch (e) {
            // cứ retry với backoff
        }
        attempt++;
        const delay = BASE_BACKOFF_MS * Math.pow(1.4, attempt); // backoff nhẹ
        await new Promise(r => setTimeout(r, delay));
    }
    return null;
}

/** Ghi kết quả khi match target (idempotent) */
function saveIfMatch(tx: any) {
    try {
        const to = tx.to?.toLowerCase?.();
        if (to && to === targetAddress) {
            const h = (tx.hash as string).toLowerCase();
            if (saved.has(h)) return;
            const line = `${new Date().toISOString()} | ${h}\n`;
            fs.appendFileSync(outputFile, line);
            saved.add(h);
            console.log("🎯 Found tx to target, saved:", h);
        }
    } catch (e: any) {
        console.error("Write failed:", e?.message || e);
    }
}

/** Worker: rút batch hash rồi re-fetch chi tiết */
async function worker() {
    if (!q.length) return;
    const batch = q.splice(0, BATCH_SIZE);
    await Promise.all(
        batch.map(async (h) => {
            const tx = await fetchTxWithRetry(h);
            if (!tx) return; // bỏ qua nếu vẫn null sau MAX_RETRY
            // In raw serialized (nếu cần debug)
            try {
                const serialized = Transaction.from(tx as any).serialized;
                // console.log(serialized);
            } catch { }
            saveIfMatch(tx);
        })
    );
}

/** Backfill: quét txpool_content để vá lưới */
async function backfillTxpool() {
    try {
        const content = await provider.send("txpool_content", []);
        // Geth trả về: { pending: { [from]: { [nonce]: txObj } }, queued: {...} }
        const buckets = ["pending", "queued"] as const;
        for (const b of buckets) {
            const bucket = content?.[b];
            if (!bucket) continue;
            for (const _from of Object.keys(bucket)) {
                const nonces = bucket[_from];
                for (const nonce of Object.keys(nonces)) {
                    const tx = nonces[nonce];
                    // Ưu tiên có hash; nếu không có, có thể compute từ Transaction.from
                    let hash: string | undefined = tx?.hash;
                    if (!hash) {
                        try {
                            const computedHash = Transaction.from({
                                to: tx.to,
                                from: tx.from,
                                nonce: tx.nonce,
                                gasLimit: tx.gas || tx.gasLimit,
                                data: tx.input,
                                value: tx.value,
                                maxFeePerGas: tx.maxFeePerGas,
                                maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
                                gasPrice: tx.gasPrice, // legacy
                                chainId: tx.chainId,
                                type: tx.type,
                            }).hash;
                            hash = computedHash || undefined;
                        } catch { }
                    }
                    if (hash) enqueue(hash);
                    // Nếu muốn xử lý ngay (khỏi re-fetch): có thể save trực tiếp từ txpool
                    // nhưng để đồng nhất luồng dữ liệu, ta vẫn enqueue để dùng cùng logic re-fetch.
                }
            }
        }
    } catch (e: any) {
        // Thường gặp nếu node không bật txpool_* qua WS/provider này
        console.warn("Backfill txpool_content failed:", e?.message || e);
    }
}

async function main() {
    console.log("🔎 Subscribing pending transactions…", WS_URL);

    // Subscribe stream pending
    provider.on("pending", (txHash: string) => {
        enqueue(txHash);
    });

    // Định kỳ chạy worker
    setInterval(() => {
        worker().catch((e) => console.error("worker err:", e));
    }, TICK_MS);

    // Định kỳ backfill txpool (chỉ hoạt động nếu node local bật txpool API)
    setInterval(() => {
        backfillTxpool().catch(() => { });
    }, BACKFILL_INTERVAL_MS);

    // Log sự cố WS (tùy chọn)
    (provider as any)._websocket?.on?.("close", (c: any) => {
        console.warn("WS closed:", c);
    });
    (provider as any)._websocket?.on?.("error", (e: any) => {
        console.warn("WS error:", e?.message || e);
    });

    console.log("✅ Ready. Listening…");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});

// Graceful shutdown
process.on("SIGINT", () => {
    console.log("Bye");
    process.exit(0);
});
