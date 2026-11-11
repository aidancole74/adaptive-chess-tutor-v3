import { useState, type ReactElement } from 'react';
import { useApp } from '../store';
import { ExerciseView } from '../ExerciseView';
import { conceptName } from '../../curriculum/concepts';
import type { Exercise } from '../../exercises/types';

export function Train({ practice, clearPractice }: { practice: Exercise[] | null; clearPractice(): void }): ReactElement {
  const { session, current, log, notices, settings, startSession, submit, next, endSession, tagCause, recordStandalone } = useApp();
  const [starting, setStarting] = useState(false);
  const [pIndex, setPIndex] = useState(0);

  if (practice && practice.length > 0) {
    const ex = practice[pIndex];
    if (!ex) {
      return (
        <section>
          <h1>Mistake practice complete</h1>
          <button className="primary" onClick={() => { clearPractice(); setPIndex(0); }}>Back</button>
        </section>
      );
    }
    return (
      <section>
        <h1>Practising your mistakes ({pIndex + 1} of {practice.length})</h1>
        <ExerciseView
          exercise={ex}
          settings={settings}
          why="From your own game: this position cost you at least 1.5 pawns of evaluation."
          onDone={(r) => recordStandalone(ex, r)}
          onNext={() => setPIndex((i) => i + 1)}
        />
      </section>
    );
  }

  if (!session) {
    return (
      <section className="train-start">
        <h1>Training session</h1>
        <p>
          {settings.sessionMinutes} minutes · target success {Math.round(settings.bandLow * 100)}–{Math.round(settings.bandHigh * 100)}% · mix {settings.mixWeakness}% weaknesses / {settings.mixReview}% review /{' '}
          {settings.mixExplore}% strengths and exploration
        </p>
        <button
          className="primary big"
          data-testid="start-session"
          disabled={starting}
          onClick={async () => {
            setStarting(true);
            try {
              await startSession();
            } finally {
              setStarting(false);
            }
          }}
        >
          {starting ? 'Preparing…' : 'Start session'}
        </button>
      </section>
    );
  }

  const total = session.slots.length;
  if (!current) {
    const solved = log.filter((l) => l.result.solved).length;
    const stages = log.map((l) => l.stageChange).filter(Boolean);
    return (
      <section className="summary" data-testid="session-summary">
        <h1>Session complete</h1>
        {notices.map((n, i) => (
          <p key={i} className="notice">{n}</p>
        ))}
        <p data-testid="summary-score">
          Solved {solved} of {log.length}. Concepts practised: {new Set(log.map((l) => l.exercise.conceptId)).size}; formats: {new Set(log.map((l) => l.exercise.format)).size}.
        </p>
        {stages.length > 0 && (
          <ul>
            {stages.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        )}
        <table className="log">
          <thead>
            <tr>
              <th>#</th>
              <th>Concept</th>
              <th>Format</th>
              <th>Result</th>
              <th>Why it was chosen</th>
            </tr>
          </thead>
          <tbody>
            {log.map((l, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                <td>{conceptName(l.exercise.conceptId)}</td>
                <td>{l.exercise.format}</td>
                <td>{l.result.solved ? '✓' : '✗'}</td>
                <td>{l.why}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <button className="primary" data-testid="end-session" onClick={endSession}>
          Done
        </button>
      </section>
    );
  }

  const slot = current.pick.slot;
  return (
    <section className="train">
      {notices.length > 0 && session.done.length === 0 && notices.map((n, i) => <p key={i} className="notice">{n}</p>)}
      <div className="progress" aria-label={`Exercise ${session.done.length + 1} of ${total}`}>
        <span data-testid="session-progress">
          {Math.min(session.done.length + 1, total)} / {total}
        </span>
        <span className="slot">{slot.kind === 'warmup' ? 'Warm-up' : slot.kind === 'cooldown' ? 'Cool-down' : slot.kind === 'challenge' ? 'Challenge' : 'Core'}</span>
        <progress max={total} value={session.done.length} />
      </div>
      <ExerciseView
        exercise={current.exercise}
        settings={settings}
        why={current.pick.why}
        onDone={submit}
        onNext={(cause) => {
          if (cause) tagCause(current.exercise.id, cause);
          next();
        }}
        nextLabel={session.done.length >= total ? 'Finish' : 'Next'}
      />
    </section>
  );
}
