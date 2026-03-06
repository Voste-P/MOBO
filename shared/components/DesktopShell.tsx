import React from 'react';

type DesktopShellProps = {
  isSidebarOpen: boolean;
  onSidebarOpenChange: (open: boolean) => void;
  sidebar: React.ReactNode;
  children: React.ReactNode;

  /** Optional mobile header (shown below md breakpoint). */
  showMobileHeader?: boolean;
  mobileHeader?: React.ReactNode;
  mobileMenuButton?: React.ReactNode;

  containerClassName?: string;
  overlayClassName?: string;
  sidebarWidthClassName?: string;
  asideClassName?: string;
  mainClassName?: string;
};

export function DesktopShell({
  isSidebarOpen,
  onSidebarOpenChange,
  sidebar,
  children,
  showMobileHeader = true,
  mobileHeader,
  mobileMenuButton,
  containerClassName,
  overlayClassName,
  sidebarWidthClassName = 'w-72',
  asideClassName,
  mainClassName,
}: DesktopShellProps) {
  return (
    <div className={containerClassName || 'flex h-[100dvh] min-h-0 overflow-hidden relative'}>
      {/* Sidebar Overlay */}
      {isSidebarOpen && (
        <div
          className={overlayClassName || 'fixed inset-0 bg-black/50 z-40 md:hidden'}
          onClick={() => onSidebarOpenChange(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={
          `fixed md:relative z-50 h-full ${sidebarWidthClassName} transition-transform duration-300 overflow-y-auto scrollbar-styled ` +
          `${isSidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'} ` +
          (asideClassName || '')
        }
      >
        {sidebar}
      </aside>

      {/* Main */}
      <main className={mainClassName || 'flex-1 min-w-0 min-h-0 overflow-y-auto scrollbar-styled'}>
        {showMobileHeader ? (
          <div className="md:hidden flex items-center justify-between mb-6">
            <div className="min-w-0">{mobileHeader}</div>
            <div
              className="shrink-0"
              onClick={() => {
                // Allow consumers to pass a custom button; otherwise open sidebar on container click.
                if (!mobileMenuButton) onSidebarOpenChange(true);
              }}
            >
              {mobileMenuButton}
            </div>
          </div>
        ) : null}

        {children}
      </main>
    </div>
  );
}
