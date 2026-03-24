'use client';

import React from 'react';
import { AuthProvider } from '../../../shared/context/AuthContext';
import { MediatorApp } from '../../../shared/apps/MediatorApp';

export default function Page() {
  return (
    <AuthProvider>
      <MediatorApp />
    </AuthProvider>
  );
}

