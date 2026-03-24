'use client';

import React from 'react';
import { QueryProvider } from '../../../shared/context/QueryProvider';
import { AuthProvider } from '../../../shared/context/AuthContext';
import { MediatorApp } from '../../../shared/apps/MediatorApp';

export default function Page() {
  return (
    <QueryProvider>
      <AuthProvider>
        <MediatorApp />
      </AuthProvider>
    </QueryProvider>
  );
}

