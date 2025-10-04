// poll-pending-bounded.ts
import { JsonRpcProvider } from "ethers";
import fs from "fs";

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const provider = new JsonRpcProvider(RPC_URL);

const targetAddress = "0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af".toLowerCase();
const outputFile = "filtered_xxtx333.txt";

// ===== Tuning =====
const POLL_MS = 2000;
const MAX_RETRY = 6;
const BASE_BACKOFF = 40;
const CONCURRENCY = 64;

// Chống phình bộ nhớ
const SEEN_TTL_MS = 10 * 60 * 1000;     // 10 phút
const SEEN_MAX = 2_000_000;             // ~2M hash (tùy máy)
const SAVED_TTL_MS = 60 * 60 * 1000;    // 60 phút
const SAVED_MAX = 2_000_000;

const MAX_QUEUE = 200_000;              // hash chờ re-fetch tối đa
const CLEAN_EVERY = 10_000;             // số lần add trước khi chạy cleanup
// ====================

type TS = number;
class TTLSet {
    private m = new Map<string, TS>();
    private ttl: number;
    private max: number;
    private addCount = 0;

    constructor(ttl: number, max: number) {
        this.ttl = ttl; this.max = max;
    }
    has(k: string) {
        const t = this.m.get(k);
        if (t === undefined) return false;
        if (t < Date.now()) { this.m.delete(k); return false; }
        return true;
    }
    add(k: string) {
        const now = Date.now();
        this.m.set(k, now + this.ttl);
        // cleanup theo định kỳ + theo kích thước
        if (++this.addCount % CLEAN_EVERY === 0 || this.m.size > this.max) this.cleanup();
    }
    size() { return this.m.size; }
    cleanup() {
        const now = Date.now();
        // 1) xóa hết hạn
        for (const [k, exp] of this.m) {
            if (exp < now) this.m.delete(k);
        }
        // 2) nếu vẫn quá max → cắt bớt theo “oldest expiry”
        if (this.m.size > this.max) {
            // chuyển sang mảng, sort theo expiry, giữ lại cuối (expiry xa)
            const arr = Array.from(this.m.entries());
            arr.sort((a, b) => a[1] - b[1]);
            const toRemove = this.m.size - this.max;
            for (let i = 0; i < toRemove; i++) this.m.delete(arr[i][0]);
        }
    }
}

const seen = new TTLSet(SEEN_TTL_MS, SEEN_MAX);
const saved = new TTLSet(SAVED_TTL_MS, SAVED_MAX);

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function getTxWithRetry(hash: string) {
    for (let i = 0; i < MAX_RETRY; i++) {
        try {
            const tx = await provider.getTransaction(hash);
            if (tx) return tx;
        } catch { }
        await sleep(BASE_BACKOFF * Math.pow(1.4, i));
    }
    return null;
}

function saveIfMatch(tx: any) {
    const to = tx?.to?.toLowerCase?.();
    if (!to || to !== targetAddress) return;
    const h = (tx.hash as string).toLowerCase();
    if (saved.has(h)) return;
    fs.appendFileSync(outputFile, `${new Date().toISOString()} | ${h}\n`);
    saved.add(h);
    // console.log("🎯 saved:", h);
}

// Queue bounded
const q: string[] = [];
function enqueueMany(hashes: string[]) {
    for (const raw of hashes) {
        const h = raw?.toLowerCase?.();
        if (!h) continue;
        if (seen.has(h)) continue;
        if (q.length >= MAX_QUEUE) {
            // drop oldest 1% để tránh OOM
            const drop = Math.ceil(MAX_QUEUE * 0.01);
            q.splice(0, drop);
            console.warn(`⚠️ queue full → dropped ${drop}, keep=${q.length}`);
        }
        q.push(h);
        seen.add(h);
    }
}

async function listPendingHashes(): Promise<string[]> {
    // Ưu tiên txpool_content
    try {
        const c = await provider.send("txpool_content", []);
        const out: string[] = [];
        for (const bucketName of ["pending", "queued"] as const) {
            const bucket = c?.[bucketName]; if (!bucket) continue;
            for (const from of Object.keys(bucket)) {
                const nonces = bucket[from];
                for (const n of Object.keys(nonces)) {
                    const tx = nonces[n];
                    const h = tx?.hash;
                    if (h) out.push(h);
                }
            }
        }
        return out;
    } catch {
        // Fallback
        try {
            const arr = await provider.send("eth_pendingTransactions", []);
            return (arr ?? []).map((tx: any) => tx?.hash).filter(Boolean);
        } catch {
            try {
                const arr = await provider.send("parity_pendingTransactions", []);
                return (arr ?? []).map((tx: any) => tx?.hash).filter(Boolean);
            } catch (e: any) {
                throw new Error("Không đọc được pending list. Bật --http.api …,txpool trên node.");
            }
        }
    }
}

async function processQueue() {
    if (!q.length) return;
    let idx = 0;
    const N = Math.min(q.length, MAX_QUEUE);
    async function worker() {
        while (true) {
            const i = idx++;
            if (i >= N) break;
            const h = q[i];
            const tx = await getTxWithRetry(h);
            if (tx) saveIfMatch(tx);
            // xóa khỏi đầu sau khi chạy xong loạt này
        }
    }
    const workers = Array.from({ length: Math.min(CONCURRENCY, N) }, worker);
    await Promise.all(workers);
    // bỏ các phần tử đã xử lý
    q.splice(0, N);
}

async function loop() {
    console.log("🌀 polling", RPC_URL, "every", POLL_MS, "ms");
    for (; ;) {
        const t0 = Date.now();
        try {
            const list = await listPendingHashes();
            if (list?.length) enqueueMany(list);
            await processQueue();
            // dọn TTL (nhẹ)
            if (Math.random() < 0.1) { seen.cleanup(); saved.cleanup(); }
        } catch (e: any) {
            console.warn("poll error:", e?.message || e);
        }
        const dt = Date.now() - t0;
        if (dt < POLL_MS) await sleep(POLL_MS - dt);
    }
}

loop().catch(e => { console.error(e); process.exit(1); });
