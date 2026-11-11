/** Renders any Exercise interaction, grades it, and reports an ExerciseResult. */
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Chess } from 'chess.js';
import type { ChoiceInteraction, ErrorCause, Exercise, ExerciseResult, LineInteraction, PlayoutInteraction, SetInteraction } from '../exercises/types';
import { ERROR_CAUSES } from '../exercises/types';
import { gradeChoice, gradeSet, lineMoveOk, lineScore, lineStart, userPlies } from '../exercises/grade';
import { explainExercise } from '../exercises/explain';
import { parseUci, tryMove } from '../engine/chessUtil';
import type { Settings } from '../model/settings';
import { Board } from './Board';
import { createTablebase, pickDefence, type Tablebase } from '../engine/tablebase';
import { tableCache } from '../model/db';
import { getEngine, scoreCp } from '../engine/stockfish';
import { mulberry32 } from '../model/math';
import type { LlmResult } from '../exercises/llmExplain';
import { pickHumanMove } from '../engine/humanlike';

export interface ExerciseViewProps {
  exercise: Exercise;
  settings: Settings;
  why?: string;
  onDone(result: ExerciseResult): void;
  onNext?(cause?: ErrorCause): void;
  nextLabel?: string;
}

const CAUSE_LABEL: Record<ErrorCause, string> = {
  knowledge: "Didn't know the idea",
  vision: "Didn't see it",
  calculation: 'Miscalculated',
  time: 'Time pressure',
  discipline: 'Rushed / no blunder check',
};

let tb: Tablebase | null = null;
const tablebase = (): Tablebase => (tb ??= createTablebase({ cache: tableCache('tablebase') }));

