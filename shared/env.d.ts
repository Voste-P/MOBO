/** Minimal process.env typing for client-side code (Next.js injects NODE_ENV at build time). */
declare namespace NodeJS {
  interface ProcessEnv {
    NODE_ENV: 'development' | 'production' | 'test';
    [key: string]: string | undefined;
  }
}
declare const process: { env: NodeJS.ProcessEnv };
