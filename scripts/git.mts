/**
 * Minimal git wrapper over isomorphic-git (system git is not installed; see docs/DECISIONS.md #1).
 * Usage: tsx scripts/git.mts commit "message" | log | status
 */
import fs from 'node:fs';
import path from 'node:path';
import git from 'isomorphic-git';

const dir = process.cwd();
const author = { name: 'Adaptive Chess Tutor build', email: 'build@localhost' };

async function ensureRepo(): Promise<void> {
  if (!fs.existsSync(path.join(dir, '.git'))) await git.init({ fs, dir, defaultBranch: 'main' });
}

async function stageAll(): Promise<number> {
  const matrix = await git.statusMatrix({ fs, dir });
  let n = 0;
  for (const [filepath, head, workdir, stage] of matrix) {
    if (workdir === 0) {
      if (head === 1 || stage !== 0) {
        await git.remove({ fs, dir, filepath });
        n++;
      }
    } else if (workdir !== stage || head !== workdir) {
      if (!(head === 1 && workdir === 1 && stage === 1)) {
        await git.add({ fs, dir, filepath });
        n++;
      }
    }
  }
  return n;
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  await ensureRepo();
  if (cmd === 'commit') {
    const message = rest.join(' ').trim();
    if (!message) throw new Error('commit message required');
    const n = await stageAll();
    if (n === 0) {
      console.log('nothing to commit');
      return;
    }
    const sha = await git.commit({ fs, dir, message, author });
    console.log(`committed ${sha.slice(0, 8)} (${n} paths): ${message.split('\n')[0]}`);
  } else if (cmd === 'log') {
    const commits = await git.log({ fs, dir, depth: Number(rest[0] ?? 30) }).catch(() => []);
    for (const c of commits) console.log(`${c.oid.slice(0, 8)} ${c.commit.message.split('\n')[0]}`);
  } else if (cmd === 'status') {
    const matrix = await git.statusMatrix({ fs, dir });
    for (const [f, h, w, s] of matrix) if (!(h === 1 && w === 1 && s === 1)) console.log(`${h}${w}${s} ${f}`);
  } else {
    throw new Error('usage: git.mts commit "msg" | log [n] | status');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
