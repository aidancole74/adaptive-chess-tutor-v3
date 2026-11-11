import { useEffect, useState, type ReactElement } from 'react';
import { useApp } from '../store';
import { buildExport, getDb, parseImport } from '../../model/db';
import { downloadPack, loadManifest, packBytes } from '../../content/loader';
import type { PackManifest } from '../../content/types';

export default function Data(): ReactElement {
  const { learner, settings, replaceAll, reset } = useApp();
  const [msg, setMsg] = useState('');
  const [manifest, setManifest] = useState<PackManifest | null>(null);
  const [progress, setProgress] = useState<Record<string, string>>({});

  useEffect(() => {
    void loadManifest().then(setManifest);
  }, []);

  const exportJson = async (): Promise<void> => {
    const games = await getDb().games.toArray().catch(() => []);
    const repertoire = await getDb().kv.get('repertoire').catch(() => undefined);
    const file = buildExport(learner, settings, games, repertoire?.value);
    const blob = new Blob([JSON.stringify(file)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `chess-tutor-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    setMsg(`Exported ${learner.history.length} attempts and ${games.length} games.`);
  };

  return (
    <section className="data" data-testid="data">
      <h1>Your data</h1>
      <p>Everything is stored in this browser (IndexedDB). Nothing is sent anywhere unless you import games or use an optional online feature.</p>
      <div className="row">
        <button className="primary" data-testid="export" onClick={() => void exportJson()}>
          Export JSON
        </button>
        <label className="button">
          Import JSON
          <input
            type="file"
            accept="application/json"
            data-testid="import-file"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              const parsed = parseImport(await f.text());
              if (!parsed.ok) return setMsg(parsed.error);
              replaceAll(parsed.data.learner, { ...parsed.data.settings, explorerToken: settings.explorerToken, anthropicKey: settings.anthropicKey });
              if (parsed.data.games.length) await getDb().games.bulkPut(parsed.data.games).catch(() => undefined);
              if (parsed.data.repertoire) await getDb().kv.put({ key: 'repertoire', value: parsed.data.repertoire }).catch(() => undefined);
              setMsg(`Imported ${parsed.data.learner.history.length} attempts.`);
            }}
          />
        </label>
        <button
          className="danger"
          onClick={async () => {
            if (!window.confirm('Delete all training data on this device? This cannot be undone. Export first if you want a backup.')) return;
            reset();
            await getDb().games.clear().catch(() => undefined);
            setMsg('All local training data deleted.');
          }}
        >
          Delete all data
        </button>
      </div>
      {msg && (
        <p role="status" data-testid="data-msg">
          {msg}
        </p>
      )}

      <h2>Content packs (for offline use)</h2>
      {!manifest ? (
        <p className="muted">No pack manifest found.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Pack</th>
              <th>Items</th>
              <th>Size</th>
              <th>Version</th>
              <th>Licence</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {manifest.packs.map((p) => (
              <tr key={p.id}>
                <td>{p.id}</td>
                <td>{p.count.toLocaleString('en')}</td>
                <td>{(packBytes(p) / 1e6).toFixed(1)} MB</td>
                <td>{p.version}</td>
                <td>{p.license}</td>
                <td>
                  <button
                    onClick={async () => {
                      setProgress((s) => ({ ...s, [p.id]: '0%' }));
                      const r = await downloadPack(p, (d, t) => setProgress((s) => ({ ...s, [p.id]: `${Math.round((100 * d) / t)}%` })));
                      setProgress((s) => ({ ...s, [p.id]: r.ok ? 'available offline' : (r.reason ?? 'failed') }));
                    }}
                  >
                    Download
                  </button>{' '}
                  {progress[p.id]}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
