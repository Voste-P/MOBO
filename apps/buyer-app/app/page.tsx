'use client';

import React from 'react';
import { AuthProvider } from '../../../shared/context/AuthContext';
import { ConsumerApp } from '../../../shared/apps/ConsumerApp';

export default function Page() {
  return (
    <AuthProvider>
      <ConsumerApp />
    </AuthProvider>
  );
}

