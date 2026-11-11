// Smoke test: `npx tsx scripts/lib/sfcheck.ts` — confirms Stockfish runs in Node through the shared wrapper.
import { NodeStockfish } from './pack';

const sf = new NodeStockfish();
await sf.init();
const t = Date.now();
const lines = await sf.analyse('r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3', { depth: 14, multipv: 3 });
console.log(JSON.stringify(lines.map((l) => ({ d: l.depth, cp: l.cp, pv: l.pv.slice(0, 3) }))), `${Date.now() - t}ms`);
sf.quit();
process.exit(0);
