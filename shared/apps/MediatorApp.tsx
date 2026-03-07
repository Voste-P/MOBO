import React, { lazy, Suspense } from 'react';
import { useAuth } from '../context/AuthContext';
import { NotificationProvider } from '../context/NotificationContext';
import { ToastProvider } from '../context/ToastContext';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { PortalGuard } from '../components/PortalGuard';
import { PageSkeleton } from '../components/ui/PageSkeleton';
import { MediatorAuthScreen } from '../pages/MediatorAuth';

// Lazy-load the 125KB MediatorDashboard — only fetched after auth succeeds
const MediatorDashboard = lazy(() => import('../pages/MediatorDashboard').then(m => ({ default: m.MediatorDashboard })));

interface MediatorAppProps {
  onBack?: () => void;
}

export const MediatorApp: React.FC<MediatorAppProps> = ({ onBack }) => {
  const { user, logout } = useAuth();

  if (!user) {
    return <MediatorAuthScreen onBack={onBack} />;
  }

  // Ensure only Mediators access
  if (user.role !== 'mediator') {
    return (
      <PortalGuard
        actualRole={user.role}
        expectedRoleLabel="Mediator App"
        onLogout={logout}
        onBack={onBack}
        title="Access Denied"
      />
    );
  }

  return (
    <ErrorBoundary>
      <ToastProvider>
        <NotificationProvider>
          <div className="relative min-h-[100dvh] flex flex-col">
            <Suspense fallback={<PageSkeleton variant="dashboard" />}>
              <MediatorDashboard />
            </Suspense>
          </div>
        </NotificationProvider>
      </ToastProvider>
    </ErrorBoundary>
  );
};

