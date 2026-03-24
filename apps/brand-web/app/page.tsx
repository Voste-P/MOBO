'use client';

import React from 'react';
import { AuthProvider } from '../../../shared/context/AuthContext';
import { BrandApp } from '../../../shared/apps/BrandApp';

export default function Page() {
  return (
    <AuthProvider>
      <BrandApp />
    </AuthProvider>
  );
}

