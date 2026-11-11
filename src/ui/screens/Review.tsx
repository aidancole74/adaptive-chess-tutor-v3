/**
 * Game review: import games (Lichess, Chess.com, PGN), analyse them progressively with the local
 * engine, list mistakes with the detectors' classification, an eval graph and a time report, and
 * turn classified mistakes into practice exercises.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { conceptName } from '../../curriculum/concepts';
import { AnalysisQueue, MATE_CAP } from '../../diagnosis/analyze';
import { diagnose } from '../../diagnosis/diagnose';
import { buildSpotMistake } from '../../diagnosis/exercises';
import { inferCause, timeInfoFor, timeReport } from '../../diagnosis/time';
import type { GameAnalysis, Mistake } from '../../diagnosis/types';
import { getEngine } from '../../engine/stockfish';
import type { Exercise } from '../../exercises/types';
import { fetchChessComGames } from '../../importers/chesscom';
import { fetchLichessGames, type ImportResult } from '../../importers/lichess';
import { parsePgn } from '../../importers/pgn';
import type { ImportedGame } from '../../importers/types';
import { getDb, type StoredGame } from '../../model/db';
import type { BoardTheme } from '../../model/settings';
import { Board } from '../Board';

export interface ReviewProps {
  theme: BoardTheme;
  username?: string;
  onPractise: (exercises: Exercise[]) => void;
}

interface Row {
  stored: StoredGame;
  game: ImportedGame;
  analysis: GameAnalysis | null;
}

function toRow(s: StoredGame): Row | null {
  const g = s.game as ImportedGame | undefined;
  if (!g || !Array.isArray(g.moves) || typeof g.id !== 'string') return null;
  const a = s.analysis as GameAnalysis | undefined;
  return { stored: s, game: g, analysis: a && Array.isArray(a.moves) && Array.isArray(a.mistakes) ? a : null };
}

const fmtEval = (cp: number): string => {
  if (cp >= MATE_CAP) return 'mate';
  if (cp <= -MATE_CAP) return 'mated';
  return `${cp > 0 ? '+' : ''}${(cp / 100).toFixed(1)}`;
};
const fmtSecs = (ms: number | null): string => (ms === null ? '-' : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`);
const pct = (x: number | null): string => (x === null ? '-' : `${Math.round(x * 100)}%`);
const moveLabel = (ply: number): string => `${Math.ceil(ply / 2)}${ply % 2 === 1 ? '.' : '...'}`;

function gameTitle(g: ImportedGame): string {
  const date = g.playedAt ? new Date(g.playedAt).toISOString().slice(0, 10) : '';
  return `${g.white}${g.whiteElo ? ` (${g.whiteElo})` : ''} - ${g.black}${g.blackElo ? ` (${g.blackElo})` : ''} ${g.result}${date ? `, ${date}` : ''}`;
}

/** Inline SVG eval graph (white's POV, clamped to +-10 pawns) with mistake markers. */
function EvalGraph(props: { analysis: GameAnalysis; selected: number | null; onSelect: (ply: number) => void }): ReactElement {
  const { analysis } = props;
  const W = 600;
  const H = 120;
  const n = Math.max(1, analysis.graph.length - 1);
  const clamp = (v: number): number => Math.max(-1000, Math.min(1000, v));
  const x = (i: number): number => (i / n) * W;
  const y = (v: number): number => H / 2 - (clamp(v) / 1000) * (H / 2 - 4);
  const pts: string[] = [];
  analysis.graph.forEach((v, i) => {
    if (v !== null) pts.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  });
  return (
    <svg className="eval-graph" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Evaluation graph from White's point of view" data-testid="review-eval-graph" preserveAspectRatio="none">
      <rect x={0} y={0} width={W} height={H / 2} className="eval-white-zone" fill="#f2f2f2" />
      <rect x={0} y={H / 2} width={W} height={H / 2} className="eval-black-zone" fill="#d9d9d9" />
      <line x1={0} x2={W} y1={H / 2} y2={H / 2} stroke="#888" strokeWidth={1} />
      <polyline points={pts.join(' ')} fill="none" stroke="#1f2933" strokeWidth={2} />
      {analysis.mistakes.map((m) => {
        const v = analysis.graph[m.ply];
        if (v === null || v === undefined) return null;
        return (
          <circle
            key={m.ply}
            cx={x(m.ply)}
            cy={y(v)}
            r={props.selected === m.ply ? 7 : 5}
            fill={m.unclassified ? '#888' : '#c0392b'}
            onClick={() => props.onSelect(m.ply)}
            style={{ cursor: 'pointer' }}
          >
            <title>{`${moveLabel(m.ply)} ${m.playedSan}: -${(m.cpLoss / 100).toFixed(1)}`}</title>
          </circle>
        );
      })}
    </svg>
  );
}

