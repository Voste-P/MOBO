import React, { Suspense } from 'react';
import { useAuth } from '../context/AuthContext';
import { NotificationProvider } from '../context/NotificationContext';
import { ToastProvider } from '../context/ToastContext';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { PortalGuard } from '../components/PortalGuard';
import { PageSkeleton } from '../components/ui/PageSkeleton';
import { BrandAuthScreen } from '../pages/BrandAuth';
import { lazyRetry } from '../utils/lazyRetry';

const BrandDashboard = lazyRetry(() => import('../pages/BrandDashboard').then(m => ({ default: m.BrandDashboard })));

interface BrandAppProps {
  onBack?: () => void;
}

export const BrandApp: React.FC<BrandAppProps> = ({ onBack }) => {
  const { user, logout } = useAuth();

  if (!user) {
    return <BrandAuthScreen onBack={onBack} />;
  }

  // Ensure only Brands can access
  if (user.role !== 'brand') {
    return (
      <PortalGuard
        actualRole={user.role}
        expectedRoleLabel="Brand Portal"
        onLogout={logout}
        onBack={onBack}
        title="Access Restricted"
      />
    );
  }

  return (
    <ErrorBoundary>
      <ToastProvider>
        <NotificationProvider>
          <div className="relative min-h-[100dvh] flex flex-col">
            <Suspense fallback={<PageSkeleton variant="dashboard" />}>
              <BrandDashboard />
            </Suspense>
          </div>
        </NotificationProvider>
      </ToastProvider>
    </ErrorBoundary>
  );
};

