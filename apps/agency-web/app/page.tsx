'use client';

import React from 'react';
import { QueryProvider } from '../../../shared/context/QueryProvider';
import { AuthProvider } from '../../../shared/context/AuthContext';
import { AgencyApp } from '../../../shared/apps/AgencyApp';

export default function Page() {
  return (
    <QueryProvider>
      <AuthProvider>
        <AgencyApp />
      </AuthProvider>
    </QueryProvider>
  );
}

