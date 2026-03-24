'use client';

import React from 'react';
import { AuthProvider } from '../../../shared/context/AuthContext';
import { AgencyApp } from '../../../shared/apps/AgencyApp';

export default function Page() {
  return (
    <AuthProvider>
      <AgencyApp />
    </AuthProvider>
  );
}

