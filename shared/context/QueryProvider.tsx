'use client';

import React, { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Singleton QueryClient shared across the entire app.
 * - staleTime: 30s — data considered fresh for 30s (no refetch)
 * - gcTime: 5min — unused cache garbage-collected after 5 minutes
 * - refetchOnWindowFocus: false — prevents unnecessary refetches on tab switch
 * - retry: 1 — single retry on failure (api.ts already has retry logic)
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      refetchOnMount: false,
      retry: 1,
    },
  },
});

/** Invalidate all queries matching a given key prefix */
export function invalidateQueries(keyPrefix: string[]) {
  queryClient.invalidateQueries({ queryKey: keyPrefix });
}

/** Get the singleton QueryClient (for imperative usage outside React) */
export function getQueryClient() {
  return queryClient;
}

export const QueryProvider: React.FC<{ children: ReactNode }> = ({ children }) => (
  <QueryClientProvider client={queryClient}>
    {children}
  </QueryClientProvider>
);
