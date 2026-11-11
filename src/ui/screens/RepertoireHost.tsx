/** Repertoire builder: pick openings per colour (rating-appropriate defaults from the book), preview lines, book exits in your games. */
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { Chess } from 'chess.js';
import { useApp } from '../store';
import { getOpenings } from '../../content/registry';
import { listOpeningsForColor, findBookExit, suggestDefaults, withLine, type OpeningOption } from '../../content/repertoire';
import type { OpeningsState } from '../../content/providers/openings';
import { getDb, saveKv } from '../../model/db';
import { sanLine, tryMove } from '../../engine/chessUtil';
import { Board } from '../Board';
import { recallNow } from '../../model/fsrs';
import type { ImportedGame } from '../../importers/types';
import type { GameAnalysis } from '../../diagnosis/types';

interface ExitRow {
  id: string;
  label: string;
  ply: number;
  by: string;
  played: string;
  expected: string;
  evalChange: number | null;
}

export default function RepertoireHost(): ReactElement {
  const { learner, settings } = useApp();
  const [st, setSt] = useState<OpeningsState | null>(null);
  const [color, setColor] = useState<'w' | 'b'>(settings.openingColor === 'black' ? 'b' : 'w');
  const [filter, setFilter] = useState('');
  const [preview, setPreview] = useState<string[]>([]);
  const [step, setStep] = useState(0);
  const [exits, setExits] = useState<ExitRow[] | null>(null);
  const [, force] = useState(0);

  useEffect(() => {
    void getOpenings()
      .load(learner.nodes.global!.theta)
      .then((s) => setSt({ ...s }));
  }, [learner]);

  const options: OpeningOption[] = useMemo(() => {
    if (!st?.names || !st.book || !st.band) return [];
    return listOpeningsForColor(st.names, st.book, st.band, color, 50).sort((a, b) => b.games - a.games);
  }, [st, color]);

  const save = async (): Promise<void> => {
    const s = getOpenings().state();
    await saveKv('repertoire', { w: s.repertoires.w, b: s.repertoires.b });
    setSt({ ...s });
    force((n) => n + 1);
  };

  useEffect(() => {
    if (!st?.book || !st.band) return;
    void (async () => {
      const games = await getDb().games.toArray().catch(() => []);
      const rows: ExitRow[] = [];
      for (const g of games) {
        const game = g.game as ImportedGame;
        if (!game?.moves || !game.userColor) continue;
        const rep = getOpenings().state().repertoires[game.userColor] ?? undefined;
        const exit = findBookExit(
          game.moves.map((m) => m.uci),
          st.book!,
          st.band!,
          rep,
          game.userColor,
        );
        if (!exit) continue;
        const a = g.analysis as GameAnalysis | undefined;
        const pe = a?.moves.find((m) => m.ply === exit.ply + 1);
        rows.push({
          id: g.id,
          label: `${game.white} – ${game.black}`,
          ply: exit.ply + 1,
          by: exit.by === 'user' ? 'you' : 'opponent',
          played: game.moves[exit.ply]?.san ?? exit.played,
          expected: exit.expected ? sanLine(game.moves[exit.ply]?.fenBefore ?? '', exit.expected.slice(0, 1)).join(', ') || exit.expected[0]! : '—',
          evalChange: pe ? pe.evalAfterCp - pe.evalBeforeCp : null,
        });
      }
      setExits(rows);
    })();
  }, [st]);

  if (!st) return <p className="loading">Loading the opening book…</p>;
  if (!st.book || !st.names || !st.band) return <p role="alert">The openings pack is not available.</p>;
  const rep = st.repertoires[color];
  const tree = st.trees[color];
  const due = tree.filter((n) => {
    const m = learner.memory[`op:${color}:${n.epd}`];
    return m && recallNow(m, Date.now()) <= settings.retention;
  }).length;
  const learned = tree.filter((n) => learner.memory[`op:${color}:${n.epd}`]).length;

  const fenAt = (line: string[], k: number): string => {
    const c = new Chess();
    for (const m of line.slice(0, k)) tryMove(c, m);
    return c.fen();
  };

  return (
    <section className="repertoire" data-testid="repertoire">
      <h1>Repertoire builder</h1>
      <p>
        Book: {st.book.games(st.band).toLocaleString('en')} Lichess games in the {st.band} rating band (local, no account needed). Choices default to the best-scoring popular move in each position;
        override them by picking an opening below.
      </p>
      <div className="row" role="radiogroup" aria-label="Colour">
        {(['w', 'b'] as const).map((c) => (
          <button key={c} role="radio" aria-checked={color === c} className={color === c ? 'selected' : ''} onClick={() => setColor(c)} data-testid={`rep-color-${c}`}>
            As {c === 'w' ? 'White' : 'Black'}
          </button>
        ))}
        <button
          onClick={() => {
            getOpenings().setRepertoire(color, suggestDefaults(st.book!, st.names!, st.band!, color));
            void save();
          }}
        >
          Reset to data-driven defaults
        </button>
      </div>
      <p data-testid="rep-summary">
        {tree.length} positions to know as {color === 'w' ? 'White' : 'Black'} (each is one spaced-repetition card) · {learned} studied · {due} due for review
        {rep?.name ? ` · built around: ${rep.name}` : ''}
      </p>
      <div className="grid2">
        <div className="pane">
          <h2>Choose an opening</h2>
          <input aria-label="Filter openings" placeholder="Filter, e.g. Sicilian" value={filter} onChange={(e) => setFilter(e.target.value)} data-testid="rep-filter" />
          <ul className="game-list">
            {options
              .filter((o) => !filter || o.family.toLowerCase().includes(filter.toLowerCase()) || o.name.toLowerCase().includes(filter.toLowerCase()))
              .slice(0, 40)
              .map((o) => (
                <li key={o.family}>
                  <button
                    data-testid={`rep-option-${o.family.replace(/\W+/g, '-')}`}
                    onClick={() => {
                      const base = getOpenings().state().repertoires[color] ?? suggestDefaults(st.book!, st.names!, st.band!, color);
                      getOpenings().setRepertoire(color, { ...withLine(base, o.line), name: o.family });
                      setPreview(o.line);
                      setStep(o.line.length);
                      void save();
                    }}
                  >
                    <strong>{o.family}</strong>&nbsp;<span className="muted small">
                      {o.eco} · {o.games.toLocaleString('en')} games · scores {o.scorePct}% for {color === 'w' ? 'White' : 'Black'} · {o.variations} named lines
                    </span>
                  </button>
                </li>
              ))}
          </ul>
        </div>
        <div className="pane">
          <h2>Your lines</h2>
          {preview.length > 0 && (
            <div>
              <Board fen={fenAt(preview, step)} orientation={color === 'w' ? 'white' : 'black'} interactive={false} theme={settings.boardTheme} />
              <div className="row">
                <button onClick={() => setStep((s) => Math.max(0, s - 1))} aria-label="Previous move">◀</button>
                <span>{sanLine(new Chess().fen(), preview.slice(0, step)).join(' ')}</span>
                <button onClick={() => setStep((s) => Math.min(preview.length, s + 1))} aria-label="Next move">▶</button>
              </div>
            </div>
          )}
          <ol className="small">
            {tree.slice(0, 30).map((n) => (
              <li key={n.epd}>
                {sanLine(new Chess().fen(), [...n.line, n.userMove]).join(' ')} <span className="muted">({n.openingName || 'unnamed'}; reached in {Math.round(n.opponentFreqProduct * 100)}% of games)</span>
              </li>
            ))}
          </ol>
          {tree.length > 30 && <p className="muted">…and {tree.length - 30} more.</p>}
        </div>
      </div>
      <h2>Where your games left the book</h2>
      {exits === null ? (
        <p className="muted">Checking imported games…</p>
      ) : exits.length === 0 ? (
        <p className="muted">Import games on the Game review screen to see where they leave your repertoire or the book.</p>
      ) : (
        <table data-testid="book-exits">
          <thead>
            <tr>
              <th>Game</th>
              <th>Move</th>
              <th>Left by</th>
              <th>Played</th>
              <th>Book / repertoire</th>
              <th>Eval change (mover)</th>
            </tr>
          </thead>
          <tbody>
            {exits.map((e) => (
              <tr key={e.id}>
                <td>{e.label}</td>
                <td>{Math.ceil(e.ply / 2)}</td>
                <td>{e.by}</td>
                <td>{e.played}</td>
                <td>{e.expected}</td>
                <td>{e.evalChange === null ? 'not analysed' : `${e.evalChange >= 0 ? '+' : ''}${(e.evalChange / 100).toFixed(2)}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
