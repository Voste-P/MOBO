'use client';

import React, { Suspense } from 'react';
import { AuthProvider } from '../../../shared/context/AuthContext';
import { ToastProvider } from '../../../shared/context/ToastContext';
import { ErrorBoundary } from '../../../shared/components/ErrorBoundary';
import { PageSkeleton } from '../../../shared/components/ui/PageSkeleton';
import { lazyRetry } from '../../../shared/utils/lazyRetry';

const AdminPortal = lazyRetry(() =>
  import('../../../shared/pages/AdminPortal').then((m) => ({ default: m.AdminPortal })),
);

export default function Page() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <ToastProvider>
          <Suspense fallback={<PageSkeleton variant="dashboard" />}>
            <AdminPortal onBack={() => {}} />
          </Suspense>
        </ToastProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}

