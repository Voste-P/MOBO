'use client';

import React from 'react';
import { QueryProvider } from '../../../shared/context/QueryProvider';
import { AuthProvider } from '../../../shared/context/AuthContext';
import { BrandApp } from '../../../shared/apps/BrandApp';

export default function Page() {
  return (
    <QueryProvider>
      <AuthProvider>
        <BrandApp />
      </AuthProvider>
    </QueryProvider>
  );
}