function MistakeDetail(props: { row: Row; mistake: Mistake; theme: BoardTheme }): ReactElement {
  const { row, mistake: m } = props;
  const cause = inferCause(m, timeInfoFor(row.game, m.ply));
  return (
    <div className="mistake-detail" data-testid="review-mistake-detail">
      <Board
        fen={m.fen}
        orientation={m.color === 'w' ? 'white' : 'black'}
        interactive={false}
        theme={props.theme}
        arrows={[
          { from: m.played.slice(0, 2), to: m.played.slice(2, 4), color: 'rgba(192, 57, 43, 0.8)' },
          { from: m.best.slice(0, 2), to: m.best.slice(2, 4), color: 'rgba(39, 174, 96, 0.8)' },
        ]}
      />
      <ul className="facts">
        <li>
          You played <strong>{moveLabel(m.ply)} {m.playedSan}</strong> ({fmtEval(m.evalBeforeCp)} to {fmtEval(m.evalAfterCp)} for you).
        </li>
        <li>
          Engine (depth {m.bestLine.depth}) preferred <strong>{m.bestSan}</strong>
          {m.bestPvSan.length > 1 && <> - line: {m.bestPvSan.slice(0, 6).join(' ')}</>}
        </li>
        {m.refutationPvSan.length > 0 && <li>After your move the engine expects: {m.refutationPvSan.slice(0, 6).join(' ')}</li>}
        {m.motifs.length === 0 && <li className="muted">Unclassified: none of the pattern detectors matched this mistake.</li>}
        {m.motifs.map((mo, i) => (
          <li key={i}>
            {mo.conceptId.startsWith('tactics/') ? '' : 'Heuristic: '}
            {conceptName(mo.conceptId)} ({mo.kind === 'missed' ? 'you missed it' : 'your move allowed it'}): {mo.detail}
          </li>
        ))}
        <li>
          Time spent: {fmtSecs(m.timeSpentMs)}
          {cause && <> - likely cause (heuristic from clock and motif): {cause}</>}
        </li>
      </ul>
    </div>
  );
}

