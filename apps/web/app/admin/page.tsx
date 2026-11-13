import type { Metadata } from "next";
import { AppealsPanel } from "@/components/admin/appeals-panel";
import { PageContainer } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "Admin · Appeals", robots: { index: false } };

export default function AdminPage() {
  return (
    <PageContainer className="flex max-w-4xl flex-col gap-6">
      <header>
        <h1 className="display text-3xl sm:text-4xl">Anti-copycat appeals.</h1>
        <p className="mt-2 text-sm text-text-muted">
          High-risk launches are blocked automatically. Approving an appeal unlocks that exact
          launch input once. Every decision is written to the audit log.
        </p>
      </header>
      <AppealsPanel />
    </PageContainer>
  );
}
