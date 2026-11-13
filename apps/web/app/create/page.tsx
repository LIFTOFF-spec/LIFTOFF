import type { Metadata } from "next";
import { CreateWizard } from "@/components/create/create-wizard";
import { PageContainer } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "Create Token" };

export default function CreatePage() {
  return (
    <PageContainer className="max-w-3xl">
      <h1 className="display text-[2rem] sm:text-5xl">Create token.</h1>
      <p className="mt-3 mb-8 text-text-muted">
        Three steps. You pay only the on-chain launch cost (shown before you confirm, refunded if
        the launch fails), there is no dev buy in the creation transaction, and every launch is
        checked against existing tokens before it goes live.
      </p>
      <CreateWizard />
    </PageContainer>
  );
}
