'use client';

import React, { lazy, Suspense } from 'react';
import { AuthProvider } from '../../../shared/context/AuthContext';
import { ToastProvider } from '../../../shared/context/ToastContext';
import { ErrorBoundary } from '../../../shared/components/ErrorBoundary';
import { PageSkeleton } from '../../../shared/components/ui/PageSkeleton';

// Lazy-load the 98KB AdminPortal — only fetched after initial render
const AdminPortal = lazy(() => import('../../../shared/pages/AdminPortal').then(m => ({ default: m.AdminPortal })));

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

