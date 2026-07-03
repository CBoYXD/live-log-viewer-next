"use client";

/**
 * TODO(codex): app shell — sidebar (list/tree) on the left, header bar +
 * log feed on the right. State that lives here: selected FileEntry,
 * tree/flat mode, search query. See ARCHITECTURE.md.
 */
export function Viewer() {
  return (
    <div className="flex h-full">
      <aside className="flex w-[340px] min-w-[270px] flex-col border-r border-line bg-panel">
        {/* TODO(codex): <Sidebar /> */}
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        {/* TODO(codex): header bar + <LogFeed /> */}
        <div className="mt-[20vh] text-center text-dim">
          Вибери лог зліва — стрічка оновлюється сама
        </div>
      </main>
    </div>
  );
}