export default function Review(props: ReviewProps): ReactElement {
  const { theme, username, onPractise } = props;
  const [rows, setRows] = useState<Row[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedPly, setSelectedPly] = useState<number | null>(null);
  const [lichessName, setLichessName] = useState(username ?? '');
  const [chesscomName, setChesscomName] = useState(username ?? '');
  const [pgnText, setPgnText] = useState('');
  const [status, setStatus] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ gameId: string; done: number; total: number } | null>(null);
  const [partial, setPartial] = useState<GameAnalysis | null>(null);
  const queueRef = useRef<AnalysisQueue | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const all = await getDb().games.orderBy('importedAt').reverse().toArray();
      setRows(all.map(toRow).filter((r): r is Row => r !== null));
    } catch {
      setStatus({ kind: 'error', text: 'Could not open local storage (IndexedDB). Private browsing can block it.' });
    }
  }, []);

  useEffect(() => {
    void reload();
    return () => queueRef.current?.cancel();
  }, [reload]);

  const store = async (games: ImportedGame[]): Promise<number> => {
    const db = getDb();
    const existing = await db.games.bulkGet(games.map((g) => g.id));
    const now = Date.now();
    const fresh: StoredGame[] = [];
    games.forEach((g, i) => {
      if (!existing[i]) fresh.push({ id: g.id, source: g.source, importedAt: now - i, game: g });
    });
    if (fresh.length) await db.games.bulkPut(fresh);
    await reload();
    return fresh.length;
  };

  const finishImport = async (label: string, r: ImportResult): Promise<void> => {
    if (r.status !== 'ok') {
      setStatus({ kind: 'error', text: r.message });
      return;
    }
    const added = await store(r.games);
    const skipped = r.errors.length ? ` ${r.errors.length} could not be read (${r.errors[0]!.message}${r.errors.length > 1 ? ', ...' : ''}).` : '';
    setStatus({ kind: 'info', text: `${label}: ${r.games.length} games read, ${added} new.${skipped}` });
  };

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setStatus(null);
    try {
      await fn();
    } catch (e) {
      setStatus({ kind: 'error', text: `Import failed: ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  const importLichess = (): Promise<void> => run(async () => finishImport('Lichess', await fetchLichessGames(lichessName, { max: 50 })));
  const importChessCom = (): Promise<void> =>
    run(async () => {
      const r = await fetchChessComGames(chesscomName, { max: 50 });
      await finishImport('Chess.com', r);
    });
  const importPgn = (text: string): Promise<void> =>
    run(async () => {
      const { games, errors } = parsePgn(text, { username: username ?? (lichessName || chesscomName || undefined) });
      if (games.length === 0) {
        setStatus({ kind: 'error', text: errors[0] ? `No games imported: ${errors[0].message}` : 'No games found in the PGN.' });
        return;
      }
      await finishImport('PGN', { status: 'ok', games, errors });
      setPgnText('');
    });

  const selected = rows.find((r) => r.stored.id === selectedId) ?? null;
  const shownAnalysis = selected ? (progress?.gameId === selected.stored.id && partial ? partial : selected.analysis) : null;

  const analyse = async (targets: Row[]): Promise<void> => {
    if (targets.length === 0 || queueRef.current?.running) return;
    const q = new AnalysisQueue(getEngine(), { depth: 12, now: () => Date.now() });
    queueRef.current = q;
    setStatus(null);
    await q.run(
      targets.map((r) => r.game),
      {
        onGameStart: (g) => {
          setProgress({ gameId: g.id, done: 0, total: 1 });
          setPartial(null);
        },
        onProgress: (g, p) => {
          setProgress({ gameId: g.id, done: p.done, total: p.total });
          setPartial(p.partial);
        },
        onGameDone: async (g, a) => {
          await getDb().games.update(g.id, { analysis: a });
          await reload();
        },
        onError: (g, e) => setStatus({ kind: 'error', text: `Analysis of ${g.white} - ${g.black} failed: ${e.message}` }),
      },
    );
    setProgress(null);
    setPartial(null);
    queueRef.current = null;
  };

  const analysed = useMemo(() => rows.filter((r) => r.analysis).map((r) => ({ game: r.game, analysis: r.analysis! })), [rows]);
  const report = useMemo(() => (analysed.length ? timeReport(analysed) : null), [analysed]);
  const diag = useMemo(() => (analysed.length ? diagnose(analysed) : null), [analysed]);
  const exercises = useMemo(() => {
    const out: Exercise[] = [];
    for (const { game, analysis } of analysed) {
      for (const m of analysis.mistakes) {
        if (game.userColor !== null && m.color !== game.userColor) continue;
        const ex = buildSpotMistake(game, m);
        if (ex) out.push(ex);
      }
    }
    return out;
  }, [analysed]);

  const selMistake = shownAnalysis?.mistakes.find((m) => m.ply === selectedPly) ?? null;

  return (
    <section className="review" aria-labelledby="review-title">
      <h2 id="review-title">Review your games</h2>

      <div className="import-panel">
        <form
          className="import-row"
          onSubmit={(e) => {
            e.preventDefault();
            void importLichess();
          }}
        >
          <label htmlFor="review-lichess">Lichess username</label>
          <input id="review-lichess" data-testid="review-lichess-input" value={lichessName} onChange={(e) => setLichessName(e.target.value)} autoComplete="off" />
          <button type="submit" disabled={busy || !lichessName.trim()} data-testid="review-import-lichess">
            Import last 50 games
          </button>
        </form>
        <form
          className="import-row"
          onSubmit={(e) => {
            e.preventDefault();
            void importChessCom();
          }}
        >
          <label htmlFor="review-chesscom">Chess.com username</label>
          <input id="review-chesscom" data-testid="review-chesscom-input" value={chesscomName} onChange={(e) => setChesscomName(e.target.value)} autoComplete="off" />
          <button type="submit" disabled={busy || !chesscomName.trim()} data-testid="review-import-chesscom">
            Import last 50 games
          </button>
        </form>
        <div className="import-row pgn">
          <label htmlFor="review-pgn">Paste PGN</label>
          <textarea id="review-pgn" data-testid="review-pgn-input" rows={5} value={pgnText} onChange={(e) => setPgnText(e.target.value)} spellCheck={false} />
          <div className="actions">
            <button type="button" disabled={busy || !pgnText.trim()} onClick={() => void importPgn(pgnText)} data-testid="review-import-pgn">
              Import PGN
            </button>
            <label className="file">
              or upload a .pgn file{' '}
              <input
                type="file"
                accept=".pgn,text/plain,application/x-chess-pgn"
                data-testid="review-pgn-file"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void f.text().then((t) => importPgn(t));
                  e.target.value = '';
                }}
              />
            </label>
          </div>
        </div>
        <p className="muted small">Imports go straight from your browser to Lichess / Chess.com; games are stored only on this device.</p>
        {status && (
          <p role={status.kind === 'error' ? 'alert' : 'status'} className={status.kind === 'error' ? 'error' : 'info'} data-testid="review-status">
            {status.text}
          </p>
        )}
      </div>

      {rows.length > 0 && (
        <div className="review-body">
          <div className="game-list">
            <div className="list-actions">
              <button
                type="button"
                disabled={!!progress || rows.every((r) => r.analysis)}
                onClick={() => void analyse(rows.filter((r) => !r.analysis))}
                data-testid="review-analyse-all"
              >
                Analyse all new games
              </button>
              {progress && (
                <button type="button" onClick={() => queueRef.current?.cancel()} data-testid="review-cancel">
                  Stop
                </button>
              )}
            </div>
            <ul>
              {rows.map((r) => (
                <li key={r.stored.id}>
                  <button
                    type="button"
                    className={r.stored.id === selectedId ? 'selected' : ''}
                    aria-pressed={r.stored.id === selectedId}
                    onClick={() => {
                      setSelectedId(r.stored.id);
                      setSelectedPly(null);
                    }}
                    data-testid={`review-game-${r.stored.id}`}
                  >
                    {gameTitle(r.game)}
                    <span className="muted">
                      {' '}
                      {r.analysis ? `${r.analysis.mistakes.length} mistakes` : progress?.gameId === r.stored.id ? 'analysing...' : 'not analysed'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          {selected && (
            <div className="game-review" data-testid="review-game-panel">
              <h3>{gameTitle(selected.game)}</h3>
              <p className="muted">
                {selected.game.opening?.name ?? ''} {selected.game.speed ? `- ${selected.game.speed}` : ''}{' '}
                {selected.game.url && (
                  <a href={selected.game.url} target="_blank" rel="noreferrer">
                    open original
                  </a>
                )}
                {selected.game.userColor === null && ' - your colour is unknown, so both sides are analysed'}
              </p>
              <button type="button" className="primary" disabled={!!progress} onClick={() => void analyse([selected])} data-testid="review-analyse">
                {selected.analysis ? 'Re-analyse' : 'Analyse'} (engine depth 12)
              </button>
              {progress?.gameId === selected.stored.id && (
                <div className="progress">
                  <progress value={progress.done} max={Math.max(1, progress.total)} data-testid="review-progress" />
                  <span>
                    {progress.done} / {progress.total} moves
                  </span>
                </div>
              )}

              {shownAnalysis && (
                <>
                  <EvalGraph analysis={shownAnalysis} selected={selectedPly} onSelect={setSelectedPly} />
                  <p className="coverage" data-testid="review-coverage">
                    Detectors classified {shownAnalysis.coverage.classified} of {shownAnalysis.coverage.mistakes} mistakes; the rest are shown as unclassified.
                    {shownAnalysis.evalSources.embedded > 0 && ` ${shownAnalysis.evalSources.embedded} evaluations came from the game file's server analysis.`}
                  </p>
                  {shownAnalysis.mistakes.length === 0 && <p>No mistakes (150+ centipawns lost) found{progress ? ' so far' : ''}.</p>}
                  <ol className="mistake-list">
                    {shownAnalysis.mistakes.map((m) => (
                      <li key={m.ply}>
                        <button
                          type="button"
                          className={m.ply === selectedPly ? 'selected' : ''}
                          aria-pressed={m.ply === selectedPly}
                          onClick={() => setSelectedPly(m.ply)}
                          data-testid={`review-mistake-${m.ply}`}
                        >
                          {moveLabel(m.ply)} {m.playedSan} (-{(m.cpLoss / 100).toFixed(1)}) best {m.bestSan} -{' '}
                          {m.primary ? `${conceptName(m.primary.conceptId)} (${m.primary.kind})` : 'unclassified'}
                        </button>
                      </li>
                    ))}
                  </ol>
                  {selMistake && <MistakeDetail row={selected} mistake={selMistake} theme={theme} />}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {report && diag && (
        <div className="review-summary" data-testid="review-summary">
          <h3>Across {report.games} analysed games</h3>
          <p data-testid="review-coverage-all">
            Detectors classified {diag.coverage.classified} of {diag.coverage.mistakes} mistakes; the rest are shown as unclassified.
          </p>
          {report.gamesWithClocks > 0 ? (
            <div className="time-report" data-testid="review-time-report">
              <h4>Time use</h4>
              <ul>
                <li>Median time per move: {fmtSecs(report.medianSpentMs)}</li>
                <li>Mistakes played instantly (under 3 s or 2% of the base time): {report.instantMistakes.length}</li>
                <li>
                  In time trouble (under 10% of base left) you made {pct(report.timeTrouble.shareOfMoves)} of your moves and {pct(report.timeTrouble.shareOfMistakes)} of your
                  mistakes.
                </li>
                <li>Long thinks on moves that lost under 0.3 pawns (heuristic, may include critical positions): {report.longThinksOnEasyMoves.length}</li>
              </ul>
              <table className="speed-accuracy">
                <caption>Mistake rate by time spent</caption>
                <thead>
                  <tr>
                    <th scope="col">Time spent</th>
                    <th scope="col">Moves</th>
                    <th scope="col">Mistake rate</th>
                  </tr>
                </thead>
                <tbody>
                  {report.speedAccuracy.map((b) => (
                    <tr key={b.label}>
                      <td>{b.label}</td>
                      <td>{b.moves}</td>
                      <td>{pct(b.rate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">These games have no clock data, so there is no time report.</p>
          )}
          <p className="muted small">
            Likely causes (heuristic from clocks and motifs): {(['vision', 'calculation', 'knowledge', 'time', 'discipline', 'unknown'] as const)
              .filter((c) => diag.causes[c] > 0)
              .map((c) => `${c} ${diag.causes[c]}`)
              .join(', ') || 'none'}
          </p>
          <button type="button" className="primary" disabled={exercises.length === 0} onClick={() => onPractise(exercises)} data-testid="review-practise">
            Practise these mistakes ({exercises.length})
          </button>
          {exercises.length === 0 && diag.coverage.mistakes > 0 && <p className="muted small">Only classified mistakes become exercises.</p>}
        </div>
      )}
    </section>
  );
}
