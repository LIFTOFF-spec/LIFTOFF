import type { Metadata } from "next";
import { LaunchStatusView } from "@/components/create/launch-status";
import { PageContainer } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "Launch status" };

export default async function LaunchPage({ params }: PageProps<"/launch/[id]">) {
  const { id } = await params;
  return (
    <PageContainer className="max-w-3xl">
      <p className="mb-4 text-xs font-semibold uppercase tracking-[0.14em] text-text-subtle">
        Launch status
      </p>
      <LaunchStatusView id={id} />
    </PageContainer>
  );
}
