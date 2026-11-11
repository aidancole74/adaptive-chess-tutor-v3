import { lazy, Suspense, useEffect, useState, type ReactElement } from 'react';
import { useApp } from './store';
import { Train } from './screens/Train';
import { Dashboard } from './screens/Dashboard';
import { Onboarding } from './screens/Onboarding';
import type { Exercise } from '../exercises/types';

const SettingsScreen = lazy(() => import('./screens/Settings'));
const DataScreen = lazy(() => import('./screens/Data'));
const CurriculumScreen = lazy(() => import('./screens/Curriculum'));
const EvidenceScreen = lazy(() => import('./screens/Evidence'));
const ReviewScreen = lazy(() => import('./screens/ReviewHost'));
const RepertoireScreen = lazy(() => import('./screens/RepertoireHost'));
const EndgameScreen = lazy(() => import('./screens/EndgameHost'));

export type Route = 'home' | 'train' | 'onboarding' | 'review' | 'repertoire' | 'endgames' | 'curriculum' | 'settings' | 'evidence' | 'data';
const NAV: [Route, string][] = [
  ['home', 'Dashboard'],
  ['train', 'Train'],
  ['review', 'Game review'],
  ['repertoire', 'Repertoire'],
  ['endgames', 'Endgames'],
  ['curriculum', 'Curriculum'],
  ['evidence', 'Evidence'],
  ['settings', 'Settings'],
  ['data', 'Data'],
];

function readRoute(): Route {
  const h = window.location.hash.replace(/^#\/?/, '') as Route;
  return NAV.some(([r]) => r === h) || h === 'onboarding' ? h : 'home';
}

export function App(): ReactElement {
  const { ready, init, learner, settings } = useApp();
  const [route, setRoute] = useState<Route>(readRoute);
  const [practice, setPractice] = useState<Exercise[] | null>(null);

  useEffect(() => {
    void init();
    const on = (): void => setRoute(readRoute());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, [init]);

  const go = (r: Route): void => {
    window.location.hash = `/${r}`;
    setRoute(r);
  };

  useEffect(() => {
    document.documentElement.dataset.theme = settings.boardTheme;
  }, [settings.boardTheme]);

  const fresh = learner.history.length === 0 && !learner.seeded;
  // A fresh profile lands on onboarding; the route then stays put while the placement test records results.
  useEffect(() => {
    if (ready && fresh && route === 'home') go('onboarding');
  }, [ready, fresh, route]);

  if (!ready) return <p className="loading">Loading…</p>;
  const shown: Route = route;

  return (
    <div className="app">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="top">
        <span className="brand">Adaptive Chess Tutor</span>
        <nav aria-label="Main">
          {NAV.map(([r, label]) => (
            <a key={r} href={`#/${r}`} aria-current={shown === r ? 'page' : undefined} data-testid={`nav-${r}`}>
              {label}
            </a>
          ))}
        </nav>
      </header>
      <main id="main">
        <Suspense fallback={<p className="loading">Loading…</p>}>
          {shown === 'onboarding' && <Onboarding onDone={() => go('home')} go={go} />}
          {shown === 'home' && <Dashboard go={go} />}
          {shown === 'train' && <Train practice={practice} clearPractice={() => setPractice(null)} />}
          {shown === 'review' && (
            <ReviewScreen
              onPractise={(ex) => {
                setPractice(ex);
                go('train');
              }}
            />
          )}
          {shown === 'repertoire' && <RepertoireScreen />}
          {shown === 'endgames' && <EndgameScreen />}
          {shown === 'curriculum' && <CurriculumScreen />}
          {shown === 'evidence' && <EvidenceScreen />}
          {shown === 'settings' && <SettingsScreen />}
          {shown === 'data' && <DataScreen />}
        </Suspense>
      </main>
      <footer className="foot">All data stays on this device. No accounts, no tracking.</footer>
    </div>
  );
}