export function ExerciseView(props: ExerciseViewProps): ReactElement {
  const { exercise: ex, settings, why } = props;
  const needsConfidence = settings.askConfidence && ex.format !== 'lesson' && ex.interaction.kind !== 'card';
  const [confidence, setConfidence] = useState<number | undefined>(undefined);
  const [result, setResult] = useState<ExerciseResult | null>(null);
  const [revealed, setRevealed] = useState(settings.explanationStyle !== 'socratic');
  const [cause, setCause] = useState<ErrorCause | undefined>(undefined);
  const started = useRef(Date.now());

  useEffect(() => {
    started.current = Date.now();
    setConfidence(undefined);
    setResult(null);
    setRevealed(settings.explanationStyle !== 'socratic');
    setCause(undefined);
  }, [ex.id, settings.explanationStyle]);

  const finish = (r: Omit<ExerciseResult, 'exerciseId' | 'timeMs' | 'confidence'> & { detail?: ExerciseResult['detail'] }): void => {
    if (result) return;
    let full: ExerciseResult = { ...r, exerciseId: ex.id, timeMs: Date.now() - started.current, confidence };
    // Timed drills: a solve over the budget counts as a miss (half credit), and the cause is time.
    if (ex.format === 'timed-drill' && ex.timeBudgetSec && full.solved && full.timeMs > ex.timeBudgetSec * 1000) {
      full = { ...full, solved: false, score: full.score * 0.5, detail: { ...full.detail, overBudgetMs: full.timeMs - ex.timeBudgetSec * 1000 } };
    }
    setResult(full);
    if (!full.solved) {
      const budget = (ex.timeBudgetSec ?? 60) * 1000;
      // Inferred from the clock: a fast miss suggests skipping the blunder check. The user can override.
      setCause(ex.format === 'timed-drill' && full.detail?.overBudgetMs ? 'time' : full.timeMs < budget * 0.15 ? 'discipline' : undefined);
    }
    props.onDone(full);
  };

  const locked = needsConfidence && confidence === undefined;
  const explanation = useMemo(() => explainExercise(ex, settings.explanationStyle, settings.depth), [ex, settings.explanationStyle, settings.depth]);

  return (
    <section className="exercise" aria-labelledby="ex-prompt" data-testid="exercise" data-format={ex.format} data-concept={ex.conceptId}>
      {why && (
        <p className="why" data-testid="why">
          <strong>Why this exercise:</strong> {why}
        </p>
      )}
      <h2 id="ex-prompt" data-testid="prompt">
        {ex.prompt}
      </h2>
      {ex.format === 'timed-drill' && ex.timeBudgetSec && !result && !locked && <Countdown seconds={ex.timeBudgetSec} startedAt={started.current} />}
      {locked && (
        <div className="confidence" role="group" aria-label="How confident are you?">
          <span>Before you start: how confident are you that you will solve it?</span>
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} onClick={() => setConfidence(n)} data-testid={`confidence-${n}`} aria-label={`Confidence ${n} of 5`}>
              {n}
            </button>
          ))}
        </div>
      )}
      <div className={locked ? 'dimmed' : ''} aria-hidden={locked}>
        {ex.interaction.kind === 'line' && <LineView key={ex.id} it={ex.interaction} ex={ex} settings={settings} disabled={locked || !!result} onFinish={finish} />}
        {ex.interaction.kind === 'choice' && <ChoiceView key={ex.id} it={ex.interaction} settings={settings} disabled={locked || !!result} onFinish={finish} />}
        {ex.interaction.kind === 'set' && <SetView key={ex.id} it={ex.interaction} settings={settings} disabled={locked || !!result} onFinish={finish} />}
        {ex.interaction.kind === 'playout' && <PlayoutView key={ex.id} it={ex.interaction} settings={settings} disabled={locked || !!result} onFinish={finish} />}
        {ex.interaction.kind === 'card' && (
          <div className="card-view">
            {ex.interaction.fen && <Board fen={cardFen(ex.interaction.fen, ex.interaction.preMoves)} orientation={ex.interaction.orientation ?? 'white'} interactive={false} theme={settings.boardTheme} highlight={ex.interaction.highlight} />}
            <div className="card-body">
              <h3>{ex.interaction.title}</h3>
              {ex.interaction.body.map((p, i) => (
                <p key={i}>{p}</p>
              ))}
              {!result && (
                <button className="primary" data-testid="card-continue" onClick={() => finish({ score: 1, solved: true, hintsUsed: 0 })}>
                  Got it
                </button>
              )}
            </div>
          </div>
        )}
      </div>
      {result && ex.interaction.kind !== 'card' && (
        <div className={`feedback ${result.solved ? 'ok' : 'bad'}`} role="status" data-testid="feedback">
          <p className="verdict" data-testid="verdict">
            {result.solved ? (result.hintsUsed > 0 ? 'Solved with a hint.' : 'Correct!') : 'Not this time.'}
          </p>
          {!revealed ? (
            <div className="socratic">
              <p>{explanation.question}</p>
              <button onClick={() => setRevealed(true)} data-testid="reveal">
                Reveal explanation
              </button>
            </div>
          ) : (
            <ul className="explanation" data-testid="explanation">
              {explanation.lines.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          )}
          {revealed && settings.llmExplanations && settings.anthropicKey && <AiExplanation ex={ex} apiKey={settings.anthropicKey} />}
          {!result.solved && (
            <div className="causes" role="group" aria-label="What went wrong?">
              <span>What went wrong?</span>
              {ERROR_CAUSES.map((c) => (
                <button key={c} aria-pressed={cause === c} className={cause === c ? 'selected' : ''} onClick={() => setCause(c)} data-testid={`cause-${c}`}>
                  {CAUSE_LABEL[c]}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {result && props.onNext && (
        <button className="primary next" data-testid="next" onClick={() => props.onNext?.(result.solved ? undefined : cause)} autoFocus>
          {props.nextLabel ?? 'Next'}
        </button>
      )}
    </section>
  );
}

function AiExplanation({ ex, apiKey }: { ex: Exercise; apiKey: string }): ReactElement {
  const [state, setState] = useState<LlmResult | 'loading' | null>(null);
  if (state === null)
    return (
      <button
        onClick={() => {
          setState('loading');
          void import('../exercises/llmExplain').then((m) => m.explainWithLlm(ex, apiKey)).then(setState);
        }}
      >
        AI explanation (uses your API key)
      </button>
    );
  if (state === 'loading') return <p className="muted">Asking Claude…</p>;
  if (state.status === 'ok') return <p className="ai-explanation"><strong>AI explanation (from verified facts only):</strong> {state.text}</p>;
  if (state.status === 'rejected') return <p className="muted">The AI explanation was discarded: it mentioned {state.unsupported.join(', ')}, which the verified facts do not contain.</p>;
  if (state.status === 'refused') return <p className="muted">The model declined to answer this one.</p>;
  return <p className="error">{state.message}</p>;
}

function Countdown({ seconds, startedAt }: { seconds: number; startedAt: number }): ReactElement {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, seconds - (now - startedAt) / 1000);
  return (
    <p className={left === 0 ? 'error' : 'muted'} role="timer" aria-live="off" data-testid="countdown">
      {left > 0 ? `${Math.ceil(left)} s left` : 'Time is up: you can still finish, but it counts as a miss.'}
    </p>
  );
}

function cardFen(fen: string, pre?: string[]): string {
  if (!pre?.length) return fen;
  try {
    const c = new Chess(fen);
    for (const m of pre) tryMove(c, m);
    return c.fen();
  } catch {
    return fen;
  }
}

type FinishFn = (r: { score: number; solved: boolean; hintsUsed: number; detail?: ExerciseResult['detail'] }) => void;

/* ---------- forced lines ---------- */

function LineView({ it, ex, settings, disabled, onFinish }: { it: LineInteraction; ex: Exercise; settings: Settings; disabled: boolean; onFinish: FinishFn }): ReactElement {
  const startChess = useMemo(() => lineStart(it), [it]);
  const startFen = startChess?.fen() ?? it.fen;
  const [fen, setFen] = useState(it.preMoves.length > 0 && it.hide !== 'after-pre' ? it.fen : startFen);
  const [ply, setPly] = useState(0);
  const [hints, setHints] = useState(0);
  const [msg, setMsg] = useState('');
  const [lastMove, setLastMove] = useState<string[]>([]);
  const [failed, setFailed] = useState(false);
  const total = userPlies(it);
  const commit = (it.commitDepth ?? 0) > 0;
  const hidden = it.hide === 'pieces' || it.hide === 'after-pre';

  // Animate the opponent's first move.
  useEffect(() => {
    if (it.preMoves.length === 0 || it.hide === 'after-pre') return;
    const t = setTimeout(() => {
      setFen(startFen);
      const m = it.preMoves[it.preMoves.length - 1]!;
      setLastMove([m.slice(0, 2), m.slice(2, 4)]);
    }, 450);
    return () => clearTimeout(t);
  }, [it, startFen]);

  if (!startChess) return <p role="alert">This exercise has an invalid position and was skipped.</p>;
  const ready = fen === startFen || ply > 0;

  const onMove = (uci: string): boolean => {
    if (disabled || failed || !ready) return false;
    const before = fen;
    const chess = new Chess(before);
    const mv = tryMove(chess, uci);
    if (!mv) return false;
    if (!lineMoveOk(it, ply, uci, before)) {
      setFen(chess.fen());
      setFailed(true);
      setMsg(commit ? `Your line diverged at move ${ply + 1}.` : `${mv.san} is not the solution.`);
      onFinish({ ...lineScore(total, ply, true, hints), hintsUsed: hints, detail: { reachedPly: ply } });
      return true;
    }
    const nextPly = ply + 1;
    // Mate or end of the solution: solved.
    if (chess.isCheckmate() || nextPly >= total) {
      setFen(chess.fen());
      setPly(nextPly);
      setMsg(commit ? 'Your whole line was correct.' : 'Correct.');
      onFinish({ ...lineScore(total, nextPly, false, hints), hintsUsed: hints });
      return true;
    }
    const reply = it.solution[ply * 2 + 1];
    setFen(chess.fen());
    setPly(nextPly);
    setMsg(commit ? `Move ${nextPly} entered.` : 'Good. Keep going.');
    if (reply) {
      setTimeout(() => {
        tryMove(chess, reply);
        setFen(chess.fen());
        setLastMove([reply.slice(0, 2), reply.slice(2, 4)]);
      }, commit ? 60 : 350);
    }
    return true;
  };

  const expected = it.solution[ply * 2];
  const hintSquares = hints > 0 && expected ? [expected.slice(0, 2), ...(hints > 1 ? [expected.slice(2, 4)] : [])] : [];
  const shownFen = it.hide === 'after-pre' && ply === 0 ? it.fen : fen;
  const side = new Chess(startFen).turn() === 'w' ? 'White' : 'Black';
  return (
    <div className="line-view">
      <Board
        fen={shownFen}
        orientation={it.orientation}
        onMove={onMove}
        interactive={!disabled && !failed && ready && !hidden}
        theme={settings.boardTheme}
        highlight={[...lastMove, ...hintSquares]}
        hidePieces={it.hide === 'pieces'}
      />
      {hidden && !disabled && !failed && (
        <TypedMoveEntry fen={fen} onMove={onMove} label={`Type ${side}'s move ${ply + 1} of ${total}`} />
      )}
      <div className="line-status" aria-live="polite">
        <span data-testid="line-progress">
          Move {Math.min(ply + 1, total)} of {total}
        </span>
        {msg && <span data-testid="line-msg"> — {msg}</span>}
      </div>
      {!disabled && !failed && settings.hintLevel > 0 && !commit && expected && (
        <button onClick={() => setHints((h) => Math.min(settings.hintLevel, h + 1))} disabled={hints >= settings.hintLevel} data-testid="hint">
          Hint ({settings.hintLevel - hints} left)
        </button>
      )}
      {!disabled && !failed && (
        <button
          className="link"
          data-testid="give-up"
          onClick={() => {
            setFailed(true);
            onFinish({ ...lineScore(total, ply, true, hints), hintsUsed: hints, detail: { gaveUp: 1 } });
          }}
        >
          Show solution
        </button>
      )}
      {ex.facts.length === 0 && <p className="muted">No explanation facts for this item.</p>}
    </div>
  );
}

function TypedMoveEntry({ fen, onMove, label }: { fen: string; onMove: (uci: string) => boolean; label: string }): ReactElement {
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  return (
    <form
      className="move-entry"
      onSubmit={(e) => {
        e.preventDefault();
        const c = new Chess(fen);
        let uci: string | null;
        try {
          const t = text.trim();
          const m = /^[a-h][1-8][a-h][1-8][qrbn]?$/i.test(t) ? c.move(parseUci(t.toLowerCase())) : c.move(t);
          uci = m.from + m.to + (m.promotion ?? '');
        } catch {
          uci = null;
        }
        if (!uci) {
          setErr('Not a legal move in the current position.');
          return;
        }
        setErr('');
        setText('');
        onMove(uci);
      }}
    >
      <label htmlFor="blind-input">{label}</label>
      <input id="blind-input" data-testid="blind-input" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" spellCheck={false} />
      <button type="submit">Enter</button>
      {err && <span role="alert" className="error">{err}</span>}
    </form>
  );
}

/* ---------- multiple choice ---------- */

function ChoiceView({ it, settings, disabled, onFinish }: { it: ChoiceInteraction; settings: Settings; disabled: boolean; onFinish: FinishFn }): ReactElement {
  const [chosen, setChosen] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  const fen = it.fen ? cardFen(it.fen, it.preMoves) : null;
  const submit = (ids: string[]): void => {
    setDone(true);
    const g = gradeChoice(it, ids);
    onFinish({ ...g, hintsUsed: 0 });
  };
  return (
    <div className="choice-view">
      {fen && <Board fen={fen} orientation={it.orientation ?? 'white'} interactive={false} theme={settings.boardTheme} highlight={it.highlight} />}
      <div className="options" role={it.multi ? 'group' : 'radiogroup'}>
        {it.options.map((o) => {
          const sel = chosen.includes(o.id);
          const cls = done ? (it.correct.includes(o.id) ? 'correct' : sel ? 'wrong' : '') : sel ? 'selected' : '';
          return (
            <button
              key={o.id}
              className={`option ${cls}`}
              data-testid={`option-${o.id}`}
              aria-pressed={sel}
              disabled={disabled || done}
              onClick={() => {
                if (it.multi) setChosen((c) => (c.includes(o.id) ? c.filter((x) => x !== o.id) : [...c, o.id]));
                else {
                  setChosen([o.id]);
                  submit([o.id]);
                }
              }}
            >
              {o.label}
            </button>
          );
        })}
      </div>
      {it.multi && !done && (
        <button className="primary" disabled={disabled} onClick={() => submit(chosen)} data-testid="submit-choice">
          Submit
        </button>
      )}
    </div>
  );
}

/* ---------- squares / move sets / paths ---------- */

function SetView({ it, settings, disabled, onFinish }: { it: SetInteraction; settings: Settings; disabled: boolean; onFinish: FinishFn }): ReactElement {
  const [entries, setEntries] = useState<string[]>(it.mode === 'path' && it.from ? [it.from] : []);
  const [done, setDone] = useState(false);
  const [missing, setMissing] = useState<string[]>([]);
  const fen = it.fen ?? '8/8/8/8/8/8/8/8 w - - 0 1';
  const submit = (list: string[]): void => {
    setDone(true);
    const g = gradeSet(it, list);
    setMissing(g.missing);
    onFinish({ score: g.score, solved: g.solved, hintsUsed: 0, detail: { wrong: g.wrong.length, missing: g.missing.length } });
  };
  const pathFen = it.mode === 'path' && it.from ? knightFen(entries[entries.length - 1] ?? it.from) : fen;
  return (
    <div className="set-view">
      <Board
        fen={it.mode === 'path' ? pathFen : fen}
        orientation={it.orientation ?? 'white'}
        interactive={!disabled && !done && it.mode === 'moves'}
        theme={settings.boardTheme}
        hideLabels={it.hide === 'board-labels'}
        hidePieces={it.hide === 'pieces'}
        highlight={done ? missing.filter((m) => m.length === 2) : it.mode === 'moves' ? [] : [...entries, ...(it.to ? [it.to] : [])]}
        onSquare={
          it.mode === 'moves' || disabled || done
            ? undefined
            : (sq) => {
                const next = [...entries, sq];
                setEntries(next);
                if (it.mode === 'squares' && next.length >= it.expected.length) submit(next);
                if (it.mode === 'path' && sq === it.to) submit(next);
              }
        }
        onMove={
          it.mode === 'moves'
            ? (uci) => {
                if (!entries.includes(uci)) setEntries((e) => [...e, uci]);
                return false; // the position never changes: each move is recorded, not played
              }
            : undefined
        }
        label={it.hide === 'board-labels' ? 'Board without coordinates. Click squares.' : undefined}
      />
      <p className="entries" data-testid="entries" aria-live="polite">
        {it.mode === 'moves' ? 'Your list: ' : 'Clicked: '}
        {entries.length ? entries.join(', ') : '—'}
      </p>
      {!done && (
        <div className="row">
          {it.mode === 'moves' && (
            <button className="primary" disabled={disabled} onClick={() => submit(entries)} data-testid="submit-set">
              Done
            </button>
          )}
          <button disabled={disabled} onClick={() => setEntries(it.mode === 'path' && it.from ? [it.from] : [])}>
            Clear
          </button>
        </div>
      )}
    </div>
  );
}

function knightFen(sq: string): string {
  const c = new Chess('8/8/8/8/8/8/8/8 w - - 0 1');
  c.clear();
  c.put({ type: 'n', color: 'w' }, sq as never);
  return c.fen();
}

/* ---------- play it out ---------- */

function PlayoutView({ it, settings, disabled, onFinish }: { it: PlayoutInteraction; settings: Settings; disabled: boolean; onFinish: FinishFn }): ReactElement {
  const [fen, setFen] = useState(it.fen);
  const [moves, setMoves] = useState(0);
  const [thinking, setThinking] = useState(false);
  const [msg, setMsg] = useState('');
  const [over, setOver] = useState(false);
  const rng = useMemo(() => mulberry32(it.fen.length * 131), [it.fen]);
  const userColor = new Chess(it.fen).turn();
  const target = it.objective.moves;

  const end = (solved: boolean, text: string, detail: ExerciseResult['detail'] = {}): void => {
    setOver(true);
    setMsg(text);
    onFinish({ score: solved ? 1 : 0, solved, hintsUsed: 0, detail: { moves, ...detail } });
  };

  const evalNow = async (f: string): Promise<number | null> => {
    try {
      const lines = await getEngine().analyse(f, { depth: 12 });
      const l = lines[0];
      if (!l) return null;
      const s = scoreCp(l);
      return new Chess(f).turn() === userColor ? s : -s;
    } catch {
      return null;
    }
  };

  const onMove = (uci: string): boolean => {
    if (disabled || over || thinking) return false;
    const chess = new Chess(fen);
    if (!tryMove(chess, uci)) return false;
    const used = moves + 1;
    setFen(chess.fen());
    setMoves(used);
    setThinking(true);
    void (async () => {
      try {
        if (chess.isCheckmate()) return end(true, `Checkmate in ${used} moves.`);
        if (chess.isDraw() || chess.isStalemate()) {
          return it.objective.type === 'draw' || it.objective.type === 'hold' ? end(true, 'The game ended in a draw: held.') : end(false, 'The game ended in a draw.');
        }
        let reply: string | null = null;
        if (it.opponent === 'tablebase') {
          const p = await tablebase().probe(chess.fen());
          if (p.status !== 'ok') return end(false, `Tablebase unavailable (${p.status}); this attempt is not graded.`, { ungraded: 1 });
          // After the user's move the opponent is to move: a "loss" for them keeps a win; anything else for a win objective failed.
          if (it.objective.type === 'mate-within' && p.category !== 'loss') return end(false, `That move let the win slip: the tablebase now says ${p.category === 'draw' ? 'draw' : 'the opponent wins'}.`);
          if (it.objective.type === 'draw' && p.category === 'win') return end(false, 'That move loses: the tablebase now says the opponent wins.');
          reply = pickDefence(p, rng)?.uci ?? null;
        } else {
          // Human-like opponent: rating-conditioned softmax over MultiPV; falls back to UCI_Elo play.
          const lines = await getEngine().analyse(chess.fen(), { depth: 10, multipv: 4 }).catch(() => []);
          reply = lines.length > 0 ? pickHumanMove(lines, it.opponentElo ?? 1500, rng) : await getEngine().play(chess.fen(), { elo: it.opponentElo ?? 1500, movetimeMs: 300 });
        }
        if (reply) {
          tryMove(chess, reply);
          setFen(chess.fen());
        }
        if (chess.isCheckmate()) return end(false, 'You were checkmated.');
        if (chess.isDraw() || chess.isStalemate()) {
          return it.objective.type === 'draw' || it.objective.type === 'hold' ? end(true, 'Draw: held.') : end(false, 'The game ended in a draw.');
        }
        if (used >= target) {
          const o = it.objective;
          if (o.type === 'mate-within') return end(false, `No mate within ${target} moves.`);
          if (o.type === 'draw') return end(true, `Held for ${target} moves with the draw intact.`);
          const cp = await evalNow(chess.fen());
          if (cp === null) return end(false, 'Engine unavailable; not graded.', { ungraded: 1 });
          if (o.type === 'convert') {
            const kept = cp / Math.max(1, o.startCp);
            return end(kept >= o.retainFraction, `Evaluation ${(cp / 100).toFixed(1)} vs ${(o.startCp / 100).toFixed(1)} at the start: ${Math.round(kept * 100)}% retained (target ${Math.round(o.retainFraction * 100)}%).`, { retention: Math.round(kept * 100) / 100, cp });
          }
          if (o.type === 'hold') {
            const lost = o.startCp - cp;
            return end(lost <= o.maxExtraLossCp, `Evaluation moved ${(lost / 100).toFixed(1)} pawns against you (allowed ${(o.maxExtraLossCp / 100).toFixed(1)}).`, { lostCp: lost, cp });
          }
          return end(cp >= o.minCp, `Goal: ${o.goal}. Final evaluation ${(cp / 100).toFixed(1)} (needed ${(o.minCp / 100).toFixed(1)}).`, { cp });
        }
        setMsg(`Move ${used} of ${target}.`);
      } finally {
        setThinking(false);
      }
    })();
    return true;
  };

  const goal =
    it.objective.type === 'mate-within'
      ? `Checkmate within ${target} moves.`
      : it.objective.type === 'draw'
        ? `Hold the draw for ${target} moves.`
        : it.objective.type === 'convert'
          ? `Keep at least ${Math.round(it.objective.retainFraction * 100)}% of your advantage over ${target} moves.`
          : it.objective.type === 'hold'
            ? `Lose no more than ${(it.objective.maxExtraLossCp / 100).toFixed(1)} pawns of evaluation over ${target} moves.`
            : `${it.objective.goal} (${target} moves).`;
  return (
    <div className="playout-view">
      <p className="goal" data-testid="goal">
        Objective: {goal} Opponent: {it.opponent === 'tablebase' ? 'perfect tablebase defence' : `Stockfish at about ${it.opponentElo ?? 1500} Elo`}.
      </p>
      <Board fen={fen} orientation={it.orientation} onMove={onMove} interactive={!disabled && !over && !thinking} theme={settings.boardTheme} />
      <p aria-live="polite" data-testid="playout-msg">
        {thinking ? 'Opponent is thinking…' : msg}
      </p>
      {!over && !disabled && (
        <button className="link" onClick={() => end(false, 'Resigned.')}>
          Give up
        </button>
      )}
    </div>
  );
}
