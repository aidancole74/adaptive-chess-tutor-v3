import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { useApp } from '../store';
import { getTactics } from '../../content/registry';
import { buildSolve } from '../../exercises/tactics';
import { newPlacement, nextPlacementItem, placementDone, placementRange, recordPlacement, PLACEMENT_ITEMS, type PlacementState } from '../../curriculum/placement';
import { mulberry32 } from '../../model/math';
import { ExerciseView } from '../ExerciseView';
import type { Route } from '../App';
import type { TacticItem } from '../../content/types';

export function Onboarding({ onDone, go }: { onDone(): void; go(r: Route): void }): ReactElement {
  const { settings, seed, recordStandalone } = useApp();
  const [mode, setMode] = useState<'choose' | 'placement' | 'result'>('choose');
  const [state, setState] = useState<PlacementState>(() => newPlacement());
  const [item, setItem] = useState<TacticItem | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const rng = useMemo(() => mulberry32(Date.now() >>> 0), []);

  const pickNext = (s: PlacementState): void => {
    const next = nextPlacementItem(s, getTactics().all(), rng);
    setItem(next);
    if (!next) setErr('No puzzles available: the tactics pack could not be loaded.');
  };

  useEffect(() => {
    if (mode === 'placement' && !item && !placementDone(state)) pickNext(state);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  if (mode === 'choose') {
    return (
      <section className="onboarding" data-testid="onboarding">
        <h1>Welcome</h1>
        <p>The tutor builds a model of your strengths and weaknesses and picks every exercise for a reason it shows you. Start in one of three ways:</p>
        <div className="cards3">
          <div className="pane">
            <h2>Placement test</h2>
            <p>{PLACEMENT_ITEMS} adaptive puzzles, about 10 minutes. Each puzzle is chosen at your current estimated level.</p>
            <button
              className="primary"
              data-testid="start-placement"
              disabled={loading}
              onClick={async () => {
                setLoading(true);
                await getTactics().ensure?.(1200);
                await getTactics().ensure?.(1800);
                await getTactics().ensure?.(700);
                setLoading(false);
                setMode('placement');
              }}
            >
              {loading ? 'Loading puzzles…' : 'Take the placement test'}
            </button>
          </div>
          <div className="pane">
            <h2>Import your games</h2>
            <p>Lichess or Chess.com username, or a PGN file. Your mistakes are analysed on this device.</p>
            <button onClick={() => go('review')} data-testid="onboard-import">
              Import games
            </button>
          </div>
          <div className="pane">
            <h2>Just start</h2>
            <p>Begin at a default level (1200) with wide uncertainty; the model adapts quickly.</p>
            <button
              data-testid="skip-onboarding"
              onClick={() => {
                seed(1200, 350);
                onDone();
              }}
            >
              Start training
            </button>
          </div>
        </div>
      </section>
    );
  }

  if (mode === 'result') {
    const [lo, hi] = placementRange(state);
    return (
      <section className="onboarding" data-testid="placement-result">
        <h1>Placement result</h1>
        <p>
          Estimated puzzle rating: <strong data-testid="placement-rating">{Math.round(state.theta)}</strong> (likely range {lo}–{hi}, based on {state.asked.length} puzzles; solved{' '}
          {state.asked.filter((a) => a.solved).length}).
        </p>
        <p>This is a starting point. Every exercise you do refines the estimate, concept by concept.</p>
        <button
          className="primary"
          data-testid="placement-continue"
          onClick={() => {
            seed(state.theta, Math.max(state.sigma, 90));
            onDone();
          }}
        >
          Go to dashboard
        </button>
      </section>
    );
  }

  if (err) return <p role="alert">{err}</p>;
  if (!item) return <p className="loading">Choosing a puzzle…</p>;
  const ex = buildSolve(item);
  return (
    <section data-testid="placement">
      <h1>
        Placement test: puzzle {state.asked.length + 1} of {PLACEMENT_ITEMS}
      </h1>
      <ExerciseView
        exercise={ex}
        settings={{ ...settings, askConfidence: false, hintLevel: 0, explanationStyle: 'concise' }}
        why={`Chosen at your current estimate (${Math.round(state.theta)} ± ${Math.round(state.sigma)}).`}
        onDone={(r) => {
          const s = recordPlacement(state, item, r.solved);
          setState(s);
          recordStandalone(ex, r);
        }}
        onNext={() => {
          if (placementDone(state)) setMode('result');
          else pickNext(state);
        }}
        nextLabel={placementDone(state) ? 'See result' : 'Next puzzle'}
      />
    </section>
  );
}
