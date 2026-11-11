import type { ReactElement } from 'react';
import { useApp } from '../store';
import { PRESETS, applyPreset, type Settings as S } from '../../model/settings';
import { DOMAINS } from '../../content/types';
import { THEMES } from '../Board';

export default function Settings(): ReactElement {
  const { settings, updateSettings, replaceAll, learner } = useApp();
  const set = (patch: Partial<S>): void => updateSettings({ ...patch, preset: 'custom' });
  const num = (v: string): number => Number(v);
  return (
    <section className="settings" data-testid="settings">
      <h1>Settings</h1>
      <h2>Presets</h2>
      <div className="presets" role="radiogroup" aria-label="Preset">
        {Object.entries(PRESETS).map(([id, p]) => (
          <button key={id} role="radio" aria-checked={settings.preset === id} className={settings.preset === id ? 'selected' : ''} data-testid={`preset-${id}`} onClick={() => replaceAll(learner, applyPreset(settings, id))}>
            <strong>{p.label}</strong>
            <span>{p.description}</span>
          </button>
        ))}
      </div>

      <h2>Sessions</h2>
      <label>
        Session length
        <select data-testid="set-session" value={settings.sessionMinutes} onChange={(e) => set({ sessionMinutes: num(e.target.value) as S['sessionMinutes'] })}>
          {[5, 10, 20, 40].map((m) => (
            <option key={m} value={m}>{m} minutes</option>
          ))}
        </select>
      </label>
      <label>
        Weekly target (minutes)
        <input type="number" min={0} max={2000} value={settings.weeklyTargetMinutes} onChange={(e) => set({ weeklyTargetMinutes: num(e.target.value) })} />
      </label>
      <label>
        New concepts per session: {settings.newConceptRate}
        <input type="range" min={0} max={3} step={1} value={settings.newConceptRate} onChange={(e) => set({ newConceptRate: num(e.target.value) })} />
      </label>
      <label>
        Challenge band: {Math.round(settings.bandLow * 100)}–{Math.round(settings.bandHigh * 100)}% predicted success
        <span className="row">
          <input aria-label="Band low" data-testid="set-band-low" type="range" min={0.6} max={0.88} step={0.01} value={settings.bandLow} onChange={(e) => set({ bandLow: num(e.target.value) })} />
          <input aria-label="Band high" data-testid="set-band-high" type="range" min={0.62} max={0.9} step={0.01} value={settings.bandHigh} onChange={(e) => set({ bandHigh: num(e.target.value) })} />
        </span>
      </label>
      <fieldset>
        <legend>Focus mix (weakness / review / strengths & exploration)</legend>
        {(['mixWeakness', 'mixReview', 'mixExplore'] as const).map((k) => (
          <label key={k}>
            {k === 'mixWeakness' ? 'Weaknesses' : k === 'mixReview' ? 'Review' : 'Strengths & exploration'}: {settings[k]}
            <input type="range" min={0} max={100} value={settings[k]} onChange={(e) => set({ [k]: num(e.target.value) } as Partial<S>)} />
          </label>
        ))}
      </fieldset>
      <label>
        Variety strength: {settings.varietyStrength.toFixed(1)}
        <input type="range" min={0} max={2} step={0.1} value={settings.varietyStrength} onChange={(e) => set({ varietyStrength: num(e.target.value) })} />
      </label>
      <label>
        Retention target: {Math.round(settings.retention * 100)}%
        <input type="range" min={0.8} max={0.95} step={0.01} value={settings.retention} onChange={(e) => set({ retention: num(e.target.value) })} />
      </label>

      <h2>Domains</h2>
      <table className="domains">
        <tbody>
          {DOMAINS.map((d) => (
            <tr key={d}>
              <td>
                <label>
                  <input type="checkbox" data-testid={`domain-${d}`} checked={settings.domainEnabled[d]} onChange={(e) => set({ domainEnabled: { ...settings.domainEnabled, [d]: e.target.checked } })} /> {d}
                </label>
              </td>
              <td>
                <input aria-label={`${d} weight`} type="range" min={0} max={1} step={0.05} value={settings.domainWeight[d]} onChange={(e) => set({ domainWeight: { ...settings.domainWeight, [d]: num(e.target.value) } })} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Explanations and hints</h2>
      <label>
        Depth: {settings.depth < 0.34 ? 'practical' : settings.depth < 0.67 ? 'balanced' : 'theoretical'}
        <input type="range" min={0} max={1} step={0.05} value={settings.depth} onChange={(e) => set({ depth: num(e.target.value) })} />
      </label>
      <label>
        Explanation style
        <select data-testid="set-style" value={settings.explanationStyle} onChange={(e) => set({ explanationStyle: e.target.value as S['explanationStyle'] })}>
          <option value="concise">Concise</option>
          <option value="detailed">Detailed</option>
          <option value="socratic">Socratic (question first)</option>
        </select>
      </label>
      <label>
        Hints
        <select value={settings.hintLevel} onChange={(e) => set({ hintLevel: num(e.target.value) as S['hintLevel'] })}>
          <option value={0}>None</option>
          <option value={1}>Highlight the piece</option>
          <option value={2}>Up to the full first move</option>
        </select>
      </label>
      <label>
        <input type="checkbox" data-testid="set-confidence" checked={settings.askConfidence} onChange={(e) => set({ askConfidence: e.target.checked })} /> Ask my confidence (1–5) before each exercise
      </label>

      <h2>Games, openings and sparring</h2>
      <label>
        Time-control filter
        <select value={settings.timeControl} onChange={(e) => set({ timeControl: e.target.value as S['timeControl'] })}>
          {['all', 'bullet', 'blitz', 'rapid', 'classical'].map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </label>
      <label>
        Opening training colour
        <select value={settings.openingColor} onChange={(e) => set({ openingColor: e.target.value as S['openingColor'] })}>
          <option value="both">Both</option>
          <option value="white">White</option>
          <option value="black">Black</option>
        </select>
      </label>
      <label>
        Sparring strength relative to you: {settings.sparringOffset > 0 ? '+' : ''}
        {settings.sparringOffset}
        <input type="range" min={-600} max={400} step={50} value={settings.sparringOffset} onChange={(e) => set({ sparringOffset: num(e.target.value) })} />
      </label>
      <label>
        Goal rating
        <input type="number" data-testid="set-goal" min={400} max={3000} value={settings.goalRating ?? ''} onChange={(e) => set({ goalRating: e.target.value ? num(e.target.value) : null })} />
      </label>
      <label>
        Goal date
        <input type="date" value={settings.goalDate ?? ''} onChange={(e) => set({ goalDate: e.target.value || null })} />
      </label>

      <h2>Display</h2>
      <label>
        <input type="checkbox" checked={settings.showEval} onChange={(e) => set({ showEval: e.target.checked })} /> Show engine evaluation after exercises
      </label>
      <label>
        Notation
        <select value={settings.notation} onChange={(e) => set({ notation: e.target.value as S['notation'] })}>
          <option value="san">Algebraic (Nf3)</option>
          <option value="figurine">Figurine</option>
          <option value="uci">Coordinates (g1f3)</option>
        </select>
      </label>
      <label>
        Board theme
        <select data-testid="set-theme" value={settings.boardTheme} onChange={(e) => set({ boardTheme: e.target.value as S['boardTheme'] })}>
          {Object.entries(THEMES).map(([k, t]) => (
            <option key={k} value={k}>{t.label}</option>
          ))}
        </select>
      </label>

      <h2>Optional online features</h2>
      <label>
        Lichess opening-explorer token (optional; the local book is used otherwise). Stored only on this device and never exported.
        <input type="password" autoComplete="off" value={settings.explorerToken} onChange={(e) => set({ explorerToken: e.target.value })} />
      </label>
      <label>
        <input type="checkbox" checked={settings.llmExplanations} onChange={(e) => set({ llmExplanations: e.target.checked })} /> Experimental: AI-written explanations (needs your own Anthropic API key; only verified facts are sent)
      </label>
      {settings.llmExplanations && (
        <label>
          Anthropic API key (stored only in this browser, never exported). Requests go directly from your browser to api.anthropic.com and are billed to your key. Any explanation that mentions a move or square not in the verified facts is rejected.
          <input type="password" autoComplete="off" value={settings.anthropicKey} onChange={(e) => set({ anthropicKey: e.target.value.trim() })} data-testid="set-anthropic-key" />
        </label>
      )}
    </section>
  );
}
