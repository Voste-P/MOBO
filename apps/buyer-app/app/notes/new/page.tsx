import Link from 'next/link';
import { FileText, ArrowLeft } from 'lucide-react';

export default function NewNotePage() {
  return (
    <main className="flex min-h-[100dvh] w-full flex-col items-center justify-center p-6 bg-mobo-dark-100">
      <div className="max-w-sm w-full text-center space-y-6">
        <div className="mx-auto w-16 h-16 bg-white rounded-2xl shadow-card flex items-center justify-center border border-zinc-100">
          <FileText size={28} className="text-lime-500" />
        </div>
        <div>
          <h1 className="text-xl font-extrabold text-zinc-900 mb-1">Notes</h1>
          <p className="text-sm text-zinc-500 font-medium leading-relaxed">
            Quick notes for your buyer workflows are coming soon.
          </p>
        </div>
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm font-bold text-lime-600 hover:text-lime-700 transition-colors"
        >
          <ArrowLeft size={14} /> Back to home
        </Link>
      </div>
    </main>
  );
}
