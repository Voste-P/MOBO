'use client';

import React from 'react';
import { QueryProvider } from '../../../shared/context/QueryProvider';
import { AuthProvider } from '../../../shared/context/AuthContext';
import { ConsumerApp } from '../../../shared/apps/ConsumerApp';

export default function Page() {
  return (
    <QueryProvider>
      <AuthProvider>
        <ConsumerApp />
      </AuthProvider>
    </QueryProvider>
  );
}

