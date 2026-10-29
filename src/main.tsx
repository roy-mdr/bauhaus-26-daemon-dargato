import { createRoot } from 'react-dom/client';
import { lazy, Suspense } from 'react';
import './styles.css';

const DisplayApp = lazy(() => import('./display/DisplayApp'));
const PhoneApp = lazy(() => import('./phone/PhoneApp'));
const DirectorApp = lazy(() => import('./director/DirectorApp'));
const DebugApp = lazy(() => import('./debug/DebugApp'));
const TutorialPage = lazy(() => import('./display/Tutorial'));

function Router() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  if (path.startsWith('/join')) {
    document.body.classList.add('phone-body');
    return <PhoneApp />;
  }
  if (path.startsWith('/director')) {
    document.body.classList.add('panel-body');
    return <DirectorApp />;
  }
  if (path.startsWith('/debug')) {
    document.body.classList.add('panel-body');
    return <DebugApp />;
  }
  document.body.classList.add('display-body');
  if (path.startsWith('/tutorial')) return <TutorialPage />;
  return <DisplayApp />;
}

createRoot(document.getElementById('root')!).render(
  <Suspense fallback={<div className="loading">DARGATO</div>}>
    <Router />
  </Suspense>,
);
